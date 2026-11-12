// UI 自检：直接启动真实主进程，用脚本驱动界面走完「读 → 改 → 撤销」，并截图。
// 用法：electron scripts/ui-e2e.cjs（需要 OLIVIA_BASE_URL / OLIVIA_API_KEY）
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');

// 用临时 profile，避免污染真实的任务与快照
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-ui-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);

// 临时工作区
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-ws-'));
fs.writeFileSync(
  path.join(workspace, 'README.md'),
  '# Demo Repo\n\n这是 OliviaCode 的 UI 自检仓库。\n',
  'utf8',
);
fs.writeFileSync(
  path.join(workspace, 'package.json'),
  JSON.stringify({ name: 'ui-demo', version: '1.0.0' }, null, 2),
  'utf8',
);
process.env.OLIVIA_WORKSPACE = workspace;
// 无头：不弹窗、不抢焦点，避免和正在用机器的人互相打断
process.env.OLIVIA_HEADLESS = '1';

require(path.join(root, 'apps', 'desktop', 'dist', 'main.cjs'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outDir = path.join(root, 'docs', 'screenshots');

async function js(win, code) {
  return win.webContents.executeJavaScript(code);
}

async function shot(win, name) {
  const image = await win.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`saved ${name}`);
}

async function waitFor(win, expression, timeout = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await js(win, `Boolean(${expression})`).catch(() => false);
    if (ok) return true;
    await wait(350);
  }
  return false;
}

async function type(win, text) {
  await js(
    win,
    `(() => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
  await wait(250);
  await js(win, `document.querySelector('.send-btn')?.click(); true`);
}

async function run() {
  await wait(1200);
  let win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    await wait(1500);
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('没有拿到窗口');
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }
  await wait(600);

  // 新任务
  await js(win, `document.querySelector('.new-task')?.click(); true`);
  await wait(500);

  // A1：读路径（无需审批）
  await type(win, 'README.md 的一级标题是什么？调用 read_file 确认，只回答标题本身。');
  const readDone = await waitFor(
    win,
    `!document.querySelector('.run-strip .spinner') && document.querySelectorAll('.tool-card').length > 0`,
    120_000,
  );
  await wait(600);
  await shot(win, 'm1-read.png');
  console.log(`read turn finished: ${readDone}`);

  // A2：写路径（会弹审批）
  await type(win, '把 README.md 的第一行标题改成「# OliviaCode M1 测试仓库」，只改这一行，用 apply_patch。');
  const gotApproval = await waitFor(win, `document.querySelector('.approval-bar')`, 90_000);
  await wait(1000);
  await shot(win, 'm1-approval.png');
  console.log(`approval bar: ${gotApproval}`);
  if (gotApproval) {
    await js(win, `document.querySelector('.approval-bar .btn.primary')?.click(); true`);
  }
  const writeDone = await waitFor(
    win,
    `!document.querySelector('.run-strip .spinner') && document.querySelector('.diff-card')`,
    120_000,
  );
  await wait(600);
  await shot(win, 'm1-diff.png');
  console.log(`write turn finished: ${writeDone}`);

  const afterWrite = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
  console.log('README after write:', JSON.stringify(afterWrite.split('\n')[0]));

  // 撤销
  const undoable = await js(
    win,
    `Boolean([...document.querySelectorAll('.diff-foot button')].find((b) => b.textContent.includes('撤销')))`,
  );
  if (undoable) {
    await js(
      win,
      `([...document.querySelectorAll('.diff-foot button')].find((b) => b.textContent.includes('撤销'))).click(); true`,
    );
    await wait(1500);
    await shot(win, 'm1-undo.png');
    const restored = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
    console.log('README after undo:', JSON.stringify(restored.split('\n')[0]));
    console.log(`undo ok: ${restored.startsWith('# Demo Repo')}`);
  } else {
    console.log('undo button not found');
  }

  fs.rmSync(workspace, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    console.error('ui-e2e failed:', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
