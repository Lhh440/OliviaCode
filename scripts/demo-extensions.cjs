// M6 截图/演示：挂一个 mock MCP 服务器与一个已启用的团队技能，打开「扩展」页截图。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots-m6');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m6-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m6repo-'));
fs.writeFileSync(path.join(repo, 'README.md'), '# M6 演示仓库\n', 'utf8');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@olivia.local', 'commit', '-q', '-m', 'init'], { cwd: repo });

// —— 技能：写进仓库 .olivia/skills，并生成 lock 与启用状态 ——
const skillDir = path.join(repo, '.olivia', 'skills', 'review-rules');
fs.mkdirSync(path.join(skillDir, 'templates'), { recursive: true });
fs.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  `---
name: review-rules
description: 按团队规范评审改动：只看正确性与安全，按严重程度排序
version: 1.2.0
tools: read_file, search, git_diff
---

# 评审规则

1. 先看 \`git diff\`，再给结论；不要相信实现者的自述。
2. 只报**正确性**与**安全**问题，按「必须修 / 建议修 / 可以通过」三档。
3. 每条都要给文件与行号。
`,
  'utf8',
);
fs.writeFileSync(
  path.join(skillDir, 'olivia-skill.json'),
  JSON.stringify(
    {
      schema: 1,
      name: 'review-rules',
      version: '1.2.0',
      description: '按团队规范评审改动：只看正确性与安全，按严重程度排序',
      requires: { tools: ['read_file', 'search', 'git_diff'], shell: false },
    },
    null,
    2,
  ),
  'utf8',
);
fs.writeFileSync(path.join(skillDir, 'templates', 'checklist.md'), '- [ ] 错误分支\n- [ ] 权限校验\n', 'utf8');

function hashDir(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  const joined = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, hash]) => `${rel}:${hash}`)
    .join('\n');
  return { hash: crypto.createHash('sha256').update(joined).digest('hex'), files };
}

const lock = hashDir(skillDir);
fs.writeFileSync(
  path.join(skillDir, '.olivia-lock.json'),
  JSON.stringify({ version: 1, installedAt: Date.now(), hash: lock.hash, files: lock.files }, null, 2),
  'utf8',
);
fs.writeFileSync(
  path.join(profile, 'skill-state.json'),
  JSON.stringify(
    { [path.resolve(repo).toLowerCase()]: { 'review-rules': { hash: lock.hash, enabled: true, confirmedAt: Date.now() } } },
    null,
    2,
  ),
  'utf8',
);

// —— MCP：mock 服务器（现代协议，7 个工具），勾选两个 ——
const mcpConfig = [
  {
    id: 'demo-fs',
    name: '演示 MCP · 本地工具',
    transport: 'stdio',
    enabled: true,
    command: 'node',
    args: [path.join(root, 'scripts', 'mock-mcp.cjs'), '--modern', '--tools', '7'],
    timeoutMs: 15000,
    risks: { echo: 'exec', add: 'read' },
    createdAt: Date.now(),
  },
];
fs.writeFileSync(path.join(profile, 'mcp.json'), JSON.stringify(mcpConfig, null, 2), 'utf8');

const state = {
  tasks: [
    {
      id: 'task_m6',
      title: '验收 M6',
      branch: 'main',
      model: 'deepseek-v4.1-flash',
      approval: 'ask',
      status: 'done',
      at: Date.now(),
      messages: [],
      workspace: repo,
    },
  ],
  activeId: 'task_m6',
  settings: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-v4.1-flash',
    approval: 'ask',
    demo: false,
    allowShell: true,
  },
};

ipcMain.on('olivia:env', (event) => {
  event.returnValue = { baseUrl: '', apiKey: '', model: '', workspace: repo };
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(win, name) {
  const image = await win.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log('saved', name);
}

async function run() {
  await wait(1500);
  let win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    await wait(1500);
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('没有拿到窗口');
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[page]', String(message).slice(0, 200));
  });

  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`localStorage.setItem('olivia.state.v1', ${JSON.stringify(JSON.stringify(state))}); true`);
  await js(`localStorage.setItem('olivia.skin', 'lily'); true`);
  await win.webContents.reload();
  await wait(1600);
  await js(`window.location.hash = '#/extensions'; true`);
  await wait(2600);
  await shot(win, 'extensions.png');

  const probe = await js(`(() => {
    const cards = [...document.querySelectorAll('.ext-card-main b')].map((el) => el.textContent);
    const tools = document.querySelectorAll('.ext-tool').length;
    const checked = document.querySelectorAll('.ext-tool input:checked').length;
    const skills = [...document.querySelectorAll('.ext-skill-name')].map((el) => el.textContent);
    const enabled = [...document.querySelectorAll('.ext-toggle input')].filter((el) => el.checked).length;
    return JSON.stringify({ cards, tools, checked, skills, enabled });
  })()`);
  console.log('PROBE:', probe);
}

app.whenReady().then(async () => {
  process.env.OLIVIA_WORKSPACE = repo;
  process.env.OLIVIA_HEADLESS = '1';
  require(path.join(root, 'apps', 'desktop', 'dist', 'main.cjs'));
  try {
    await run();
  } catch (error) {
    console.error('demo failed:', error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});