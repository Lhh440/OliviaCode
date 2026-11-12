import type { StreamEvent } from '@olivia/core';
import { uid } from '@olivia/core';

/**
 * 演示模式：没有密钥时用脚本回放，保证 UI 可看、可讲。
 * 真实回合在 Electron 主进程里（apps/desktop/src/agent.ts），渲染层拿不到密钥也碰不到 fs。
 */
export interface TurnHandle {
  cancel(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function runDemoTurn(prompt: string, emit: (event: StreamEvent) => void): TurnHandle {
  let cancelled = false;

  const run = async (): Promise<void> => {
    const say = async (text: string, speed = 14): Promise<void> => {
      for (const ch of text) {
        if (cancelled) return;
        emit({ type: 'text', delta: ch });
        await sleep(speed);
      }
    };

    await sleep(200);
    if (cancelled) return;

    await say('先看仓库结构和相关文件，再动手。', 12);
    if (cancelled) return;

    const searchId = uid('tool');
    emit({
      type: 'tool.start',
      id: searchId,
      name: 'search',
      detail: 'grep "composer|Composer" apps/web/src --include *.tsx',
    });
    await sleep(650);
    if (cancelled) return;
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
    if (cancelled) return;

    const readId = uid('tool');
    emit({ type: 'tool.start', id: readId, name: 'read_file', detail: 'apps/web/src/views/Chat.tsx' });
    await sleep(550);
    if (cancelled) return;
    emit({ type: 'tool.finish', id: readId, status: 'ok', rows: ['214 行 · 2 个导出', '行尾统一 LF'] });

    const patchId = uid('tool');
    emit({
      type: 'tool.start',
      id: patchId,
      name: 'apply_patch',
      detail: 'apps/web/src/views/Chat.tsx  (+34 −12)',
    });
    await sleep(850);
    if (cancelled) return;
    emit({
      type: 'tool.finish',
      id: patchId,
      status: 'ok',
      rows: ['3 处修改已写入', '快照已生成'],
    });

    if (cancelled) return;
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

    await sleep(240);
    if (cancelled) return;
    await say(
      prompt.includes('测试')
        ? '改动已落地，接下来我会跑 `npm test -- --run`，失败就修，不留 TODO。'
        : '改动已落地——这是演示模式。配置密钥后会走真实工具调用：改之前先出 diff，写入前自动快照，随时可回滚。',
      10,
    );
    if (cancelled) return;
    emit({ type: 'done' });
  };

  void run();
  return { cancel: () => { cancelled = true; } };
}
