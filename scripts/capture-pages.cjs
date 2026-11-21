// 纯页面截图：不依赖模型端点、不依赖主进程。
// 黑鱼白水 / 白鱼黑水各领一半页面，检查鱼在每张版面上的位置与正文可读性。
// 用法：node scripts/electron-run.cjs scripts/capture-pages.cjs [outDir]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs', 'screenshots-pages'));
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');

/** 页面在地图上的分工：浅色偏「读」，深色偏「跑」。 */
const PAGES = [
  { theme: 'koi-light', hash: '/workflow', name: 'koi-light-workflow.png', settle: 2200 },
  { theme: 'koi-light', hash: '/schedules', name: 'koi-light-schedules.png', settle: 1700 },
  { theme: 'koi-dark', hash: '/chat', name: 'koi-dark-chat.png', settle: 2200 },
  { theme: 'koi-dark', hash: '/extensions', name: 'koi-dark-extensions.png', settle: 2000 },
  { theme: 'koi-dark', hash: '/git', name: 'koi-dark-git.png', settle: 1700 },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.on('olivia:env', (event) => {
  event.returnValue = { baseUrl: '', apiKey: '', model: '', workspace: '' };
});

app.disableHardwareAcceleration();

async function freeze(win) {
  // 无头窗口不推进过渡：截图前把 transition 冻住，否则会拍到半途的颜色（动画保留，framer-motion 用 WAAPI）
  await win.webContents.executeJavaScript(`
    (() => {
      if (document.getElementById('__capture-freeze')) return;
      const style = document.createElement('style');
      style.id = '__capture-freeze';
      style.textContent = '*, *::before, *::after { transition: none !important; }';
      document.head.appendChild(style);
      return true;
    })()
  `);
  await wait(140);
}

async function shot(win, name, ms = 900) {
  await freeze(win);
  await wait(ms);
  const image = await win.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`saved ${name}`);
}

async function open(win, theme, hash, ms = 1500) {
  await win.webContents.executeJavaScript(
    `localStorage.setItem('olivia.theme.v4', ${JSON.stringify(theme)}); true`,
  );
  await win.loadFile(indexHtml, { hash, query: { r: String(Date.now()) } });
  await wait(ms);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });

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
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('[page]', String(msg).slice(0, 160));
  });

  try {
    await open(win, 'koi-light', '/chat');
    // 页面巡览从干净状态开始：清掉演示会话与工作流草稿，只留主题
    await win.webContents.executeJavaScript(
      'localStorage.removeItem("olivia.state.v1"); localStorage.removeItem("olivia.workflow.v1"); true',
    );

    for (const page of PAGES) {
      await open(win, page.theme, page.hash, page.settle);
      await shot(win, page.name, 900);
    }
  } catch (error) {
    console.error('capture failed', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});