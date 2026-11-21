import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  APPROVALS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MODELS,
  attachmentDedupKey,
  attachmentTextRef,
  costOf,
  formatTokens,
  formatUsd,
  humanizeModelError,
  providerModelKey,
  providerModelOptions,
  resolveContextWindow,
  resolvePricing,
  titleFromPrompt,
  uid,
  usageTotalsOf,
  type ApprovalDecision,
  type ApprovalRequest,
  type ImageAttachment,
  type Message,
  type TaskStatus,
  type TurnEvent,
  type UndoResult,
  type UsageStep,
} from '@olivia/core';
import { runDemoTurn, type TurnHandle } from '../agent';
import { Composer } from '../components/Composer';
import { ApprovalBar, MessageList, UndoToast } from '../components/MessageList';
import { UsagePanel } from '../components/UsagePanel';
import { PreviewDock } from '../components/PreviewDock';
import { ArtifactViewer } from '../components/ArtifactViewer';
import { usePricing } from '../hooks/usePricing';
import { usePopoverExclusive } from '../hooks/usePopoverExclusive';
import { useProviders } from '../hooks/useProviders';
import { Icon, Mark } from '../icons';
import { navigate } from '../router';
import { createTask, createTextCoalescer, useStore, type TextCoalescer } from '../store';
import {
  appendText,
  appendThinking,
  appendToolOutput,
  finishThinking,
  finishTool,
  pushDiff,
  pushTool,
  settle,
} from '../store';

