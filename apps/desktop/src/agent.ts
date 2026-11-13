import {
  TOOLS,
  describeCall,
  diffText,
  isMutating,
  toolSpec,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
  type GitProvider,
  type Part,
  type PatchDecision,
  type PatchEditPreview,
  type SessionEvent,
  type TurnEvent,
} from '@olivia/core';
import {
  applyEdits,
  fileExists,
  gitQuery,
  listDir,
  readFile,
  runCommand,
  searchText,
  writeText,
  type PatchEdit,
  type Policy,
  type SnapshotStore,
} from '@olivia/exec';
import { commit as gitCommit, push as gitPush, readBranches, readStatus } from './git';
import { createPullRequest } from './providers';
import type { SessionStore } from './sessions';
import { loadPolicy, policyAllows, rememberRule } from './workspace';

const MAX_STEPS = 12;
const MAX_TOOL_RESULT = 12_000;
const MAX_TOOL_ERRORS = 3;

type ApiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

interface Completion {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export interface AgentOptions {
  taskId: string;
  turnId: string;
  prompt: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  model: string;
  baseUrl: string;
  apiKey: string;
  approval: ApprovalMode;
  allowShell: boolean;
  policy: Policy;
  snapshots: SnapshotStore;
  sessions: SessionStore;
  emit: (event: TurnEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  requestPatch: (input: {
    callId: string;
    path: string;
    edits: PatchEditPreview[];
    adds: number;
    dels: number;
  }) => Promise<PatchDecision>;
  gitToken: (provider: GitProvider) => string | null;
  signal: AbortSignal;
  /** 允许这个节点调用的工具白名单；不传表示全部可用（普通对话）。 */
  tools?: string[];
}

function systemPrompt(root: string, tree: string[]): string {
  return [
    '你是 OliviaCode 的编程助手，运行在用户本机的桌面客户端里，可以直接读写工作区、执行命令。',
    `工作区根目录：${root}`,
    tree.length > 0 ? `顶层结构：\n${tree.join('\n')}` : '',
    '',
    '工作规则：',
    '1. 动手前先用 list_dir / read_file / search 建立上下文，禁止编造文件内容或路径。',
    '2. 局部修改一律用 apply_patch，old 必须是从 read_file 结果里原样复制的唯一片段（含缩进）；只有新建文件或整文件重写才用 write_file。',
    '3. 改完代码自己跑一遍相关测试（run_command），失败就修，不要留 TODO 交差。',
    '4. 不要执行破坏性命令（删除仓库、git push --force、重置工作区），除非用户明确要求。',
    '5. 用简体中文回答：先给结论，再列改了什么、验证结果；不要复述整段文件内容。',
  ]
    .filter(Boolean)
    .join('\n');
}

function truncate(text: string, limit = MAX_TOOL_RESULT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断，原始长度 ${text.length} 字符）`;
}

function formatToolResult(name: string, text: string): string {
  return truncate(`[${name}]\n${text}`);
}

/** 校验每条 edits 的 old 是否唯一命中，并生成逐条预览。 */
function previewEdits(before: string, edits: PatchEdit[]): PatchEditPreview[] {
  if (edits.length === 0) throw new Error('edits 不能为空');
  return edits.map((edit, index) => {
    if (!edit.old.trim()) throw new Error(`第 ${index + 1} 条修改的 old 为空`);
    const occurrences = before.split(edit.old).length - 1;
    if (occurrences === 0) {
      throw new Error(`第 ${index + 1} 条修改找不到原文，请先 read_file 确认内容与缩进`);
    }
    if (occurrences > 1) {
      throw new Error(`第 ${index + 1} 条修改的原文出现了 ${occurrences} 次，请补足上下文让它唯一`);
    }
    const applied = before.replace(edit.old, edit.new);
    const diff = diffText(before, applied);
    return { index, adds: diff.adds, dels: diff.dels, hunks: diff.hunks };
  });
}

async function streamCompletion(
  messages: ApiMessage[],
  options: {
    model: string;
    baseUrl: string;
    apiKey: string;
    signal: AbortSignal;
    onText: (delta: string) => void;
    onThinking: (delta: string) => void;
    tools?: string[];
  },
): Promise<Completion> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const allowed = options.tools;
  const specs = allowed ? TOOLS.filter((tool) => allowed.includes(tool.name)) : TOOLS;
  const response = await fetch(url, {
    method: 'POST',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      stream: true,
      max_tokens: 4096,
      tools: specs.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      tool_choice: 'auto',
      messages,
    }),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`模型请求失败（HTTP ${response.status}）：${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: string | null = null;
  const calls = new Map<number, ToolCall>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json: {
        choices?: {
          finish_reason?: string | null;
          delta?: {
            content?: string;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
        }[];
      };
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      const thinking = delta.reasoning_content ?? delta.reasoning;
      if (thinking) options.onThinking(thinking);
      if (delta.content) {
        content += delta.content;
        options.onText(delta.content);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = calls.get(index) ?? { id: '', name: '', args: '' };
        if (call.id) current.id += call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.args += call.function.arguments;
        calls.set(index, current);
      }
    }
  }

  return {
    content,
    finishReason,
    toolCalls: [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call], index) => ({
        id: call.id || `call_${index}_${Date.now().toString(36)}`,
        name: call.name,
        args: call.args,
      }))
      .filter((call) => call.name),
  };
}

