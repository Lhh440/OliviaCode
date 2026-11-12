import type { Task } from '@olivia/core';

const now = Date.now();
const minutes = (n: number) => now - n * 60_000;

export const seedTasks: Task[] = [
  {
    id: 'task_demo_1',
    title: '把对话页改成单任务布局',
    branch: 'main',
    model: 'DeepSeek-V4.1-Flash',
    approval: 'ask',
    status: 'waiting',
    at: minutes(6),
    messages: [
      {
        id: 'm1',
        role: 'user',
        at: minutes(6),
        parts: [
          {
            kind: 'text',
            text: '把对话页改成 Codex 式单任务布局：去掉会话内左侧导航，新建任务直接进输入框。',
          },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        at: minutes(6),
        parts: [
          { kind: 'text', text: '先看一眼现有结构，再动手改。' },
          {
            kind: 'tool',
            run: {
              id: 't1',
              name: 'search',
              detail: 'grep "SessionPanel" apps/web/src',
              status: 'ok',
              rows: [
                'views/Chat.tsx:88  const sessions = useSessionList();',
                'views/Chat.tsx:143  <SessionPanel sessions={sessions} />',
                'store.ts:51  sessionId: string;',
              ],
            },
          },
          {
            kind: 'tool',
            run: {
              id: 't2',
              name: 'read_file',
              detail: 'apps/web/src/views/Chat.tsx',
              status: 'ok',
              rows: ['214 行 · 导出 ChatView', '依赖：useSessionList / SessionPanel'],
            },
          },
          {
            kind: 'text',
            text: '入口在 Chat.tsx：左栏是会话内导航，与单任务布局冲突。改动三处：删除导航、把空态做成新任务输入、状态栏加审批选择。',
          },
          {
            kind: 'diff',
            diff: {
              file: 'apps/web/src/views/Chat.tsx',
              adds: 34,
              dels: 12,
              state: 'pending',
              hunks: [
                {
                  header: '@@ -36,12 +36,9 @@ export function ChatView()',
                  lines: [
                    { kind: 'ctx', text: '  const [draft, setDraft] = useState("");' },
                    { kind: 'del', text: '  const [panelOpen, setPanelOpen] = useState(true);' },
                    { kind: 'del', text: '  const sessions = useSessionList();' },
                    { kind: 'add', text: '  const [approval, setApproval] = useState<ApprovalMode>("ask");' },
                    { kind: 'ctx', text: '  const messages = useMessages();' },
                    { kind: 'ctx', text: '  return (' },
                    { kind: 'del', text: '    <div className="chat with-panel">' },
                    { kind: 'del', text: '      {panelOpen && <SessionPanel sessions={sessions} />}' },
                    { kind: 'add', text: '    <div className="chat single-task">' },
                  ],
                },
                {
                  header: '@@ -150,9 +147,14 @@ export function ChatView()',
                  lines: [
                    { kind: 'ctx', text: '        <Composer value={draft} onChange={setDraft} />' },
                    { kind: 'add', text: '        <div className="statusbar">' },
                    { kind: 'add', text: '          <ApprovalSelect value={approval} onChange={setApproval} />' },
                    { kind: 'add', text: '          <ModelChip model={model} />' },
                    { kind: 'add', text: '        </div>' },
                    { kind: 'ctx', text: '      </div>' },
                  ],
                },
              ],
            },
          },
          {
            kind: 'text',
            text: '改动已生成，等你确认。确认后我会跑一遍相关测试，再提交到 main。',
          },
        ],
      },
    ],
  },
  {
    id: 'task_demo_2',
    title: '给工作流节点补快捷键',
    branch: 'workflow-canvas',
    model: 'DeepSeek-V3.2',
    approval: 'auto',
    status: 'idle',
    at: minutes(74),
    messages: [],
  },
  {
    id: 'task_demo_3',
    title: '升级 Vite 到 5.4 并修告警',
    branch: 'main',
    model: 'Claude-Sonnet-4.5',
    approval: 'ask',
    status: 'done',
    at: minutes(240),
    messages: [
      {
        id: 'm3',
        role: 'user',
        at: minutes(240),
        parts: [{ kind: 'text', text: '把 Vite 升到 5.4，顺手把构建告警修掉。' }],
      },
      {
        id: 'm4',
        role: 'assistant',
        at: minutes(238),
        parts: [
          {
            kind: 'text',
            text: '已升级到 vite@5.4.11，替换了 3 处已废弃的导入写法，构建告警从 7 条降到 0，测试 60/60 通过。',
          },
        ],
      },
    ],
  },
];
