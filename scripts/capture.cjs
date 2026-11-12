// 用 Electron 自己把界面截下来，保证和桌面端渲染一致。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(win, hash, file, delay) {
  await win.loadFile(indexHtml, { hash });
  await wait(delay);
  const image = await win.capturePage();
  const target = path.join(outDir, file);
  fs.writeFileSync(target, image.toPNG());
  const { width, height } = image.getSize();
  console.log(`saved ${file} ${width}x${height}`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: '#fbfbfc',
    webPreferences: {
      preload: path.join(root, 'apps', 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[page] ${message}`);
  });

  try {
    await capture(win, '/chat', 'chat.png', 1400);
    await win.loadFile(indexHtml, { hash: '/chat' });
    await wait(700);
    await win.webContents.executeJavaScript(
      "document.querySelectorAll('.task-item')[1]?.click(); true",
    );
    await wait(700);
    const welcome = await win.capturePage();
    fs.writeFileSync(path.join(outDir, 'welcome.png'), welcome.toPNG());
    console.log('saved welcome.png');
    await capture(win, '/workflow', 'workflow.png', 1600);
    await capture(win, '/settings', 'settings.png', 1200);
  } catch (error) {
    console.error('capture failed', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
