// 四套皮肤 × 各视图截图
// 用法：electron scripts/capture-v2.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots-v3');
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.on('olivia:env', (event) => {
  event.returnValue = { baseUrl: '', apiKey: '', model: '', workspace: '' };
});

app.disableHardwareAcceleration();

async function shot(win, name, ms = 900) {
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

async function typeAndSend(win, text) {
  await win.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);
}

const LIGHT = ['angel', 'lily'];
const DARK = ['collage', 'madonna'];

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: '#f2efe8',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('[page]', msg);
  });

  try {
    await open(win, 'angel', '/chat');
    await win.webContents.executeJavaScript(
      'localStorage.removeItem("olivia.state.v1"); localStorage.removeItem("olivia.workflow.v1"); true',
    );

    for (const skin of [...LIGHT, ...DARK]) {
      await open(win, skin, '/chat');
      await newTask(win);
      await shot(win, `${skin}-welcome.png`, 1300);
    }

    // 对话态：亮色各一套
    for (const skin of ['angel', 'lily']) {
      await open(win, skin, '/chat');
      await newTask(win);
      await typeAndSend(win, '先读工作区结构，用三段话讲清楚这个项目是怎么跑起来的。');
      await shot(win, `${skin}-chat.png`, 12000);
    }

    // 暗色对话态
    await open(win, 'madonna', '/chat');
    await newTask(win);
    await typeAndSend(win, '把侧栏的任务列表改成按状态分组，并自己跑一遍测试。');
    await shot(win, 'madonna-chat.png', 12000);

    // 主题选择器
    await open(win, 'angel', '/chat');
    await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('aside button[title="切换主题"]');
        if (btn) btn.click();
        return !!btn;
      })()
    `);
    await shot(win, 'theme-picker.png', 700);

    // 其它视图
    await open(win, 'lily', '/settings');
    await shot(win, 'lily-settings.png');
    await open(win, 'madonna', '/workflow', 1500);
    await shot(win, 'madonna-workflow.png', 900);
    await open(win, 'lily', '/git');
    await shot(win, 'lily-git.png');
  } catch (error) {
    console.error('capture failed', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
