// 演示/截图用：在临时 userData 里造一个已绑仓库的计划与运行历史，打开「计划」页截图。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots-m5');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m5-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m5repo-'));
fs.writeFileSync(path.join(repo, 'README.md'), '# OliviaCode 演示仓库\n', 'utf8');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@olivia.local', 'commit', '-q', '-m', 'init'], { cwd: repo });

const now = Date.now();
const node = (id, kind, title, subtitle, x, y, extra = {}) => ({
  id, kind, title, subtitle, status: 'idle', x, y, retries: 1, timeout: 10, isolation: 'worktree', ...extra,
});
const workflow = {
  id: 'wf_demo',
  name: '夜间重构工作流',
  updatedAt: now,
  nodes: [
    node('trigger_1', 'trigger', '每晚 22:00', '触发器', 40, 220, {
      schedule: '0 22 * * *', timezone: 'Asia/Shanghai', enabled: true,
    }),
    node('agent_1', 'agent', '拆解议题', 'Planner', 266, 220, {
      model: 'deepseek-v4.1-flash', tools: ['read', 'git'], prompt: '拆解今日议题。',
    }),
    node('agent_2', 'agent', '接口与数据层', 'Coder#1', 492, 140, {
      model: 'deepseek-v4.1-flash', tools: ['read', 'write', 'patch', 'shell', 'git', 'test'], prompt: '改接口。',
    }),
    node('agent_3', 'agent', '页面与交互', 'Coder#2', 492, 300, {
      model: 'deepseek-v4.1-flash', tools: ['read', 'write', 'patch', 'shell', 'test'], prompt: '改页面。',
    }),
    node('review_1', 'reviewer', '独立评审', 'Reviewer', 718, 220, {
      model: 'qwen3.8-27b', tools: ['read', 'git'], context: 'clean', prompt: '只看 diff。',
    }),
    node('gate_1', 'gate', '人工审批门', 'Policy', 944, 220, {
      gateTimeout: 30, blockReason: '评审有未解决的高危问题，或测试未全部通过时，不允许合并。',
    }),
    node('output_1', 'output', 'PR + 日报', 'Output', 1170, 220, {
      outputKind: 'both', targetBranch: 'main',
    }),
  ],
  edges: [
    { id: 'e1', from: 'trigger_1', to: 'agent_1' },
    { id: 'e2', from: 'agent_1', to: 'agent_2' },
    { id: 'e3', from: 'agent_1', to: 'agent_3' },
    { id: 'e4', from: 'agent_2', to: 'review_1' },
    { id: 'e5', from: 'agent_3', to: 'review_1' },
    { id: 'e6', from: 'review_1', to: 'gate_1' },
    { id: 'e7', from: 'gate_1', to: 'output_1' },
  ],
};

const policy = {
  gate: 'pause-and-notify', gateTimeout: 30, maxWallMinutes: 30, maxNodes: 24, maxSteps: 80,
};

// 下次 22:00（上海）：今天还没到就算今天，否则明天
function nextAt2200(from) {
  const shanghai = new Date(from + 8 * 3600_000);
  const target = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(), 22, 0, 0) - 8 * 3600_000;
  return target > from ? target : target + 86400_000;
}

const schedule = {
  id: 'wf_demo:trigger_1',
  workflowId: 'wf_demo',
  triggerNodeId: 'trigger_1',
  workflowName: '夜间重构工作流',
  workspace: repo,
  cron: '0 22 * * *',
  timezone: 'Asia/Shanghai',
  enabled: true,
  mode: 'report',
  policy,
  workflow,
  createdAt: now - 3 * 86400_000,
  updatedAt: now,
  lastRunAt: now - 26 * 3600_000,
  lastStatus: 'done',
  nextRunAt: nextAt2200(now),
};

const paused = {
  ...schedule,
  id: 'wf_demo:trigger_2',
  triggerNodeId: 'trigger_2',
  workflowName: '每周一回归',
  cron: '30 8 * * mon',
  enabled: false,
  mode: 'report-pr',
  updatedAt: now,
  nextRunAt: undefined,
  lastRunAt: now - 2 * 86400_000,
  lastStatus: 'failed',
};

