// 本地视觉验证：塞一个带大 diff 的任务，截图对话区，检查蒙版覆盖范围与文件预览卡折叠形态。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const outDir = path.join(root, '.tmp', 'shots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-shot-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-ws-'));

function hunk(header, rows) {
  return {
    header,
    lines: rows.map(([kind, text]) => ({ kind, text })),
  };
}

const bigLines = [];
for (let i = 0; i < 26; i += 1) {
  bigLines.push([i % 7 === 0 ? 'del' : 'add', `  const value${i} = compute(${i}) /* ${'x'.repeat(24)} */;`]);
}

const messages = [
  {
    id: 'm1',
    role: 'user',
    at: Date.now() - 200000,
    parts: [{ kind: 'text', text: '把聊天页的蒙版铺满，再把文件预览卡改成默认收起。' }],
  },
  {
    id: 'm2',
    role: 'assistant',
    at: Date.now() - 190000,
    parts: [
      { kind: 'thinking', text: '先看 Chat.tsx 的结构，再改 MessageList 的 diff 卡。', done: true },
      {
        kind: 'tool',
        run: {
          id: 't1',
          name: 'read_file',
          detail: 'apps/web/src/components/MessageList.tsx',
          status: 'ok',
          rows: ['789 行 · 导出 MessageList / ApprovalBar / UndoToast'],
        },
      },
      {
        kind: 'text',
        text: [
          '## 改动',
          '',
          '- 蒙版改成铺满整个会话区块，含输入区',
          '- 文件预览默认收起成一行，点一下才展开',
        ].join('\n'),
      },
      {
        kind: 'diff',
        diff: {
          id: 'd1',
          file: 'apps/web/src/views/Chat.tsx',
          adds: 26,
          dels: 4,
          state: 'pending',
          hunks: [
            hunk('@@ -690,6 +690,14 @@ export function ChatView()', bigLines.slice(0, 14)),
            hunk('@@ -779,6 +779,10 @@ export function ChatView()', bigLines.slice(14)),
          ],
        },
      },
      {
        kind: 'diff',
        diff: {
          id: 'd2',
          file: 'apps/web/src/components/MessageList.tsx',
          adds: 12,
          dels: 2,
          state: 'accepted',
          hunks: [hunk('@@ -240,6 +240,18 @@ function Collapse', bigLines.slice(0, 8))],
        },
      },
    ],
  },
];

const state = {
  tasks: [
    {
      id: 'task_shot',
      title: '把对话区蒙版铺满整个区块',
      branch: 'main',
      model: 'deepseek-v4.1-flash',
      approval: 'ask',
      status: 'done',
      at: Date.now() - 210000,
      messages,
      workspace,
    },
  ],
  activeId: 'task_shot',
  settings: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-v4.1-flash',
    approval: 'ask',
    demo: false,
    allowShell: false,
  },
};

ipcMain.on('olivia:env', (event) => {
  event.returnValue = { baseUrl: '', apiKey: '', model: '', workspace };
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  await wait(1600);
  let win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    await wait(1600);
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('没有拿到窗口');
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }
  win.setContentSize(1500, 940);
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[page]', String(message).slice(0, 200));
  });

  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`localStorage.setItem('olivia.state.v1', ${JSON.stringify(JSON.stringify(state))}); true`);
  await js(`localStorage.setItem('olivia.theme.v4', 'koi-light'); true`);
  await win.webContents.reload();
  await wait(2400);
  await js(`window.location.hash = '#/chat'; true`);
  await wait(1600);

  fs.mkdirSync(outDir, { recursive: true });
  let image = await win.capturePage();
  fs.writeFileSync(path.join(outDir, 'live-chat.png'), image.toPNG());
  console.log('saved live-chat.png');

  // 量一下蒙版与容器实际的矩形，确认是否铺满
  const probe = await js(`(() => {
    const scrim = document.querySelector('.chat-scrim');
    const col = scrim ? scrim.parentElement : null;
    const main = document.querySelector('main');
    const composer = document.querySelector('.composer');
    const r = (el) => el ? (() => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), h: Math.round(b.height) }; })() : null;
    const diffCards = [...document.querySelectorAll('.md, [title="展开 diff"], [title="收起 diff"]')].length;
    return JSON.stringify({ scrim: r(scrim), col: r(col), main: r(main), composer: r(composer), diffCards, vh: window.innerHeight }, null, 0);
  })()`);
  console.log('PROBE:', probe);
}

app.whenReady().then(async () => {
  process.env.OLIVIA_WORKSPACE = workspace;
  process.env.OLIVIA_HEADLESS = '1';
  require(path.join(root, 'apps', 'desktop', 'dist', 'main.cjs'));
  try {
    await run();
  } catch (error) {
    console.error('shot failed:', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
