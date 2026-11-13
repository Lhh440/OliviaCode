// 七套主题全截图：对话/工作流/设置/扩展/Git/计划各一张。
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.on('olivia:env', (event) => {
  event.returnValue = { baseUrl: '', apiKey: '', model: '', workspace };
});

const THEMES = [
  'ink-abyss',
  'ink-mist',
  'sakura',
  'winter-forest',
  'chibi',
  'winter-sunrise',
  'gojo',
];

async function shot(win, name) {
  const image = await win.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log('saved', name);
}

app.whenReady().then(async () => {
  process.env.OLIVIA_WORKSPACE = workspace;
  process.env.OLIVIA_HEADLESS = '1';
  require(path.join(root, 'apps', 'desktop', 'dist', 'main.cjs'));

  await wait(1500);
  let win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    await wait(1500);
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('没有拿到窗口');
  if (win.webContents.isLoading())
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();

  const js = (code) => win.webContents.executeJavaScript(code);

  try {
    // 对话页：七套主题都拍
    for (const theme of THEMES) {
      await js(`localStorage.setItem('olivia.theme.v3', '${theme}'); true`);
      await win.webContents.reload();
      await wait(2400);
      await js(`window.location.hash = '#/chat'; true`);
      await wait(1400);
      await shot(win, `${theme}-chat.png`);
    }

    // 其他页各拍一张（选有代表性的主题）
    await js(`localStorage.setItem('olivia.theme.v3', 'ink-mist'); true`);
    await win.webContents.reload();
    await wait(2200);
    await js(`window.location.hash = '#/workflow'; true`);
    await wait(1400);
    await shot(win, 'workflow.png');

    await js(`localStorage.setItem('olivia.theme.v3', 'winter-forest'); true`);
    await win.webContents.reload();
    await wait(2200);
    await js(`window.location.hash = '#/settings'; true`);
    await wait(1200);
    await shot(win, 'settings.png');

    await js(`localStorage.setItem('olivia.theme.v3', 'chibi'); true`);
    await win.webContents.reload();
    await wait(2200);
    await js(`window.location.hash = '#/extensions'; true`);
    await wait(1400);
    await shot(win, 'extensions.png');

    await js(`localStorage.setItem('olivia.theme.v3', 'gojo'); true`);
    await win.webContents.reload();
    await wait(2200);
    await js(`window.location.hash = '#/git'; true`);
    await wait(1200);
    await shot(win, 'git.png');

    await js(`localStorage.setItem('olivia.theme.v3', 'sakura'); true`);
    await win.webContents.reload();
    await wait(2200);
    await js(`window.location.hash = '#/schedules'; true`);
    await wait(1400);
    await shot(win, 'schedules.png');
  } catch (error) {
    console.error('demo failed:', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});