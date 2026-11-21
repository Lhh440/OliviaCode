// 主题验收：黑鱼白水 / 白鱼黑水两套各截「欢迎页 + 对话页」，再各补一张设置页。
// 用真实构建产物 + 内置页面，不依赖主进程与模型端点。
//
// 产物：docs/screenshots-theme/koi-{light,dark}-{welcome,chat,settings}.png
// 同时断言：字体（Inter + HarmonyOS Sans SC）确实装上、主题变量跟着走、
// 标题衬底与阅读衬底存在、鱼不在正文层里吃事件。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots-theme');
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');
const workspace = 'D:\\work\\olivia-koi';
const now = Date.now();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(ok, message) {
  if (!ok) throw new Error(`断言失败：${message}`);
}

const settings = {
  baseUrl: '',
  apiKey: '',
  model: 'deepseek-v4.1-flash',
  providerId: 'deepseek',
  approval: 'ask',
  demo: false,
  allowShell: false,
  defaultContextWindow: 128000,
  compactThreshold: 85,
};

const chatState = {
  activeId: 'task_koi',
  settings,
  tasks: [
    {
      id: 'task_koi',
      title: '把侧栏改成按状态分组',
      branch: 'main',
      model: 'deepseek-v4.1-flash',
      providerId: 'deepseek',
      approval: 'ask',
      status: 'done',
      at: now,
      workspace,
      usage: [],
      messages: [
        {
          id: 'm1',
          role: 'user',
          at: now - 240000,
          parts: [{ kind: 'text', text: '把侧栏的任务列表改成按状态分组，顺便把空状态补上。' }],
        },
        {
          id: 'm2',
          role: 'assistant',
          at: now - 230000,
          parts: [
            { kind: 'thinking', text: '先读 Sidebar 与 store，确认分组依据，再动样式。', done: true },
            {
              kind: 'tool',
              run: {
                id: 't1',
                name: 'read_file',
                detail: 'apps/web/src/components/Sidebar.tsx',
                status: 'ok',
                rows: ['217 行 · 导出 Sidebar'],
              },
            },
            {
              kind: 'text',
              text: [
                '## 改动',
                '',
                '- 侧栏按 `运行中 / 等待确认 / 已完成` 分组，组头带计数',
                '- 空分组不再占位，只在有任务时出现',
                '- 标题换成 HarmonyOS Sans 的半粗一档，和「黑鱼白水」更搭',
              ].join('\n'),
            },
          ],
        },
        {
          id: 'm3',
          role: 'user',
          at: now - 120000,
          parts: [{ kind: 'text', text: '分组头再淡一点，别抢任务标题。' }],
        },
      ],
    },
  ],
};

const welcomeState = {
  activeId: 'task_koi',
  settings,
  tasks: [{ ...chatState.tasks[0], title: '新任务', status: 'idle', messages: [] }],
};

app.disableHardwareAcceleration();

async function shot(win, name) {
  await wait(700);
  const image = await win.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`saved ${name}`);
}

async function open(win, theme, hash, seedState, ms = 1600) {
  await win.webContents.executeJavaScript(
    `localStorage.setItem('olivia.theme.v4', ${JSON.stringify(theme)});
     localStorage.setItem('olivia.state.v1', ${JSON.stringify(JSON.stringify(seedState))});
     true;`,
  );
  await win.loadFile(indexHtml, { hash, query: { r: String(Date.now()) } });
  await wait(ms);
}

/** 页面自检：字体、主题变量、阅读衬底、画布层级。 */
async function probe(win, theme) {
  const raw = await win.webContents.executeJavaScript(`(() => {
    const body = getComputedStyle(document.body);
    const rootStyle = getComputedStyle(document.documentElement);
    const title = document.querySelector('h1, h2');
    const titleStyle = title ? getComputedStyle(title) : null;
    const canvas = document.querySelector('.koi-canvas');
    const pane = document.querySelector('.pane-veil');
    const plate = document.querySelector('.hero-plate');
    const loaded = [...document.fonts]
      .filter((face) => face.status === 'loaded')
      .map((face) => face.family + ' ' + face.weight + ' ' + face.style);
    return JSON.stringify({
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      bodyFont: body.fontFamily,
      titleFont: titleStyle ? titleStyle.fontFamily : null,
      titleWeight: titleStyle ? titleStyle.fontWeight : null,
      harmonyRegular: document.fonts.check('16px "HarmonyOS Sans SC"'),
      harmonySemibold: document.fonts.check('600 16px "HarmonyOS Sans SC"'),
      inter: document.fonts.check('16px Inter'),
      loadedFaces: loaded,
      accent: rootStyle.getPropertyValue('--olivia-accent').trim(),
      panel: rootStyle.getPropertyValue('--olivia-panel-strong').trim(),
      card: rootStyle.getPropertyValue('--olivia-card').trim(),
      canvasZ: canvas ? getComputedStyle(canvas).zIndex : null,
      canvasPointer: canvas ? getComputedStyle(canvas).pointerEvents : null,
      paneVeil: Boolean(pane),
      heroPlate: Boolean(plate),
    });
  })()`);
  const info = JSON.parse(raw);
  console.log(`PROBE ${theme}:`, raw);

  assert(info.theme === theme, `${theme} 的 data-theme 没生效（读到 ${info.theme}）`);
  assert(/Inter/.test(info.bodyFont), `正文没有走 Inter：${info.bodyFont}`);
  assert(/HarmonyOS Sans SC/.test(info.bodyFont), `正文没有 HarmonyOS 兜底：${info.bodyFont}`);
  assert(info.harmonyRegular && info.harmonySemibold, 'HarmonyOS Sans SC 400/600 没有加载');
  assert(info.inter, 'Inter 没有加载');
  assert(/HarmonyOS Sans SC/.test(info.titleFont ?? ''), `标题没有用同一套字体：${info.titleFont}`);
  assert(info.loadedFaces.some((face) => face.includes('HarmonyOS Sans SC')), '字体表里没有 HarmonyOS 面');
  assert(info.canvasPointer === 'none', '鱼画布不该吃鼠标事件');
  assert(info.paneVeil, '缺 .pane-veil 阅读衬底');
  if (theme === 'koi-light') assert(info.heroPlate, '留白页缺 .hero-plate 标题衬底');
  return info;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    show: false,
    backgroundColor: '#f2f1ec',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log('[page]', String(message).slice(0, 200));
  });

  try {
    await win.loadFile(indexHtml, { hash: '/chat' });
    await wait(400);

    for (const theme of ['koi-light', 'koi-dark']) {
      await open(win, theme, '/chat', welcomeState, 2200);
      await probe(win, theme);
      await shot(win, `${theme}-welcome.png`);
      await open(win, theme, '/chat', chatState, 2000);
      await shot(win, `${theme}-chat.png`);
      await open(win, theme, '/settings', welcomeState, 1800);
      await shot(win, `${theme}-settings.png`);
    }
  } catch (error) {
    console.error('theme shots failed:', error);
    process.exitCode = 1;
  }

  app.quit();
});

app.on('window-all-closed', () => app.quit());
