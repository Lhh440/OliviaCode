// 纯页面截图：不依赖模型端点，覆盖四套皮肤的首屏与设置/工作流/Git 面板。
// 用法：electron scripts/capture-pages.cjs [outDir]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs', 'screenshots-v3'));
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.on('olivia:env', (event) => {
  event.returnValue = { baseUrl: '', apiKey: '', model: '', workspace: '' };
});

app.disableHardwareAcceleration();

async function freeze(win) {
  // 无头窗口不会推进 CSS 过渡：截图前把过渡与动画关掉，否则会拍到「半途」的颜色。
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
  await wait(120);
}

async function shot(win, name, ms = 900) {
  await freeze(win);
  await wait(ms);
  const image = await win.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`saved ${name}`);
}

async function open(win, skin, hash, ms = 1200) {
  if (!win.webContents.getURL()) {
    await win.loadFile(indexHtml, { hash });
    await wait(500);
  }
  await win.webContents.executeJavaScript(
    `localStorage.setItem('olivia.skin', ${JSON.stringify(skin)}); true`,
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
  await wait(800);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    show: false,
    backgroundColor: '#f2efe8',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // 隐藏窗口默认会节流 rAF，且浮层不会进入合成结果：挪到屏幕外再显示，截图才完整。
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('[page]', msg);
  });

  try {
    await open(win, 'angel', '/chat');
    await win.webContents.executeJavaScript(
      'localStorage.removeItem("olivia.state.v1"); localStorage.removeItem("olivia.workflow.v1"); true',
    );

    for (const skin of ['angel', 'lily', 'collage', 'madonna']) {
      await open(win, skin, '/chat');
      await newTask(win);
      await shot(win, `${skin}-welcome.png`, 1300);
    }

    await open(win, 'angel', '/chat');
    const pickerOpened = await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('aside button[title="切换主题"]');
        if (btn) btn.click();
        return !!btn;
      })()
    `);
    console.log('theme picker trigger:', pickerOpened);
    await shot(win, 'theme-picker.png', 900);

    for (const skin of ['lily', 'madonna']) {
      await open(win, skin, '/settings');
      await shot(win, `${skin}-settings.png`, 1100);
    }

    for (const skin of ['lily', 'madonna']) {
      await open(win, skin, '/workflow', 1500);
      await shot(win, `${skin}-workflow.png`, 900);
    }

    await open(win, 'lily', '/git', 1400);
    await shot(win, 'lily-git.png', 900);
  } catch (error) {
    console.error('capture failed', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
