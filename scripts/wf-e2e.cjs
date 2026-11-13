// M4 工作流端到端：真实主进程 + preload + 渲染层，模型用 scripts/mock-llm.cjs 顶替。
// 用法：electron scripts/wf-e2e.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createMockServer } = require('./mock-llm.cjs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots-v3');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-wfe2e-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-wfws-'));
fs.writeFileSync(path.join(workspace, 'README.md'), '# WF E2E Repo\n', 'utf8');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
execFileSync('git', ['add', '-A'], { cwd: workspace });
execFileSync(
  'git',
  ['-c', 'user.name=E2E', '-c', 'user.email=e2e@olivia.local', 'commit', '-q', '-m', 'init'],
  { cwd: workspace },
);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function js(win, code) {
  return win.webContents.executeJavaScript(code);
}

async function waitFor(win, expression, timeout = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await js(win, `Boolean(${expression})`).catch(() => false);
    if (ok) return true;
    await wait(350);
  }
  return false;
}

async function shot(win, name) {
  const image = await win.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`saved ${name}`);
}

function workflowFixture() {
  const node = (id, kind, title, subtitle, x, y, extra = {}) => ({
    id,
    kind,
    title,
    subtitle,
    status: kind === 'trigger' ? 'ready' : 'idle',
    x,
    y,
    retries: 1,
    timeout: 10,
    isolation: 'worktree',
    ...extra,
  });
  return {
    id: 'wf_e2e',
    name: 'M4 端到端工作流',
    updatedAt: Date.now(),
    nodes: [
      node('trigger_1', 'trigger', '手动触发', '触发器', 40, 200),
      node('agent_a', 'agent', '接口层', 'worker a', 266, 130, {
        model: 'mock-wf',
        tools: ['read', 'write'],
        prompt: '把接口说明写成 api.md。[[WRITE:api.md:# API 接口层]]',
      }),
      node('agent_b', 'agent', '页面层', 'worker b', 266, 280, {
        model: 'mock-wf',
        tools: ['read', 'write'],
        prompt: '把页面说明写成 ui.md。[[WRITE:ui.md:# 页面与交互]]',
      }),
      node('gate_1', 'gate', '人工审批门', 'Policy · 合并前确认', 500, 200),
      node('output_1', 'output', 'PR + 日报', 'Output · 结果分支', 734, 200),
    ],
    edges: [
      { id: 'e1', from: 'trigger_1', to: 'agent_a' },
      { id: 'e2', from: 'trigger_1', to: 'agent_b' },
      { id: 'e3', from: 'agent_a', to: 'gate_1' },
      { id: 'e4', from: 'agent_b', to: 'gate_1' },
      { id: 'e5', from: 'gate_1', to: 'output_1' },
    ],
  };
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
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();

  await wait(700);
  const state = {
    tasks: [
      {
        id: 'task_wf',
        title: '工作流端到端',
        branch: 'main',
        model: 'mock-wf',
        approval: 'auto',
        status: 'idle',
        at: Date.now(),
        messages: [],
        workspace,
      },
    ],
    activeId: 'task_wf',
    settings: {
      baseUrl: process.env.OLIVIA_BASE_URL,
      apiKey: '',
      model: 'mock-wf',
      approval: 'auto',
      demo: false,
      allowShell: false,
    },
  };
  await js(win, `localStorage.setItem('olivia.state.v1', ${JSON.stringify(JSON.stringify(state))}); true`);
  await js(win, `localStorage.setItem('olivia.workflow.v1', ${JSON.stringify(JSON.stringify(workflowFixture()))}); true`);
  await win.webContents.reload();
  await wait(1500);

  await js(win, `window.location.hash = '#/workflow'; true`);
  const ready = await waitFor(win, `document.querySelector('.wf-run')`, 20_000);
  console.log('workflow page ready:', ready);
  await wait(900);
  await shot(win, 'wf-canvas.png');

  await js(win, `document.querySelector('.wf-run').click(); true`);
  await wait(900);
  await shot(win, 'wf-running.png');
  console.log('panel visible:', await js(win, `Boolean(document.querySelector('.wf-runpanel'))`));

  const gateShown = await waitFor(
    win,
    `document.querySelector('.wf-runpanel') && document.querySelector('.wf-runpanel').textContent.includes('审批门：')`,
    90_000,
  );
  console.log('gate shown:', gateShown);
  await wait(700);
  await shot(win, 'wf-gate.png');

  if (gateShown) {
    await js(
      win,
      `([...document.querySelectorAll('.wf-runpanel button')].find((b) => b.textContent.includes('批准并继续'))).click(); true`,
    );
  }

  const finished = await waitFor(
    win,
    `document.querySelector('.wf-runpanel[data-run-phase="done"]')`,
    90_000,
  );
  await wait(800);
  await shot(win, 'wf-done.png');
  console.log('run finished:', finished);

  const branches = execFileSync('git', ['branch', '--list', 'olivia/wf-*'], { cwd: workspace })
    .toString()
    .split('\n')
    .map((line) => line.replace(/^\*?\s*/, '').trim())
    .filter(Boolean);
  const branch = branches.find((name) => !/-agent|-review|-merge/.test(name)) ?? branches[0] ?? '';
  console.log('branches:', branches.join(', '));
  const files = branch
    ? execFileSync('git', ['show', '--stat', '--oneline', branch], { cwd: workspace }).toString()
    : '';
  console.log(files);
  const api = branch
    ? execFileSync('git', ['show', `${branch}:api.md`], { cwd: workspace }).toString().trim()
    : '';
  const ui = branch
    ? execFileSync('git', ['show', `${branch}:ui.md`], { cwd: workspace }).toString().trim()
    : '';
  console.log('api.md:', JSON.stringify(api), 'ui.md:', JSON.stringify(ui));
  console.log('branch ok:', Boolean(branch && api.includes('API') && ui.includes('页面')));

  fs.rmSync(workspace, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  const port = await freePort();
  const server = createMockServer({ delayMs: 400 });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  process.env.OLIVIA_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.OLIVIA_API_KEY = 'sk-mock';
  process.env.OLIVIA_MODEL = 'mock-wf';
  process.env.OLIVIA_WORKSPACE = workspace;
  process.env.OLIVIA_HEADLESS = '1';

  require(path.join(root, 'apps', 'desktop', 'dist', 'main.cjs'));

  try {
    await run();
  } catch (error) {
    console.error('wf-e2e failed:', error);
    process.exitCode = 1;
  } finally {
    server.close();
    app.quit();
  }
});
