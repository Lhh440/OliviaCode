import type { StreamEvent, Settings } from '@olivia/core';
import { uid } from '@olivia/core';

export interface TurnHandle {
  cancel(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SYSTEM_PROMPT = [
  '你是 OliviaCode 的编程助手，运行在用户本机的桌面客户端里。',
  '回答用简体中文，先给结论，再说改了什么、为什么。',
  '不要编造没有读过的文件内容。',
].join('\n');

export function runTurn(prompt: string, settings: Settings, emit: (event: StreamEvent) => void): TurnHandle {
  let cancelled = false;
  const apiKey = settings.apiKey.trim();
  const baseUrl = settings.baseUrl.trim();

  if (apiKey && baseUrl) {
    void runLiveTurn(prompt, settings, emit, () => cancelled);
    return { cancel: () => { cancelled = true; } };
  }

  void runDemoTurn(prompt, emit, () => cancelled);
  return { cancel: () => { cancelled = true; } };
}

async function runDemoTurn(prompt: string, emit: (e: StreamEvent) => void, stopped: () => boolean): Promise<void> {
  const say = async (text: string, speed = 14): Promise<void> => {
    for (const ch of text) {
      if (stopped()) return;
      emit({ type: 'text', delta: ch });
      await sleep(speed);
    }
  };

  await sleep(220);
  if (stopped()) return;

  await say('先看仓库结构和相关文件，再动手。', 12);
  if (stopped()) return;

  const searchId = uid('tool');
  emit({ type: 'tool.start', id: searchId, name: 'search', detail: 'grep "composer|Composer" apps/web/src --include *.tsx' });
  await sleep(700);
  if (stopped()) return;
  emit({
    type: 'tool.finish',
    id: searchId,
    status: 'ok',
    rows: [
      'components/Composer.tsx:12  export function Composer(',
      'views/Chat.tsx:147  <Composer value={draft} onChange={setDraft} />',
      'views/Chat.tsx:151  </Composer>',
    ],
  });

  await say('入口在 `views/Chat.tsx`，输入框是独立组件。我按「少改、可回滚」的方式改三处。', 12);
  if (stopped()) return;

  const readId = uid('tool');
  emit({ type: 'tool.start', id: readId, name: 'read_file', detail: 'apps/web/src/views/Chat.tsx' });
  await sleep(600);
  if (stopped()) return;
  emit({ type: 'tool.finish', id: readId, status: 'ok', rows: ['214 行 · 2 个导出', '行尾统一 LF'] });

  const patchId = uid('tool');
  emit({ type: 'tool.start', id: patchId, name: 'apply_patch', detail: 'apps/web/src/views/Chat.tsx  (+34 −12)' });
  await sleep(900);
  if (stopped()) return;
  emit({ type: 'tool.finish', id: patchId, status: 'ok', rows: ['3 处修改已写入', '快照 snapshot#12 已生成'] });

  if (stopped()) return;
  emit({
    type: 'diff',
    diff: {
      file: 'apps/web/src/views/Chat.tsx',
      adds: 12,
      dels: 4,
      state: 'pending',
      hunks: [
        {
          header: '@@ -142,8 +142,11 @@ export function ChatView()',
          lines: [
            { kind: 'ctx', text: '      <main className="thread">' },
            { kind: 'del', text: '        <ThreadHeader title={title} />' },
            { kind: 'add', text: '        <ThreadHeader' },
            { kind: 'add', text: '          title={title}' },
            { kind: 'add', text: '          approval={approval}' },
            { kind: 'add', text: '          onApprovalChange={setApproval}' },
            { kind: 'add', text: '        />' },
            { kind: 'ctx', text: '        <MessageList messages={messages} />' },
          ],
        },
        {
          header: '@@ -160,6 +163,10 @@ export function ChatView()',
          lines: [
            { kind: 'ctx', text: '      <Composer value={draft} onChange={setDraft} />' },
            { kind: 'add', text: '      <StatusBar>' },
            { kind: 'add', text: '        <SnapshotChip id={snapshotId} />' },
            { kind: 'add', text: '        <ContextMeter used={38} total={200} />' },
            { kind: 'add', text: '      </StatusBar>' },
          ],
        },
      ],
    },
  });

  await sleep(260);
  if (stopped()) return;
  await say(
    prompt.includes('测试')
      ? '改动已落地，接下来我会跑 `npm test -- --run`，失败就修，不留 TODO。'
      : '改动已落地，你确认后我跑测试并提交。这次改动有快照，随时可以回滚到改前。',
    10,
  );
  if (stopped()) return;
  emit({ type: 'done' });
}

async function runLiveTurn(
  prompt: string,
  settings: Settings,
  emit: (e: StreamEvent) => void,
  stopped: () => boolean,
): Promise<void> {
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: settings.model,
        stream: true,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      emit({ type: 'text', delta: `请求失败（HTTP ${res.status}）。${detail.slice(0, 300)}\n\n检查设置里的 Base URL 与模型名是否正确。` });
      emit({ type: 'done' });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!stopped()) {
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
        try {
          const json = JSON.parse(payload) as {
            choices?: {
              delta?: { content?: string; reasoning_content?: string; reasoning?: string };
            }[];
          };
          const delta = json.choices?.[0]?.delta;
          const thinking = delta?.reasoning_content ?? delta?.reasoning ?? '';
          if (thinking) emit({ type: 'thinking', delta: thinking });
          const text = delta?.content ?? '';
          if (text) emit({ type: 'text', delta: text });
        } catch {
          // 忽略非 JSON 的心跳行
        }
      }
    }
    emit({ type: 'done' });
  } catch (error) {
    emit({
      type: 'text',
      delta: `连接失败：${error instanceof Error ? error.message : String(error)}\n\n客户端没有走代理，请确认本机网络能直连该端点。`,
    });
    emit({ type: 'done' });
  }
}
