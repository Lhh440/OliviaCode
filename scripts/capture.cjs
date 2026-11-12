// 用 Electron 自己把界面截下来，保证和桌面端渲染一致。
// 带 OLIVIA_API_KEY 运行时，额外截一张真实模型的对话。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const readEnv = () => ({
  baseUrl: process.env.OLIVIA_BASE_URL || '',
  apiKey: process.env.OLIVIA_API_KEY || '',
  model: process.env.OLIVIA_MODEL || '',
});

ipcMain.on('olivia:env', (event) => {
  event.returnValue = readEnv();
});

app.disableHardwareAcceleration();

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(win, hash, file, delay) {
  await win.loadFile(indexHtml, { hash });
  await wait(delay);
  const image = await win.capturePage();
  fs.writeFileSync(path.join(outDir, file), image.toPNG());
  const { width, height } = image.getSize();
  console.log(`saved ${file} ${width}x${height}`);
}

async function captureLive(win, prompt, file, waitMs) {
  await win.loadFile(indexHtml, { hash: '/chat' });
  await wait(900);
  await win.webContents.executeJavaScript("document.querySelector('.new-task')?.click(); true");
  await wait(500);
  await win.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(prompt)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await wait(350);
  await win.webContents.executeJavaScript("document.querySelector('.send-btn')?.click(); true");
  await wait(waitMs);
  const image = await win.capturePage();
  fs.writeFileSync(path.join(outDir, file), image.toPNG());
  console.log(`saved ${file} (live)`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: '#fbfbfc',
    webPreferences: {
      preload: path.join(root, 'apps', 'desktop', 'dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[page] ${message}`);
  });

  try {
    if (process.env.OLIVIA_SHOT_ONLY !== 'live') {
      await win.loadFile(indexHtml, { hash: '/chat' });
      await wait(400);
      await win.webContents.executeJavaScript('localStorage.clear(); true');
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
    }

    if (process.env.OLIVIA_API_KEY && process.env.OLIVIA_SHOT_ONLY !== 'static') {
      await captureLive(
        win,
        '用两句话说明：作为本地 AI 编程工具，你最擅长帮我把哪类工作做完？',
        'chat-live.png',
        18000,
      );
    }
  } catch (error) {
    console.error('capture failed', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