interface ExecutedTool {
  status: 'ok' | 'error';
  text: string;
  summary: string;
  rows: string[];
}

async function executeTool(
  options: AgentOptions,
  name: string,
  args: Record<string, unknown>,
  callId: string,
  log: (event: SessionEvent) => void,
  accepted?: number[],
): Promise<ExecutedTool> {
  const { policy } = options;
  switch (name) {
    case 'list_dir': {
      const entries = await listDir(policy, String(args.path ?? '.'), Number(args.depth ?? 2));
      const rows = entries.slice(0, 200).map((entry) =>
        entry.kind === 'dir' ? `${entry.path}/` : entry.path,
      );
      return {
        status: 'ok',
        text: rows.join('\n') || '（空目录）',
        summary: `${entries.length} 个条目`,
        rows: rows.slice(0, 6),
      };
    }
    case 'read_file': {
      const rel = String(args.path ?? '');
      const text = await readFile(policy, rel);
      return {
        status: 'ok',
        text,
        summary: `${text.split('\n').length} 行`,
        rows: [rel],
      };
    }
    case 'search': {
      const hits = await searchText(policy, String(args.query ?? ''), {
        include: args.include ? String(args.include) : undefined,
      });
      // 回给模型用路径，不要行号之外的噪音
      return {
        status: 'ok',
        text: hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join('\n') || '没有命中',
        summary: `${hits.length} 处命中`,
        rows: hits.slice(0, 6).map((hit) => `${hit.path}:${hit.line}`),
      };
    }
    case 'write_file': {
      const rel = String(args.path ?? '');
      const content = String(args.content ?? '');
      const existed = await fileExists(policy, rel);
      const before = existed ? await readFile(policy, rel, 4 * 1024 * 1024) : '';
      const snapshot = await options.snapshots.create(options.taskId, policy, [rel]);
      log({ at: Date.now(), type: 'snapshot', id: snapshot.id, files: [rel] });
      await writeText(policy, rel, content);
      const diff = diffText(before, content);
      options.emit({
        type: 'file.changed',
        path: rel,
        adds: diff.adds,
        dels: diff.dels,
        hunks: diff.hunks,
        snapshotId: snapshot.id,
      });
      log({ at: Date.now(), type: 'file.changed', path: rel, adds: diff.adds, dels: diff.dels });
      return {
        status: 'ok',
        text: `已写入 ${rel}（+${diff.adds} −${diff.dels}）`,
        summary: `+${diff.adds} −${diff.dels}`,
        rows: [rel],
      };
    }
    case 'apply_patch': {
      const rel = String(args.path ?? '');
      const allEdits = Array.isArray(args.edits)
        ? (args.edits as { old?: unknown; new?: unknown }[]).map((edit) => ({
            old: String(edit?.old ?? ''),
            new: String(edit?.new ?? ''),
          }))
        : [];
      const edits = accepted
        ? allEdits.filter((_, index) => accepted.includes(index))
        : allEdits;
      if (edits.length === 0) throw new Error('没有接受任何改动');
      const snapshot = await options.snapshots.create(options.taskId, policy, [rel]);
      log({ at: Date.now(), type: 'snapshot', id: snapshot.id, files: [rel] });
      const { before, after } = await applyEdits(policy, rel, edits);
      const diff = diffText(before, after);
      options.emit({
        type: 'file.changed',
        path: rel,
        adds: diff.adds,
        dels: diff.dels,
        hunks: diff.hunks,
        snapshotId: snapshot.id,
        callId,
      });
      log({ at: Date.now(), type: 'file.changed', path: rel, adds: diff.adds, dels: diff.dels });
      return {
        status: 'ok',
        text: `已修改 ${rel}（${edits.length} 处，+${diff.adds} −${diff.dels}）`,
        summary: `+${diff.adds} −${diff.dels}`,
        rows: [rel],
      };
    }
    case 'run_command': {
      if (!options.allowShell) {
        throw new Error('命令执行在设置里是关闭的，已拒绝。请让用户到「设置 → 执行与审批」显式打开。');
      }
      const command = String(args.command ?? '');
      const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
      const timeout = Number(args.timeout_ms ?? 120_000);
      const result = await runCommand(policy, command, cmdArgs, {
        timeoutMs: Number.isFinite(timeout) ? timeout : 120_000,
        onOutput: (chunk) => options.emit({ type: 'command.output', callId, chunk }),
      });
      const seconds = (result.durationMs / 1000).toFixed(1);
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      const summary = result.timedOut
        ? `超时 ${seconds}s`
        : `exit ${result.code ?? 'null'} · ${seconds}s`;
      return {
        status: result.code === 0 ? 'ok' : 'error',
        text: `${summary}\n${output.slice(0, 8000) || '（无输出）'}`,
        summary,
        rows: output
          .split('\n')
          .filter(Boolean)
          .slice(-6),
      };
    }
    case 'git_status': {
      const text = await gitQuery(policy, ['status', '--short', '--branch']);
      return { status: 'ok', text: text || '（干净）', summary: '工作区状态', rows: text.split('\n').slice(0, 6) };
    }
    case 'git_diff': {
      const rel = args.path ? String(args.path) : undefined;
      const text = await gitQuery(policy, rel ? ['diff', '--', rel] : ['diff']);
      const clipped = text.slice(0, 20_000) || '（没有未提交改动）';
      return { status: 'ok', text: clipped, summary: '未提交改动', rows: rel ? [rel] : [] };
    }
    case 'git_commit': {
      const message = String(args.message ?? '');
      const hash = await gitCommit(policy.root, message);
      return {
        status: 'ok',
        text: `已提交 ${hash}：${message.split('\n')[0] ?? ''}`,
        summary: hash,
        rows: [message.split('\n')[0] ?? ''],
      };
    }
    case 'git_push': {
      const status = await readStatus(policy.root);
      const provider = status.remote?.provider;
      if (!provider) throw new Error('没有识别出远程仓库，请用户先绑定 origin');
      const token = options.gitToken(provider);
      if (!token) throw new Error(`没有 ${provider} 令牌，请用户到「设置 → Git 凭据」保存`);
      const output = await gitPush(policy.root, { provider, token });
      return {
        status: 'ok',
        text: output.trim() || '已推送',
        summary: '已推送',
        rows: [status.branch],
      };
    }
    case 'git_create_pr': {
      const status = await readStatus(policy.root);
      if (!status.remote) throw new Error('没有识别出远程仓库');
      const token = options.gitToken(status.remote.provider);
      if (!token) throw new Error('缺少平台令牌，请用户到「设置 → Git 凭据」保存');
      const result = await createPullRequest({
        remote: status.remote,
        token,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        head: status.branch,
        base: String(args.base ?? 'main'),
      });
      if (!result.ok) throw new Error(result.message ?? 'PR 创建失败');
      return {
        status: 'ok',
        text: `PR 已创建：${result.url ?? ''}`,
        summary: 'PR 已创建',
        rows: [result.url ?? ''],
      };
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

/** 把流式事件折叠成可落盘的 parts，重放时能还原同样的界面。 */
function collectParts(parts: Part[], event: TurnEvent): void {
  switch (event.type) {
    case 'text': {
      const last = parts[parts.length - 1];
      if (last && last.kind === 'text') last.text += event.delta;
      else parts.push({ kind: 'text', text: event.delta });
      break;
    }
    case 'thinking': {
      const last = parts[parts.length - 1];
      if (last && last.kind === 'thinking' && !last.done) last.text += event.delta;
      else parts.push({ kind: 'thinking', text: event.delta, done: false });
      break;
    }
    case 'tool.request':
      parts.push({
        kind: 'tool',
        run: {
          id: event.call.callId,
          name: event.call.name,
          detail: event.call.detail,
          status: event.needsApproval ? 'waiting' : 'running',
        },
      });
      break;
    case 'tool.result':
      for (const part of parts) {
        if (part.kind === 'tool' && part.run.id === event.callId) {
          part.run = { ...part.run, status: event.status, rows: event.rows ?? part.run.rows };
        }
      }
      break;
    case 'file.proposed': {
      parts.push({
        kind: 'diff',
        diff: {
          file: event.path,
          adds: event.adds,
          dels: event.dels,
          hunks: event.edits.flatMap((edit) => edit.hunks),
          state: 'pending',
          callId: event.callId,
          edits: event.edits,
        },
      });
      break;
    }
    case 'file.changed': {
      const existing = parts.find(
        (part) => part.kind === 'diff' && event.callId && part.diff.callId === event.callId,
      );
      if (existing && existing.kind === 'diff') {
        existing.diff = {
          ...existing.diff,
          adds: event.adds,
          dels: event.dels,
          hunks: event.hunks,
          state: 'accepted',
          snapshotId: event.snapshotId,
        };
      } else {
        parts.push({
          kind: 'diff',
          diff: {
            file: event.path,
            adds: event.adds,
            dels: event.dels,
            hunks: event.hunks,
            state: 'accepted',
            snapshotId: event.snapshotId,
          },
        });
      }
      break;
    }
    default:
      break;
  }
}

/** 一轮完整对话：写日志 → 跑循环 → 落库。 */
export async function runAgentTurn(options: AgentOptions): Promise<void> {
  const { sessions, taskId, turnId } = options;
  const parts: Part[] = [];
  const emit = (event: TurnEvent): void => {
    collectParts(parts, event);
    options.emit(event);
  };

  await sessions.append(taskId, {
    at: Date.now(),
    type: 'user.message',
    id: `${turnId}_user`,
    text: options.prompt,
  });

  let ok = true;
  let failure: string | undefined;
  try {
    await runAgentLoop({ ...options, emit });
  } catch (error) {
    ok = false;
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (parts.length > 0) {
      await sessions.append(taskId, {
        at: Date.now(),
        type: 'assistant.message',
        id: `${turnId}_assistant`,
        parts,
      });
    }
    await sessions.append(taskId, { at: Date.now(), type: 'turn.end', turnId, ok, error: failure });
  }
}

async function runAgentLoop(options: AgentOptions): Promise<void> {
  const { policy, emit, sessions, taskId } = options;
  const log = (event: SessionEvent): void => {
    void sessions.append(taskId, event);
  };

  let tree: string[] = [];
  try {
    const entries = await listDir(policy, '.', 1);
    tree = entries.slice(0, 40).map((entry) => (entry.kind === 'dir' ? `${entry.path}/` : entry.path));
  } catch {
    tree = [];
  }

  const messages: ApiMessage[] = [
    { role: 'system', content: systemPrompt(policy.root, tree) },
    ...options.history.slice(-12),
    { role: 'user', content: options.prompt },
  ];

  const policyFile = await loadPolicy(policy.root);
  let toolErrors = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (options.signal.aborted) return;

    const completion = await streamCompletion(messages, {
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      signal: options.signal,
      onText: (delta) => emit({ type: 'text', delta }),
      onThinking: (delta) => emit({ type: 'thinking', delta }),
      tools: options.tools,
    });

    if (completion.toolCalls.length === 0) return;

    messages.push({
      role: 'assistant',
      content: completion.content,
      tool_calls: completion.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args },
      })),
    });

    for (const call of completion.toolCalls) {
      if (options.signal.aborted) return;

      let args: Record<string, unknown> = {};
      try {
        args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `参数不是合法 JSON：${call.args.slice(0, 200)}`,
        });
        toolErrors += 1;
        continue;
      }

      const spec = toolSpec(call.name);
      const blocked = Boolean(spec && options.tools && !options.tools.includes(spec.name));
      const detail = describeCall(call.name, args);
      const mutating = spec ? isMutating(call.name) : false;
      const allowedByPolicy = spec ? policyAllows(policyFile, call.name, args) : false;
      const isPatch = call.name === 'apply_patch';
      const patchAsk = isPatch && options.approval === 'ask' && !allowedByPolicy;
      const mustAsk =
        Boolean(spec) &&
        mutating &&
        !allowedByPolicy &&
        !isPatch &&
        (options.approval === 'ask' ||
          (options.approval === 'auto' && spec?.risk === 'exec'));

      // 一次调用只发一条 tool.request，避免界面出现两张重复卡
      emit({
        type: 'tool.request',
        call: { callId: call.id, name: call.name, risk: spec?.risk ?? 'read', detail, args },
        needsApproval: mustAsk,
      });

      let decision: 'auto' | ApprovalDecision = 'auto';
      let acceptedEdits: number[] | undefined;
      let blockedReason: string | undefined;

      if (!spec) {
        decision = 'reject';
      } else if (blocked) {
        decision = 'reject';
        blockedReason = `这个节点没有被授予 ${call.name} 权限（可用：${(options.tools ?? []).join(' / ') || '无'}），换个做法或者跳过。`;
      } else if (patchAsk) {
        // 逐处接受：先出预览，由用户勾选要应用哪几条
        try {
          const rel = String(args.path ?? '');
          const before = await readFile(policy, rel, 4 * 1024 * 1024);
          const edits = Array.isArray(args.edits)
            ? (args.edits as { old?: unknown; new?: unknown }[]).map((edit) => ({
                old: String(edit?.old ?? ''),
                new: String(edit?.new ?? ''),
              }))
            : [];
          const previews = previewEdits(before, edits);
          const adds = previews.reduce((sum, item) => sum + item.adds, 0);
          const dels = previews.reduce((sum, item) => sum + item.dels, 0);
          emit({ type: 'file.proposed', callId: call.id, path: rel, edits: previews, adds, dels });
          const answer = await options.requestPatch({
            callId: call.id,
            path: rel,
            edits: previews,
            adds,
            dels,
          });
          if (!answer || answer.length === 0) {
            decision = 'reject';
          } else {
            acceptedEdits = answer;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolErrors += 1;
          emit({ type: 'tool.result', callId: call.id, status: 'error', summary: message.slice(0, 140) });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: formatToolResult(call.name, `错误：${message}`),
          });
          continue;
        }
      } else if (mustAsk) {
        const answer = await options.requestApproval({
          callId: call.id,
          name: call.name,
          risk: spec.risk,
          detail,
          args,
        });
        decision = answer;
        if (answer === 'always') {
          const key = await rememberRule(policy.root, call.name, args);
          policyFile.allow.push(key);
        }
      }

      if (decision === 'reject') {
        const text =
          blockedReason ??
          (isPatch
            ? '用户没有接受这次修改。请说明改动意图，或换成更小的、更明确的补丁。'
            : `用户拒绝执行 ${call.name}。请说明为什么需要它，或换一种不需要批准的做法。`);
        emit({
          type: 'tool.result',
          callId: call.id,
          status: 'error',
          summary: blocked ? '无权限' : isPatch ? '未接受' : '已拒绝',
        });
        log({
          at: Date.now(),
          type: 'tool.call',
          callId: call.id,
          name: call.name,
          args: call.args,
          decision: 'rejected',
          status: 'error',
          summary: isPatch ? '未接受' : '已拒绝',
        });
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        continue;
      }

      try {
        const result = await executeTool(options, call.name, args, call.id, log, acceptedEdits);
        emit({
          type: 'tool.result',
          callId: call.id,
          status: result.status,
          summary: result.summary,
          rows: result.rows,
        });
        log({
          at: Date.now(),
          type: 'tool.call',
          callId: call.id,
          name: call.name,
          args: call.args,
          decision: decision === 'auto' ? 'auto' : 'approved',
          status: result.status,
          summary: result.summary,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: formatToolResult(call.name, result.text),
        });
        if (result.status === 'ok') toolErrors = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolErrors += 1;
        emit({ type: 'tool.result', callId: call.id, status: 'error', summary: message.slice(0, 120) });
        log({
          at: Date.now(),
          type: 'tool.call',
          callId: call.id,
          name: call.name,
          args: call.args,
          decision: decision === 'auto' ? 'auto' : 'approved',
          status: 'error',
          summary: message.slice(0, 200),
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: formatToolResult(call.name, `错误：${message}`),
        });
        if (toolErrors >= MAX_TOOL_ERRORS) {
          throw new Error(`连续 ${toolErrors} 次工具失败，先停下：${message}`);
        }
      }
    }
  }

  throw new Error(`已连续执行 ${MAX_STEPS} 步仍未收敛，先停下等你确认方向。`);
}
