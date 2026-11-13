// 纯页面截图：不依赖模型端点。三套动态主题各一张对话，外加设置/工作流/Git/计划/扩展。
// 用法：node scripts/electron-run.cjs scripts/capture-pages.cjs [outDir]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs', 'screenshots-m7'));
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');
const THEMES = ['ink-abyss', 'ink-mist', 'sakura'];

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
    `localStorage.setItem('olivia.theme.v3', ${JSON.stringify(theme)}); true`,
  );
  await win.loadFile(indexHtml, { hash, query: { r: String(Date.now()) } });
  await wait(ms);
}

async function newTask(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      const btn =
        document.querySelector('aside button[title="新建任务"]') ||
        [...document.querySelectorAll('aside button')].find((b) => b.textContent.includes('新建任务'));
      if (btn) btn.click();
      return !!btn;
    })()
  `);
  await wait(900);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    show: false,
    backgroundColor: '#0a0e12',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('[page]', String(msg).slice(0, 160));
  });

  try {
    await open(win, THEMES[0], '/chat');
    await win.webContents.executeJavaScript(
      'localStorage.removeItem("olivia.state.v1"); localStorage.removeItem("olivia.workflow.v1"); true',
    );

    for (const theme of THEMES) {
      await open(win, theme, '/chat', 2200);
      await newTask(win);
      await shot(win, `${theme}-welcome.png`, 1500);
      await shot(win, `${theme}-chat.png`, 600);
    }

    await open(win, 'ink-mist', '/workflow', 2200);
    await shot(win, 'ink-mist-workflow.png', 900);

    await open(win, 'ink-abyss', '/settings', 1600);
    await shot(win, 'ink-abyss-settings.png', 900);

    await open(win, 'ink-mist', '/extensions', 1800);
    await shot(win, 'ink-mist-extensions.png', 900);

    await open(win, 'ink-abyss', '/git', 1600);
    await shot(win, 'ink-abyss-git.png', 900);

    await open(win, 'sakura', '/schedules', 1800);
    await shot(win, 'sakura-schedules.png', 900);
  } catch (error) {
    console.error('capture failed', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});