// —— 运行历史 + 报告 ——
const reportsRoot = path.join(profile, 'reports', 'wf_demo_trigger_1');
fs.mkdirSync(reportsRoot, { recursive: true });
const reportBody = (title) => `# 夜间重构工作流 · ${title}（无人值守）

- 结果：**成功**
- 计划：\`0 22 * * *\` · Asia/Shanghai · 审批门 暂停并通知
- 耗时：4m12s
- 结果分支：\`olivia/wf-demo1\`（留在本地，未推送）

## 节点

- ✅ **每晚 22:00** —— 成功：已触发
- ✅ **拆解议题** —— 成功：拆成 3 个子任务
- ✅ **接口与数据层** —— 成功：新增 /orders 接口
- ✅ **页面与交互** —— 成功：订单列表接入新接口
- ✅ **独立评审** —— 成功：必须修 0 / 建议修 2
- ✅ **人工审批门** —— 成功：已批准
- ✅ **PR + 日报** —— 成功：3 个文件 · 6 个提交

## 改动

- 写入 src/api/orders.ts（+86 −12）
- 写入 src/pages/Orders.tsx（+41 −8）
- 写入 tests/orders.test.ts（+64 −0）

## 评审

必须修：无。建议修：订单列表的空态文案与设计稿不一致；分页组件可以复用已有实现。

## 日志尾部

\`\`\`
[接口与数据层] write_file · src/api/orders.ts
[页面与交互] write_file · src/pages/Orders.tsx
[独立评审] git_diff · 全部改动
[人工审批门] 3 个提交待确认 → 已批准
\`\`\`
`;

const runs = [
  {
    id: 'run_demo_today', scheduleId: 'wf_demo:trigger_1', workflowName: '夜间重构工作流',
    workspace: repo, startedAt: now - 26 * 3600_000, endedAt: now - 26 * 3600_000 + 252_000,
    status: 'done', branch: 'olivia/wf-demo1',
    reportPath: path.join(reportsRoot, 'run_demo_today.md'),
    missed: 1, nodes: {},
  },
  {
    id: 'run_demo_yesterday', scheduleId: 'wf_demo:trigger_1', workflowName: '夜间重构工作流',
    workspace: repo, startedAt: now - 50 * 3600_000, endedAt: now - 50 * 3600_000 + 61_000,
    status: 'failed', error: '节点失败：独立评审（模型请求失败 HTTP 429）',
    reportPath: path.join(reportsRoot, 'run_demo_yesterday.md'), nodes: {},
  },
  {
    id: 'run_demo_skip', scheduleId: 'wf_demo:trigger_1', workflowName: '夜间重构工作流',
    workspace: repo, startedAt: now - 74 * 3600_000, endedAt: now - 74 * 3600_000,
    status: 'skipped', error: '上一次运行还没结束，本次跳过（不排队）', missed: 2, nodes: {},
  },
  {
    id: 'run_demo_paused', scheduleId: 'wf_demo:trigger_2', workflowName: '每周一回归',
    workspace: repo, startedAt: now - 2 * 86400_000, endedAt: now - 2 * 86400_000 + 900_000,
    status: 'failed', error: '没有识别出远程仓库，跳过 PR', nodes: {},
  },
];
fs.writeFileSync(path.join(reportsRoot, 'run_demo_today.md'), reportBody('昨天 22:00'), 'utf8');
fs.writeFileSync(path.join(reportsRoot, 'run_demo_yesterday.md'), reportBody('前天 22:00'), 'utf8');

fs.mkdirSync(path.join(profile, 'runs'), { recursive: true });
for (const run of runs) {
  fs.writeFileSync(path.join(profile, 'runs', `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}
fs.writeFileSync(
  path.join(profile, 'schedules.json'),
  JSON.stringify([schedule, paused], null, 2),
  'utf8',
);

const state = {
  tasks: [{
    id: 'task_demo', title: '验收 M5', branch: 'main', model: 'deepseek-v4.1-flash',
    approval: 'ask', status: 'done', at: now, messages: [], workspace: repo,
  }],
  activeId: 'task_demo',
  settings: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-v4.1-flash', approval: 'ask', demo: false, allowShell: true },
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
  if (!win) { await wait(1500); win = BrowserWindow.getAllWindows()[0]; }
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
  await js(`localStorage.setItem('olivia.workflow.v1', ${JSON.stringify(JSON.stringify(workflow))}); true`);
  await js(`localStorage.setItem('olivia.skin', 'lily'); true`);
  await win.webContents.reload();
  await wait(1400);
  await js(`window.location.hash = '#/schedules'; true`);
  await wait(1600);
  await js(`document.documentElement.style.setProperty('transition','none')`).catch(() => undefined);
  await shot(win, 'schedules.png');

  const probe = await js(`(() => {
    const cards = document.querySelectorAll('.sch-card').length;
    const runs = document.querySelectorAll('.sch-run').length;
    const next = document.querySelector('.sch-card-meta b');
    return JSON.stringify({ cards, runs, next: next ? next.textContent : '' });
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