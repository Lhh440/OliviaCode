// M7 主题验收：三套动态主题各截一张，并检查视频、字体、水波纹。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots-m7');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m7-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m7ws-'));

const messages = [
  {
    id: 'm1',
    role: 'user',
    role2: 'user',
    at: Date.now() - 120000,
    parts: [{ kind: 'text', text: '先读一下工作区结构，再把这个模块的边界讲清楚。' }],
  },
  {
    id: 'm2',
    role: 'assistant',
    at: Date.now() - 110000,
    parts: [
      { kind: 'thinking', text: '入口在 views/Chat.tsx；先看 store 与组件的关系。', done: true },
      {
        kind: 'tool',
        run: { id: 't1', name: 'read_file', detail: 'apps/web/src/views/Chat.tsx', status: 'ok', rows: ['147 行 · 导出 ChatView'] },
      },
      {
        kind: 'text',
        text: [
          '## 结论',
          '',
          '这个模块是**单任务对话页**：`Chat` 持有草稿与流式状态，`MessageList` 只负责渲染。',
          '',
          '- 输入框是一体化的：模型、权限、项目位置都在框内',
          '- 工具卡按状态变色；逐处接受在补丁卡上勾选',
          '',
          '```tsx',
          'export function ChatView() {',
          '  const { state, dispatch } = useStore();',
          '  return <MessageList messages={state.messages} />;',
          '}',
          '```',
          '',
          '> 评审建议：把审批条与输入框的状态收敛到同一个 reducer。',
        ].join('\n'),
      },
    ],
  },
];

const state = {
  tasks: [
    {
      id: 'task_theme',
      title: '把主题换成动态水墨',
      branch: 'main',
      model: 'deepseek-v4.1-flash',
      approval: 'ask',
      status: 'done',
      at: Date.now() - 130000,
      messages,
      workspace,
    },
  ],
  activeId: 'task_theme',
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

async function shot(win, name) {
  const image = await win.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log('saved', name);
}

async function run() {
  await wait(1500);
  let win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    await wait(1500);
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('没有拿到窗口');
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[page]', String(message).slice(0, 200));
  });

  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`localStorage.setItem('olivia.state.v1', ${JSON.stringify(JSON.stringify(state))}); true`);

  for (const theme of ['ink-abyss', 'ink-mist', 'sakura']) {
    await js(`localStorage.setItem('olivia.theme.v3', '${theme}'); true`);
    await win.webContents.reload();
    await wait(2600);
    await js(`window.location.hash = '#/chat'; true`);
    await wait(1400);
    if (theme === 'ink-abyss') {
      const probe = await js(`(() => {
        const v = document.querySelector('.scene video');
        const layer = document.querySelector('.scene-layer');
        const body = getComputedStyle(document.body);
        return JSON.stringify({
          video: Boolean(v),
          paused: v ? v.paused : null,
          readyState: v ? v.readyState : null,
          currentTime: v ? Number(v.currentTime.toFixed(2)) : null,
          layerOpacity: layer ? getComputedStyle(layer).opacity : null,
          font: body.fontFamily.slice(0, 40),
          accent: getComputedStyle(document.documentElement).getPropertyValue('--olivia-accent').trim(),
          ripples: Boolean(document.querySelector('.ripple-layer')),
        });
      })()`);
      console.log('PROBE:', probe);

      // 触发一次点击水波纹，趁它还在时截图
      await js(`(() => {
        const el = document.elementFromPoint(760, 420) || document.body;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 760, clientY: 420, button: 0 }));
        return true;
      })()`);
      await wait(220);
      await shot(win, 'theme-ink-abyss-ripple.png');
      await wait(1200);
      await shot(win, 'theme-ink-abyss.png');
    } else {
      await shot(win, `theme-${theme}.png`);
    }
  }

  // 工作流页也截一张（面板多，验证可读性）
  await js(`localStorage.setItem('olivia.theme.v3', 'ink-mist'); true`);
  await win.webContents.reload();
  await wait(2200);
  await js(`window.location.hash = '#/workflow'; true`);
  await wait(1500);
  await shot(win, 'theme-workflow.png');
}

app.whenReady().then(async () => {
  process.env.OLIVIA_WORKSPACE = workspace;
  process.env.OLIVIA_HEADLESS = '1';
  require(path.join(root, 'apps', 'desktop', 'dist', 'main.cjs'));
  try {
    await run();
  } catch (error) {
    console.error('demo failed:', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});