const STATUS_TEXT: Record<TaskStatus, string> = {
  idle: '待开始',
  running: '执行中',
  waiting: '等待确认',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_TONE: Record<TaskStatus, string> = {
  idle: 'text-light-inkMuted dark:text-dark-inkMuted bg-black/[0.05] dark:bg-white/[0.07]',
  running: 'text-blue-600 dark:text-blue-400 bg-blue-500/10',
  waiting: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
  done: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
  failed: 'text-red-600 dark:text-red-400 bg-red-500/10',
  stopped: 'text-light-inkMuted dark:text-dark-inkMuted bg-black/[0.05] dark:bg-white/[0.07]',
};

const SUGGESTIONS = [
  {
    icon: 'search',
    title: '读懂一个模块',
    desc: '先建上下文，再讲清它怎么串起来',
    prompt: '先读工作区结构，用三段话讲清楚这个项目是怎么跑起来的。',
  },
  {
    icon: 'file',
    title: '按规格改一个功能',
    desc: '小步改、出 diff、自己跑测试',
    prompt: '把侧栏的任务列表改成按状态分组，并自己跑一遍测试。',
  },
  {
    icon: 'shield',
    title: '评审我的改动',
    desc: '干净上下文，只挑真问题',
    prompt: '评审当前工作区的未提交改动，只报正确性和安全问题，按严重程度排序。',
  },
  {
    icon: 'workflow',
    title: '排一条工作流',
    desc: '拆任务、并行跑、合并前确认',
    prompt: '帮我设计一条每晚跑的重构工作流：拆解、并行、评审、人工确认、提 PR。',
  },
];

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

export function ChatView() {
  const { state, dispatch } = useStore();
  const task = state.tasks.find((item) => item.id === state.activeId) ?? null;
  const pricing = usePricing();
  const { providers } = useProviders();
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [approval, setApproval] = useState<{ turnId: string; request: ApprovalRequest } | null>(null);
  const [undo, setUndo] = useState<UndoResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [preview, setPreview] = useState<{ open: boolean; url: string }>({ open: false, url: '' });
  const [artifact, setArtifact] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 上一次发送失败的输入：留着它，错误条上就能给一个真正的「重试」 */
  const [failure, setFailure] = useState<{ text: string; images: ImageAttachment[] } | null>(null);
  /** 没绑工作区时的待发内容：不清草稿，绑好目录后自动发出 */
  const pendingSendRef = useRef<{ text: string; images: ImageAttachment[] } | null>(null);
  /** 最近一次真正发出去的输入：回合中途失败时，重试按钮才知道要重发什么 */
  const lastSendRef = useRef<{ text: string; images: ImageAttachment[] } | null>(null);
  // 用量抽屉和页头菜单互斥：同时只开一个，避免叠在彼此上面
  usePopoverExclusive(panelOpen, () => setPanelOpen(false));
  usePopoverExclusive(menuOpen, () => setMenuOpen(false));
  const hasPreview = Boolean(window.olivia?.preview);
  const demoRef = useRef<TurnHandle | null>(null);
  const demoCoalescerRef = useRef<TextCoalescer | null>(null);
  const activeRef = useRef<{ turnId: string; messageId: string; coalescer: TextCoalescer } | null>(null);
  /**
   * 流式吸底要「跟随，但不硬拽」：
   * - 用户停在底部时，新内容进来继续贴底；
   * - 用户往上翻阅读时，一帧都不动，直到他主动回到底部。
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const next = distance < 96;
      stickRef.current = next;
      setAtBottom((current) => (current === next ? current : next));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);
  const taskRef = useRef(task);
  taskRef.current = task;

  /** M8：提供商目录 → Composer 模型菜单；没有提供商时保留内置模型回退。 */
  const providerOptions = useMemo(() => providerModelOptions(providers), [providers]);
  /** 有环境变量/旧设置 Key、但还没有任何提供商存 Key 时，继续走旧路径，避免升级后突然不可用。 */
  const providerHasKey = providerOptions.some(
    (option) => providers.find((provider) => provider.id === option.providerId)?.hasKey,
  );
  const preferLegacy = Boolean(state.settings.apiKey.trim()) && !providerHasKey;
  const modelOptions = useMemo(
    () =>
      !preferLegacy && providerOptions.length > 0
        ? providerOptions.map((option) => ({
            value: option.key,
            label: option.label,
            hint: `${option.providerName} · ${option.modelId}`,
          }))
        : MODELS.map((model) => ({
            value: `builtin::${model.id}`,
            label: model.short,
            hint: `${model.label} · 内置/环境变量`,
          })),
    [providerOptions, preferLegacy],
  );
  const desiredProviderId = task?.providerId ?? state.settings.providerId;
  const desiredModelId = task?.model ?? state.settings.model;
  const configuredOption = preferLegacy
    ? undefined
    : providerOptions.find(
        (option) => option.providerId === desiredProviderId && option.modelId === desiredModelId,
      );
  const settingsOption = preferLegacy
    ? undefined
    : providerOptions.find(
        (option) =>
          option.providerId === state.settings.providerId && option.modelId === state.settings.model,
      );
  /**
   * 没有任务/设置指定的模型时，先认「上次用过的模型」再看有没有 Key，
   * 不要无脑挑目录里的第一个——那往往是最贵或最不常用的那个。
   */
  const defaultProviderOption =
    providerOptions.find((option) => option.modelId === state.settings.model) ??
    providerOptions.find(
      (option) => providers.find((provider) => provider.id === option.providerId)?.hasKey,
    ) ??
    providerOptions[0];
  const activeProviderOption =
    !preferLegacy && providerOptions.length
      ? configuredOption ?? settingsOption ?? defaultProviderOption
      : undefined;
  const legacyModelId =
    MODELS.find((model) => model.id === desiredModelId)?.id ??
    (window.olivia?.env?.model && MODELS.some((model) => model.id === window.olivia?.env.model)
      ? window.olivia.env.model
      : MODELS[0]!.id);
  const activeBuiltin = MODELS.find((model) => model.id === legacyModelId) ?? MODELS[0]!;
  const activeModelId = activeProviderOption?.modelId ?? activeBuiltin.id;
  const activeProviderId = activeProviderOption?.providerId;
  const activeProvider = providers.find((provider) => provider.id === activeProviderId);
  const composerModelValue =
    activeProviderOption?.key ??
    (!preferLegacy && providers.length > 0 ? '' : `builtin::${activeBuiltin.id}`);
  const realMode =
    Boolean(window.olivia?.turn) && (providers.length > 0 || Boolean(state.settings.apiKey.trim()));
  const canAttach = Boolean(activeProviderOption?.vision) && Boolean(window.olivia?.attachments) && realMode;
  const attachHint = preferLegacy
    ? '当前使用环境变量/内置密钥；图片输入需要先在提供商模型上打开「支持图片」'
    : !providers.length
      ? '还没有提供商：先到设置 → 模型接入添加'
      : !activeProviderOption
        ? '先在设置里启用一个提供商并选择模型'
        : !activeProviderOption.vision
          ? '当前模型未开启图片输入：到设置 → 模型接入里为它打开「支持图片」'
          : !realMode
            ? '浏览器预览不能保存图片附件'
            : undefined;

  const messages = task?.messages ?? [];
  const usageSteps = task?.usage ?? [];
  /** 选中的模型已不在目录（停用/删除）时，自动落到第一个可用模型并写回任务。 */
  useEffect(() => {
    if (!task || !activeProviderOption || preferLegacy) return;
    if (
      task.providerId === activeProviderOption.providerId &&
      task.model === activeProviderOption.modelId
    ) {
      return;
    }
    dispatch({
      type: 'settings',
      patch: { providerId: activeProviderOption.providerId, model: activeProviderOption.modelId },
    });
    dispatch({
      type: 'patchTask',
      taskId: task.id,
      patch: { providerId: activeProviderOption.providerId, model: activeProviderOption.modelId },
    });
  }, [task?.id, task?.providerId, task?.model, activeProviderOption?.key, preferLegacy, dispatch]);

  const stats = useMemo(() => {
    let steps = 0;
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.kind === 'tool') steps += 1;
      }
    }
    const windowSize =
      activeProviderOption?.contextWindow ??
      resolveContextWindow(activeModelId, pricing.defaultContextWindow, pricing.models);
    const totals = usageTotalsOf(usageSteps, (step) =>
      costOf(step, resolvePricing(step.model ?? activeModelId, pricing.models)),
    ).totals;
    const lastContext = usageSteps[usageSteps.length - 1]?.context;
    // 没有真实用量时退回按字符估算，标 estimated 让界面能区分
    const estimated = usageSteps.length === 0;
    let fallbackChars = 0;
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.kind === 'text') fallbackChars += part.text.length;
        if (part.kind === 'thinking') fallbackChars += part.text.length;
        if (part.kind === 'diff') {
          fallbackChars += (part.diff.hunks ?? []).reduce((sum, hunk) => sum + hunk.lines.length, 0) * 32;
        }
      }
    }
    const used = lastContext?.used ?? Math.round(fallbackChars / 3.4);
    const percent = windowSize > 0 ? Math.min(100, (used / windowSize) * 100) : 0;
    return {
      turns: messages.filter((message) => message.role === 'user').length,
      steps,
      tokens: used,
      tokensLabel: formatTokens(used),
      window: windowSize,
      context: used === 0 ? 0 : percent < 1 ? Number(percent.toFixed(1)) : Math.round(percent),
      cost: totals.costUsd !== undefined ? formatUsd(totals.costUsd) : undefined,
      estimated: estimated || lastContext?.source === 'estimate',
      stepsUsed: totals.steps,
    };
  }, [messages, usageSteps, pricing, activeModelId, activeProviderOption?.contextWindow]);

  const openPreview = useCallback((url: string): void => {
    if (!window.olivia?.preview) return;
    setPreview({ open: true, url });
  }, []);

  const patchMessage = useCallback(
    (messageId: string, patch: (message: Message) => Message) => {
      const current = taskRef.current;
      if (!current) return;
      dispatch({ type: 'patchMessage', taskId: current.id, messageId, patch });
    },
    [dispatch],
  );

  const handleEvent = useCallback(
    (turnId: string, event: TurnEvent) => {
      const active = activeRef.current;
      if (!active || active.turnId !== turnId) return;
      const messageId = active.messageId;
      const current = taskRef.current;

      switch (event.type) {
        case 'text':
          // delta 进合并器攒成整句再上屏（整块淡入）；其余事件先清缓冲再动分片，保住顺序
          active.coalescer.push(event.delta);
          break;
        case 'thinking':
          active.coalescer.flush();
          patchMessage(messageId, (message) => appendThinking(message, event.delta));
          break;
        case 'tool.request':
          active.coalescer.flush();
          patchMessage(messageId, (message) =>
            pushTool(message, {
              id: event.call.callId,
              name: event.call.name,
              detail: event.call.detail,
              status: event.needsApproval ? 'waiting' : 'running',
              risk: event.call.risk,
              args: event.call.args,
            }),
          );
          if (event.needsApproval) setApproval({ turnId, request: event.call });
          break;
        case 'tool.result':
          active.coalescer.flush();
          patchMessage(messageId, (message) =>
            finishTool(message, event.callId, event.status, event.rows, event.artifacts),
          );
          setApproval((value) => (value?.request.callId === event.callId ? null : value));
          break;
        case 'usage': {
          const currentTask = taskRef.current;
          if (currentTask) {
            dispatch({ type: 'appendUsage', taskId: currentTask.id, usage: event.usage });
          }
          break;
        }
        case 'command.output':
          active.coalescer.flush();
          patchMessage(messageId, (message) =>
            appendToolOutput(message, event.callId, event.chunk),
          );
          break;
        case 'file.proposed':
          active.coalescer.flush();
          patchMessage(messageId, (message) =>
            pushDiff(message, {
              file: event.path,
              adds: event.adds,
              dels: event.dels,
              hunks: event.edits.flatMap((edit) => edit.hunks),
              state: 'pending',
              callId: event.callId,
              edits: event.edits,
              queued: event.queued,
            }),
          );
          break;
        case 'file.changed':
          active.coalescer.flush();
          patchMessage(messageId, (message) => {
            const index = message.parts.findIndex(
              (part) => part.kind === 'diff' && event.callId && part.diff.callId === event.callId,
            );
            if (index >= 0) {
              const parts = [...message.parts];
              const current = parts[index];
              if (current && current.kind === 'diff') {
                parts[index] = {
                  kind: 'diff',
                  diff: {
                    ...current.diff,
                    adds: event.adds,
                    dels: event.dels,
                    hunks: event.hunks,
                    state: 'accepted',
                    snapshotId: event.snapshotId,
                  },
                };
              }
              return { ...message, parts };
            }
            return pushDiff(message, {
              file: event.path,
              adds: event.adds,
              dels: event.dels,
              hunks: event.hunks,
              state: 'accepted',
              snapshotId: event.snapshotId,
            });
          });
          break;
        case 'turn.done': {
          // 先把攒着的最后一句落进消息，再收尾
          active.coalescer.flush();
          active.coalescer.dispose();
          patchMessage(messageId, (message) => settle(finishThinking(message)));
          activeRef.current = null;
          setStreaming(false);
          setApproval(null);
          if (!event.ok && event.error) {
            const message = humanizeModelError(event.error).message;
            setNotice(message);
            // 失败也要在历史流里留痕：补一条红色标记，而不是等下一轮成功就抹掉
            patchMessage(messageId, (item) => ({ ...item, failed: message }));
            // 中途失败的回合也要能一键重发，否则用户只能自己再敲一遍
            setFailure(lastSendRef.current);
          }
          if (current) {
            dispatch({
              type: 'patchTask',
              taskId: current.id,
              patch: { status: event.ok ? 'done' : 'failed' },
            });
          }
          break;
        }
        default:
          break;
      }
    },
    [dispatch, patchMessage],
  );

  useEffect(() => {
    const api = window.olivia;
    if (!api?.turn) return;
    const off = api.turn.onEvent(({ taskId, turnId, event }) => {
      if (taskId !== taskRef.current?.id) return;
      handleEvent(turnId, event);
    });
    return off;
  }, [handleEvent]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, task?.id]);

  useEffect(() => {
    return () => {
      demoRef.current?.cancel();
      demoRef.current = null;
      demoCoalescerRef.current?.dispose();
      demoCoalescerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 4200);
    return () => clearTimeout(timer);
  }, [undo]);

  /**
   * 切到别的任务时，把旧回合留在界面上的「正在生成」收尾，
   * 否则那个任务会永远显示执行中，审批条也再没人点得到。
   */
  const previousTaskId = useRef<string | null>(null);
  useEffect(() => {
    const currentId = task?.id ?? null;
    if (previousTaskId.current && previousTaskId.current !== currentId) {
      const orphaned = state.tasks.find((item) => item.id === previousTaskId.current);
      const streamingMessages = (orphaned?.messages ?? []).filter((message) => message.streaming);
      for (const message of streamingMessages) {
        dispatch({
          type: 'patchMessage',
          taskId: orphaned!.id,
          messageId: message.id,
          patch: (item) => settle(finishThinking(item)),
        });
      }
      // 切走前把流式缓冲里的半句 flush 进各自的消息，落点由创建回合时的 taskId 保证
      activeRef.current?.coalescer.flush();
      demoCoalescerRef.current?.flush();
      setStreaming(false);
      setApproval(null);
    }
    previousTaskId.current = currentId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  useEffect(() => {
    setAttachments([]);
  }, [task?.id]);

  // 空闲时让版画显形；进入对话后退为氛围
  const hasMessages = messages.length > 0;
  useEffect(() => {
    document.documentElement.dataset.density = hasMessages ? 'work' : 'idle';
  }, [hasMessages]);

  /**
   * 绑定工作区。**只有用户主动点按钮时才弹系统目录框**——
   * 发消息时被动弹框会打断输入，还容易和下面的警告条打架。
   */
  const bindWorkspace = useCallback(async (): Promise<string | null> => {
    const api = window.olivia;
    const current = taskRef.current;
    if (!api || !current) return null;
    if (current.workspace) return current.workspace;
    const preset = api.env?.workspace;
    const picked = preset || (await api.workspace.pick());
    if (!picked) return null;
    const check = await api.workspace.check(picked);
    if (!check.ok) {
      setNotice(check.message);
      return null;
    }
    dispatch({ type: 'patchTask', taskId: current.id, patch: { workspace: picked } });
    // 绑定前被拦下的那条消息自动补发，草稿也算终于送出去了
    const pending = pendingSendRef.current;
    if (pending) {
      pendingSendRef.current = null;
      setNotice(null);
      setDraft('');
      void startRealRef.current?.(pending.text, pending.images, picked);
    }
    return picked;
  }, [dispatch]);

  const startReal = async (
    text: string,
    images: ImageAttachment[],
    workspaceOverride?: string,
  ): Promise<void> => {
    const api = window.olivia;
    const current = taskRef.current;
    if (!api?.turn || !current) return;

    const workspace = workspaceOverride ?? current.workspace ?? '';
    if (!workspace) {
      setNotice('先给这个任务绑定一个工作区目录');
      return;
    }
    lastSendRef.current = { text, images };

    const prompt = text || (images.length > 0 ? '请查看附上的图片。' : '');
    const titleSeed = text || (images.length > 0 ? `图片反馈 ${images.length} 张` : '新任务');
    const userMessage: Message = {
      id: uid('m'),
      role: 'user',
      at: Date.now(),
      parts: [
        ...(text ? [{ kind: 'text' as const, text }] : []),
        ...images.map((attachment) => ({ kind: 'image' as const, attachment })),
      ],
    };
    const assistant: Message = {
      id: uid('m'),
      role: 'assistant',
      at: Date.now(),
      parts: [],
      streaming: true,
    };
    dispatch({ type: 'addMessage', taskId: current.id, message: userMessage });
    dispatch({ type: 'addMessage', taskId: current.id, message: assistant });
    dispatch({
      type: 'patchTask',
      taskId: current.id,
      patch: {
        status: 'running',
        model: activeModelId,
        providerId: activeProviderId,
        title: current.messages.length === 0 ? titleFromPrompt(titleSeed) : current.title,
      },
    });
    setAttachments([]);

    const history = current.messages
      .slice(-12)
      .map((message) => ({
        role: message.role,
        content: message.parts
          .map((part) =>
            part.kind === 'text'
              ? part.text
              : part.kind === 'image'
                ? attachmentTextRef(part.attachment)
                : '',
          )
          .filter(Boolean)
          .join('\n')
          .trim(),
      }))
      .filter((message) => message.content.length > 0);

    const turnId = uid('turn');
    // flush 回调捕获本回合的 taskId：就算中途切走任务，攒着的字也落回原来的消息
    const taskId = current.id;
    activeRef.current = {
      turnId,
      messageId: assistant.id,
      coalescer: createTextCoalescer((delta) => {
        dispatch({
          type: 'patchMessage',
          taskId,
          messageId: assistant.id,
          patch: (message) => appendText(finishThinking(message), delta),
        });
      }),
    };
    setStreaming(true);
    setNotice(null);

    const result = await api.turn.start({
      turnId,
      taskId: current.id,
      workspace,
      prompt,
      model: activeModelId,
      providerId: activeProviderId,
      attachments: images,
      compactThreshold: state.settings.compactThreshold,
      approval: state.settings.approval,
      allowShell: state.settings.allowShell,
      baseUrl: activeProviderId ? undefined : state.settings.baseUrl,
      apiKey: activeProviderId ? undefined : state.settings.apiKey,
      history,
    });

    if (!result.ok) {
      activeRef.current?.coalescer.dispose();
      activeRef.current = null;
      setStreaming(false);
      setNotice(humanizeModelError(result.error).message);
      setFailure({ text, images });
      setAttachments(images);
      dispatch({ type: 'patchTask', taskId: current.id, patch: { status: 'failed' } });
    }
  };

  /** 绑定工作区后要能补发那条被拦下的消息，这里留一个稳定引用（避免闭包错位）。 */
  const startRealRef = useRef<typeof startReal | null>(null);
  startRealRef.current = startReal;

  const startDemo = (text: string): void => {
    const current = taskRef.current;
    if (!current) return;
    const userMessage: Message = {
      id: uid('m'),
      role: 'user',
      at: Date.now(),
      parts: [{ kind: 'text', text }],
    };
    const assistant: Message = {
      id: uid('m'),
      role: 'assistant',
      at: Date.now(),
      parts: [],
      streaming: true,
    };
    dispatch({ type: 'addMessage', taskId: current.id, message: userMessage });
    dispatch({ type: 'addMessage', taskId: current.id, message: assistant });
    dispatch({
      type: 'patchTask',
      taskId: current.id,
      patch: {
        status: 'running',
        title: current.messages.length === 0 ? titleFromPrompt(text) : current.title,
      },
    });
    setStreaming(true);
    let pending = false;

    // demo 回合同样走「整块淡入」：flush 捕获 taskId，切任务也不落错地方
    const taskId = current.id;
    const coalescer = createTextCoalescer((delta) => {
      dispatch({
        type: 'patchMessage',
        taskId,
        messageId: assistant.id,
        patch: (message) => appendText(finishThinking(message), delta),
      });
    });
    demoCoalescerRef.current = coalescer;

    const turn = runDemoTurn(text, (event) => {
      switch (event.type) {
        case 'text':
          coalescer.push(event.delta);
          break;
        case 'thinking':
          coalescer.flush();
          patchMessage(assistant.id, (message) => appendThinking(message, event.delta));
          break;
        case 'tool.start':
          coalescer.flush();
          patchMessage(assistant.id, (message) =>
            pushTool(message, {
              id: event.id,
              name: event.name,
              detail: event.detail,
              status: 'running',
            }),
          );
          break;
        case 'tool.finish':
          coalescer.flush();
          patchMessage(assistant.id, (message) =>
            finishTool(message, event.id, event.status, event.rows),
          );
          break;
        case 'diff':
          coalescer.flush();
          pending = event.diff.state === 'pending';
          patchMessage(assistant.id, (message) => pushDiff(message, event.diff));
          break;
        case 'done':
          coalescer.flush();
          coalescer.dispose();
          demoCoalescerRef.current = null;
          patchMessage(assistant.id, (message) => settle(finishThinking(message)));
          setStreaming(false);
          dispatch({
            type: 'patchTask',
            taskId: current.id,
            patch: { status: pending ? 'waiting' : 'done' },
          });
          break;
        default:
          break;
      }
    });
    demoRef.current = turn;
  };

  const send = (): void => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || !task || streaming) return;
    if (!preferLegacy && providers.length > 0 && !activeProviderOption) {
      setNotice('先在设置 → 模型接入里启用一个提供商，并为它添加模型');
      return;
    }
    if (attachments.length > 0 && !realMode) {
      setNotice('带图片的消息需要真实模型：先在设置里添加提供商并保存 Key');
      return;
    }
    if (realMode && !task.workspace) {
      // 不弹系统目录框、也不清空草稿：先把输入留着，绑好目录后自动补发
      pendingSendRef.current = { text, images: attachments };
      setNotice('这条消息还没发出：先在左下角「项目位置」绑一个工作区目录，绑好后会自动发送');
      return;
    }
    setFailure(null);
    setDraft('');
    if (realMode) void startReal(text, attachments);
    else startDemo(text);
  };

  /** 失败回合的重试：原样再发一次刚才那条输入。 */
  const retry = (): void => {
    if (!failure || streaming) return;
    setNotice(null);
    if (realMode) void startReal(failure.text, failure.images);
    else startDemo(failure.text);
  };

  const stop = (): void => {
    demoRef.current?.cancel();
    demoRef.current = null;
    // 停止前把攒着的最后一句落进消息，别让半句话跟着缓冲一起蒸发
    demoCoalescerRef.current?.flush();
    demoCoalescerRef.current?.dispose();
    demoCoalescerRef.current = null;
    const active = activeRef.current;
    if (active) {
      active.coalescer.flush();
      active.coalescer.dispose();
      window.olivia?.turn.cancel(active.turnId);
    }
    activeRef.current = null;
    setStreaming(false);
  };

  const decide = (decision: ApprovalDecision): void => {
    if (!approval) return;
    window.olivia?.turn.approve(approval.turnId, approval.request.callId, decision);
    setApproval(null);
  };

  const onDiffAction = (messageId: string, action: 'accepted' | 'rejected'): void => {
    patchMessage(messageId, (message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.kind === 'diff' && part.diff.state === 'pending'
          ? { kind: 'diff', diff: { ...part.diff, state: action } }
          : part,
      ),
    }));
    // 这一条路径不经过回合事件：手动接受/拒绝后必须由消息重算任务状态
    if (task) dispatch({ type: 'refreshStatus', taskId: task.id });
  };

  const onUndo = async (messageId: string, snapshotId?: string): Promise<void> => {
    const api = window.olivia;
    const current = taskRef.current;
    if (!api || !current || !current.workspace) {
      setNotice('这个任务还没有绑定工作区，无法撤销');
      return;
    }
    const result = await api.task.undo(current.id, current.workspace, snapshotId);
    setUndo(result);
    if (result.ok) {
      patchMessage(messageId, (message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.kind === 'diff' &&
          part.diff.state === 'accepted' &&
          (!snapshotId || part.diff.snapshotId === snapshotId)
            ? { kind: 'diff', diff: { ...part.diff, state: 'undone' } }
            : part,
        ),
      }));
    }
  };

  const onPatchDecide = (
    messageId: string,
    callId: string,
    accepted: number[] | null,
  ): void => {
    const active = activeRef.current;
    if (active) window.olivia?.turn.patch(active.turnId, callId, accepted);
    patchMessage(messageId, (message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.kind === 'diff' && part.diff.callId === callId
          ? {
              kind: 'diff',
              diff: { ...part.diff, state: accepted && accepted.length > 0 ? 'accepted' : 'rejected' },
            }
          : part,
      ),
    }));
    if (task) dispatch({ type: 'refreshStatus', taskId: task.id });
  };

  const addImage = useCallback(
    async (dataUrl: string, name: string, source: 'paste' | 'file'): Promise<void> => {
      const api = window.olivia?.attachments;
      if (!api) {
        setNotice('浏览器预览不能保存图片附件；请在桌面端使用');
        return;
      }
      if (!canAttach) {
        setNotice(attachHint ?? '当前模型未开启图片输入');
        return;
      }
      if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        setNotice(`每条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 张图片`);
        return;
      }
      const result = await api.save({ dataUrl, name, source });
      if (!result.ok || !result.attachment) {
        setNotice(result.error ?? '图片保存失败');
        return;
      }
      const attachment = result.attachment;
      setAttachments((current) => {
        if (current.some((item) => attachmentDedupKey(item) === attachmentDedupKey(attachment))) {
          return current;
        }
        return [...current, attachment].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      });
    },
    [attachments.length, canAttach, attachHint],
  );

  const addArtifactInput = useCallback(
    async (path: string, source: 'preview' | 'mcp'): Promise<void> => {
      const api = window.olivia?.attachments;
      if (!api) {
        setNotice('浏览器预览不能保存图片附件；请在桌面端使用');
        return;
      }
      if (!canAttach) {
        setNotice(attachHint ?? '当前模型未开启图片输入');
        return;
      }
      if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        setNotice(`每条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 张图片`);
        return;
      }
      const result = await api.adopt(path, source);
      if (!result.ok || !result.attachment) {
        setNotice(result.error ?? '这张图片加不进来');
        return;
      }
      const attachment = result.attachment;
      setAttachments((current) => {
        if (current.some((item) => attachmentDedupKey(item) === attachmentDedupKey(attachment))) {
          return current;
        }
        return [...current, attachment].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      });
      setNotice('已加入输入；确认后点发送');
    },
    [attachments.length, canAttach, attachHint],
  );

  const removeAttachment = useCallback((id: string): void => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const changeModel = (value: string): void => {
    const option = value.startsWith('builtin::')
      ? undefined
      : providerOptions.find((item) => item.key === value);
    const modelId = option?.modelId ?? value.replace(/^builtin::/, '');
    const providerId = option?.providerId;
    dispatch({ type: 'settings', patch: { model: modelId, providerId } });
    if (task) dispatch({ type: 'patchTask', taskId: task.id, patch: { model: modelId, providerId } });
    if (!option?.vision) {
      setAttachments([]);
      if (attachments.length > 0) setNotice('新模型未开启图片输入，已清空待发送的图片');
    }
  };

  const changeApproval = (approvalMode: (typeof APPROVALS)[number]['value']): void => {
    dispatch({ type: 'settings', patch: { approval: approvalMode } });
    if (task) dispatch({ type: 'patchTask', taskId: task.id, patch: { approval: approvalMode } });
  };

  /* ————————————————— 页头「…」菜单 ————————————————— */

  /** 最近一次已落盘、还带快照的写入：这就是「回滚到此前」的入口。 */
  const lastWrite = useMemo(() => {
    for (let m = messages.length - 1; m >= 0; m -= 1) {
      const message = messages[m]!;
      for (let p = message.parts.length - 1; p >= 0; p -= 1) {
        const part = message.parts[p]!;
        if (part.kind === 'diff' && part.diff.state === 'accepted' && part.diff.snapshotId) {
          return { messageId: message.id, snapshotId: part.diff.snapshotId, file: part.diff.file };
        }
      }
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (): void => setMenuOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  const copyTitle = (): void => {
    void navigator.clipboard?.writeText(task?.title ?? '').catch(() => undefined);
    setNotice('任务标题已复制');
  };

  const exportMarkdown = (): void => {
    if (!task) return;
    const lines: string[] = [
      `# ${task.title}`,
      '',
      `- 模型：${task.model}`,
      `- 创建：${new Date(task.at).toLocaleString()}`,
      `- 状态：${STATUS_TEXT[task.status]}`,
      ...(task.workspace ? [`- 工作区：${task.workspace}`] : []),
      '',
    ];
    for (const message of task.messages) {
      lines.push(message.role === 'user' ? '## 你' : '## Olivia', '');
      for (const part of message.parts) {
        if (part.kind === 'text') lines.push(part.text, '');
        else if (part.kind === 'thinking') lines.push(`> 思考：${part.text.replace(/\n/g, ' ')}`, '');
        else if (part.kind === 'diff')
          lines.push(`**diff** \`${part.diff.file}\` +${part.diff.adds} −${part.diff.dels}（${part.diff.state}）`, '');
        else if (part.kind === 'tool')
          lines.push(`- 工具 \`${part.run.name}\`：${part.run.detail} → ${part.run.status}`, '');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${task.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice('会话已导出为 Markdown');
  };

  const deleteTaskNow = (): void => {
    if (!task) return;
    setConfirmDelete(false);
    void window.olivia?.memory.clear(task.id);
    dispatch({ type: 'deleteTask', id: task.id });
  };

  /* ————————————————— 空状态 ————————————————— */
  if (!task) {
    return (
      <div className="flex-1 grid place-items-center px-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="text-center max-w-md"
        >
          <div className="mx-auto mb-6 w-16 h-16 rounded-full grid place-items-center border border-light-lineStrong dark:border-dark-lineStrong bg-white/60 dark:bg-white/[0.06] backdrop-blur-md shadow-lg animate-floaty">
            <Mark size={30} />
          </div>
          <h1 className="text-[29px] font-semibold mb-2 text-light-ink dark:text-dark-ink">
            还没有打开的任务
          </h1>
          <p className="text-[14.5px] text-light-inkMuted dark:text-dark-inkMuted mb-6 leading-relaxed">
            每一段对话都是一次委托。先创建任务，
            <br />
            再让它读代码、改代码、跑测试。
          </p>
          <button
            className="btn-solid h-9 px-5 text-[14.5px]"
            onClick={() => {
              dispatch({ type: 'addTask', task: createTask(state.settings) });
              navigate('chat');
            }}
          >
            <Icon name="plus" size={14} />
            新建任务
          </button>
        </motion.div>
      </div>
    );
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* ——— 页头 ——— */}
      <header className="shrink-0 flex items-center gap-4 px-7 py-3.5 border-b border-light-gold/20 dark:border-dark-gold/12 bg-[color:var(--olivia-head)] backdrop-blur-xl">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[19px] font-semibold leading-tight truncate text-light-ink dark:text-dark-ink">
              {task.title}
            </h1>
            <span
              className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-medium ${STATUS_TONE[task.status]}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full bg-current ${task.status === 'running' ? 'animate-pulse' : ''}`}
              />
              {STATUS_TEXT[task.status]}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[13px] text-light-inkFaint dark:text-dark-inkFaint">
            {task.workspace && (
              <>
                <span className="inline-flex items-center gap-1">
                  <Icon name="git" size={11} />
                  {task.branch}
                </span>
                <span className="inline-flex items-center gap-1 truncate">
                  <Icon name="folder" size={11} />
                  {basename(task.workspace)}
                </span>
              </>
            )}
            {!task.workspace && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Icon name="folder" size={11} />
                还没有绑定工作区
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {hasPreview && (
            <button
              className="btn-ghost"
              title={preview.open ? '收起内置预览' : '打开内置预览'}
              onClick={() => setPreview((value) => ({ ...value, open: !value.open }))}
            >
              <Icon name="globe" size={14} />
            </button>
          )}
          <button className="btn-ghost" title="删除任务" onClick={() => setConfirmDelete(true)}>
            <Icon name="x" size={13} />
          </button>
          <div className="relative">
            <button
              className="btn-ghost"
              title="更多"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icon name="dots" size={15} />
            </button>
            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.97 }}
                  transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                  role="menu"
                  onPointerDown={(event) => event.stopPropagation()}
                  className="absolute right-0 top-full mt-1.5 w-52 p-1 rounded-xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong backdrop-blur-2xl shadow-2xl z-50"
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!lastWrite}
                    title={lastWrite ? `撤销对 ${lastWrite.file} 的写入` : '这个任务还没有可撤销的写入'}
                    onClick={() => {
                      setMenuOpen(false);
                      if (lastWrite) void onUndo(lastWrite.messageId, lastWrite.snapshotId);
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[14px] text-left text-light-ink dark:text-dark-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                  >
                    <Icon name="rotate" size={13} className="text-light-inkMuted dark:text-dark-inkMuted" />
                    回滚上一次写入
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      copyTitle();
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[14px] text-left text-light-ink dark:text-dark-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                  >
                    <Icon name="file" size={13} className="text-light-inkMuted dark:text-dark-inkMuted" />
                    复制任务标题
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      exportMarkdown();
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[14px] text-left text-light-ink dark:text-dark-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                  >
                    <Icon name="send" size={13} className="text-light-inkMuted dark:text-dark-inkMuted" />
                    导出会话 Markdown
                  </button>
                  <div className="my-1 h-px bg-light-line/70 dark:bg-dark-line/70" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmDelete(true);
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[14px] text-left text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <Icon name="x" size={13} />
                    删除任务
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* ——— 对话区：蒙版铺满整个会话区块（含输入区）；预览在右侧独立停靠 ——— */}
      <div className="relative flex-1 min-h-0 flex">
        <div className="relative flex-1 min-w-0 flex flex-col">
        <div className="chat-scrim" aria-hidden="true" />
        <div
          ref={scrollRef}
          className="relative flex-1 min-h-0 w-full overflow-y-auto px-8 pt-4 pb-6 flex flex-col isolate"
        >
          {isEmpty ? (
            <div className="m-auto w-full max-w-4xl py-6">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="hero-plate text-center mb-8">
                <span className="eyebrow block mb-4">Atelier · 古典 × 超现实</span>
                <h2 className="font-serif text-plate text-[33.5px] font-semibold leading-[1.15] tracking-tight mb-3">
                  今天想让 OliviaCode 做什么？
                </h2>
                <p className="text-[14px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted max-w-lg mx-auto">
                  {task.workspace
                    ? `工作区 ${basename(task.workspace)} · 改动可回滚 · 从读代码到提 PR 一条任务走完`
                    : '先绑定工作区，再让它读代码、改代码、跑测试'}
                </p>
                <div className="mx-auto mt-5 h-px w-28 rule-ornate" />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                {SUGGESTIONS.map((item, index) => (
                  <motion.button
                    key={item.title}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, delay: 0.06 * index }}
                    whileHover={{ y: -3 }}
                    onClick={() => setDraft(item.prompt)}
                    className="group text-left p-3.5 rounded-xl border border-light-line/90 dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong backdrop-blur-xl shadow-[0_2px_10px_-6px_rgba(22,24,31,0.25)] hover:border-light-gold/50 dark:hover:border-dark-gold/40 hover:shadow-[0_10px_26px_-14px_rgba(22,24,31,0.35)] transition-all duration-300"
                  >
                    <span className="flex items-center gap-2 mb-1.5">
                      <span className="w-6 h-6 rounded-md grid place-items-center bg-light-accent/10 dark:bg-dark-accent/15 text-light-accent dark:text-dark-accent">
                        <Icon name={item.icon} size={12} />
                      </span>
                      <b className="text-[14.5px] font-semibold text-light-ink dark:text-dark-ink">
                        {item.title}
                      </b>
                    </span>
                    <span className="block text-[13px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">
                      {item.desc}
                    </span>
                  </motion.button>
                ))}
              </div>

              {!task.workspace && (
                <div className="mt-6 text-center">
                  <button
                    className="btn-outline h-8 px-4"
                    onClick={() => void bindWorkspace()}
                  >
                    <Icon name="folder" size={13} />
                    选择一个本地仓库作为工作区
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        ) : (
          <div className="w-full py-2">
            <MessageList
              messages={messages}
              onDiffAction={onDiffAction}
              onUndo={onUndo}
              onPatchDecide={onPatchDecide}
              onOpenPreview={openPreview}
              onOpenArtifact={setArtifact}
              model={task.model}
              status={task.status}
              streaming={streaming}
            />
          </div>
        )}
        </div>

        {/* ——— 输入区：与对话区同宽，共用同一块蒙版 ——— */}
        <div className="relative shrink-0 px-8 pb-5 pt-2">
          <div className="w-full space-y-2">
            <AnimatePresence initial={false}>
              {panelOpen && (
                <motion.div
                  key="usage-panel"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <UsagePanel
                    steps={usageSteps}
                    model={activeModelId}
                    providerId={activeProviderId}
                    taskId={task.id}
                    pricing={pricing}
                    windowSize={stats.window}
                    onClose={() => setPanelOpen(false)}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>{approval && <ApprovalBar request={approval.request} onDecision={decide} />}</AnimatePresence>

            <AnimatePresence>
              {notice && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-red-500/30 bg-red-500/[0.08] backdrop-blur-md text-[14px] text-red-700 dark:text-red-300"
                >
                  <Icon name="alert" size={13} />
                  <span className="flex-1">{notice}</span>
                  {failure && !streaming && (
                    <button className="btn-outline h-6" onClick={retry}>
                      <Icon name="rotate" size={11} />
                      重试
                    </button>
                  )}
                  <button className="btn-ghost h-6" onClick={() => setNotice(null)}>
                    知道了
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>{undo && <UndoToast result={undo} />}</AnimatePresence>

            <AnimatePresence>
              {streaming && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-light-line dark:border-dark-line bg-white/55 dark:bg-white/[0.05] backdrop-blur-md text-[13.5px] text-light-inkMuted dark:text-dark-inkMuted overflow-hidden"
                >
                  <span className="w-3.5 h-3.5 rounded-full border-[1.5px] border-light-accent dark:border-dark-gold border-t-transparent animate-spin" />
                  <span className="flex-1">
                    {realMode ? '执行中：读写都会先出 diff 或等你批准' : '演示模式：正在回放脚本'}
                  </span>
                  <button className="btn-ghost h-6" onClick={stop}>
                    停止
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            <Composer
              value={draft}
              onChange={setDraft}
              onSend={send}
              onStop={stop}
              onModel={changeModel}
              onApproval={changeApproval}
              onWorkspace={() => void bindWorkspace()}
              onNewTask={() => {
                dispatch({ type: 'addTask', task: createTask(state.settings) });
              }}
              onOpenGit={() => navigate('git')}
              model={composerModelValue}
              modelOptions={modelOptions}
              approval={task.approval}
              workspace={task.workspace}
              streaming={streaming}
              stats={stats}
              onOpenUsage={() => setPanelOpen((value) => !value)}
              usageOpen={panelOpen}
              compactStats={preview.open}
              attachments={attachments}
              canAttach={canAttach}
              attachHint={attachHint}
              onAttachBlocked={() => setNotice(attachHint ?? '当前模型未开启图片输入')}
              onAddImage={(dataUrl, name, source) => void addImage(dataUrl, name, source)}
              onRemoveAttachment={removeAttachment}
            />
          </div>
        </div>
        </div>

        {preview.open && hasPreview && (
          <PreviewDock
            taskId={task.id}
            open={preview.open}
            initialUrl={preview.url}
            hidden={Boolean(artifact)}
            onClose={() => setPreview((value) => ({ ...value, open: false }))}
            onCaptured={(path) => setArtifact(path)}
            onSendToModel={
              canAttach ? (path) => void addArtifactInput(path, 'preview') : undefined
            }
          />
        )}
      </div>

      {artifact && (
        <ArtifactViewer
          path={artifact}
          onClose={() => setArtifact(null)}
          onAddInput={
            canAttach
              ? () => {
                  void addArtifactInput(artifact, 'mcp');
                  setArtifact(null);
                }
              : undefined
          }
        />
      )}

      {/* 上翻阅读时冒出来：想回到底部不用再手动拖 */}
      <AnimatePresence>
        {!atBottom && messages.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={scrollToBottom}
            className="absolute bottom-[168px] right-10 z-20 h-8 px-3 rounded-full border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong backdrop-blur-xl shadow-lg text-[12.5px] text-light-inkMuted dark:text-dark-inkMuted hover:text-light-ink dark:hover:text-dark-ink transition-colors"
            title="回到最新消息"
          >
            回到底部
          </motion.button>
        )}
      </AnimatePresence>

      {/* 应用内确认：不再用浏览器原生 confirm 卡住渲染线程 */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] grid place-items-center bg-black/50 backdrop-blur-sm p-5"
            onClick={() => setConfirmDelete(false)}
          >
            <motion.div
              initial={{ scale: 0.96, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 10 }}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              className="w-full max-w-sm rounded-2xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong p-5 shadow-2xl"
            >
              <h2 className="text-[16px] font-semibold text-light-ink dark:text-dark-ink">删除这个任务？</h2>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">
                「{task.title}」的对话记录和任务记忆会一起删除，磁盘上已经写入的文件不受影响。
              </p>
              <div className="mt-4 flex items-center gap-2">
                <button className="btn-outline h-8 px-3" onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
                <span className="flex-1" />
                <button
                  className="h-8 px-3 rounded-lg text-[13.5px] text-white bg-red-500 hover:bg-red-600 transition-colors"
                  onClick={deleteTaskNow}
                >
                  删除任务
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
