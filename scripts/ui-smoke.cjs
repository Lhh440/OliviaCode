// 界面冒烟：无头加载打包后的页面，用 DOM 断言检查几条「承诺与实现一致」的契约。
//
// 为什么不截图：截图依赖可见窗口，某些环境（无交互式桌面）会卡住；
// 这里只读 DOM 文案与结构，跑得快、也不占用临时目录。
// 用法：node scripts/electron-run.cjs scripts/ui-smoke.cjs
//   —— 也可 npm run smoke:ui（先 build:web）
const { app, BrowserWindow } = require('electron');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');
// 主进程 stdout 在某些宿主上会被吞掉，日志同时留一份文件保底
const logFile = path.join(os.tmpdir(), 'olivia-ui-smoke.log');
fs.writeFileSync(logFile, '');
const log = (line) => {
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

app.disableHardwareAcceleration();

async function main() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) log(`[page] ${String(msg).slice(0, 200)}`);
  });

  const js = (code) => win.webContents.executeJavaScript(code);

  await win.loadFile(indexHtml, { hash: '/chat' });
  await wait(700);
  await js('localStorage.clear(); localStorage.setItem("olivia.theme.v4","koi-dark"); true');
  await win.loadFile(indexHtml, { hash: '/chat', query: { r: '1' } });
  await wait(1500);

  const chat = await js(`(() => {
    const text = document.body.innerText;
    const ta = document.querySelector('.composer textarea');
    const moreBtn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '更多');
    return {
      placeholder: ta ? ta.placeholder : '',
      demoGroup: text.includes('示例 · 演示数据'),
      demoBadge: (text.match(/(^|\\n)示例(\\n|$)/g) || []).length,
      hasMore: Boolean(moreBtn),
      hasCtrlN: text.includes('Ctrl+N'),
      milestone: text.includes('M8 · 记忆与图片'),
      version: text.includes('v0.10.0'),
      branchWhenUnbound: /还没有绑定工作区/.test(text),
    };
  })()`);

  check('C1 占位符不再承诺 / 与 @', !chat.placeholder.includes('调用指令') && !chat.placeholder.includes('@ 文件'), chat.placeholder);
  check('C2 示例任务单独分组', chat.demoGroup === true);
  check('C3 示例任务带 badge', chat.demoBadge >= 1, `${chat.demoBadge}`);
  check('C4 页头「更多」按钮存在', chat.hasMore === true);
  check('C5 快捷键按平台显示 Ctrl+N', chat.hasCtrlN === true);
  check('C6 侧栏不再挂 M8 里程碑名', chat.milestone === false);
  check('C7 侧栏显示版本号', chat.version === true);

  // 打开「更多」菜单，读出菜单项
  await js(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '更多');
    btn.click();
    return true;
  })()`);
  await wait(400);
  const menu = await js(`[...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent.trim())`);
  check('C8 菜单挂上真功能', menu.length === 4 && menu.some((t) => t.includes('回滚上一次写入')), menu.join(' / '));

  // 关闭菜单，进任务详情看状态徽章
  await js('document.body.click(); true');
  await wait(300);

  // 工作流：缩放下限 + 触发器 cron
  await win.loadFile(indexHtml, { hash: '/workflow', query: { r: '2' } });
  await wait(1600);
  const wf = await js(`(() => {
    const zoom = document.querySelector('.zoom-value')?.textContent ?? '';
    const hasInvalid = document.body.innerText.includes('无效');
    return { zoom, hasInvalid };
  })()`);
  check('C9 画布默认缩放 ≥ 75%', Number(wf.zoom.replace('%', '')) >= 75, wf.zoom);

  const trig = await js(`(() => {
    const nodes = [...document.querySelectorAll('.wf-node')];
    const target = nodes.find((n) => (n.textContent || '').includes('触发器'));
    if (!target) return { found: false, nodes: nodes.length };
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return { found: true, nodes: nodes.length };
  })()`);
  await wait(600);
  const cronInput = await js(`(() => {
    const all = [...document.querySelectorAll('.wf-inspector input')];
    const hit = all.find((i) => /cron/i.test(i.closest('label')?.textContent || ''));
    const draft = JSON.parse(localStorage.getItem('olivia.workflow.v1') || '{}');
    const seedCron = (draft.nodes || []).find((n) => n.kind === 'trigger')?.schedule ?? '';
    return { value: hit ? hit.value : '', hasHint: document.body.innerText.includes('每天 22:00'), seedCron };
  })()`);
  check('C10 选中触发器节点', trig.found === true, `${trig.nodes ?? 0} 个节点`);
  check(
    'C11 触发器 cron 是标准 5 段',
    /^\S+ \S+ \S+ \S+ \S+$/.test(cronInput.value || cronInput.seedCron),
    cronInput.value || `草稿里是 ${cronInput.seedCron}`,
  );
  check('C12 cron 有人话预览', cronInput.hasHint === true);

  // 浏览器预览里跑一遍工作流：不能卡在「执行中…」，审批门要能继续
  const clickRun = () =>
    js(`(() => {
      const btn = document.querySelector('.wf-run');
      if (!btn) return 'missing';
      btn.click();
      return btn.textContent.trim();
    })()`);
  await clickRun();
  await wait(6000);
  const gateState = await js(`(() => ({
    button: document.querySelector('.wf-run')?.textContent.trim() ?? '',
    panel: Boolean(document.querySelector('.wf-runpanel')),
    phase: document.querySelector('.wf-runpanel')?.getAttribute('data-run-phase') ?? '',
    gateVisible: /审批门/.test(document.body.innerText),
  }))()`);
  check('C15 演示运行进入审批门而不是卡死', gateState.button.includes('批准并继续') && gateState.phase === 'waiting', `${gateState.button} / ${gateState.phase}`);
  check('C16 运行面板可见', gateState.panel === true);

  await clickRun();
  await wait(4000);
  const afterApprove = await js(`(() => ({
    button: document.querySelector('.wf-run')?.textContent.trim() ?? '',
    phase: document.querySelector('.wf-runpanel')?.getAttribute('data-run-phase') ?? '',
  }))()`);
  check(
    'C17 批准后跑完且按钮恢复',
    afterApprove.phase === 'done' && afterApprove.button.includes('运行工作流'),
    `${afterApprove.button} / ${afterApprove.phase}`,
  );

  await win.loadFile(indexHtml, { hash: '/schedules', query: { r: '3' } });
  await wait(1200);
  const sch = await js(`(() => {
    const text = document.body.innerText;
    return { desktopOnly: text.includes('只在桌面端可用'), invalid: text.includes('无效') };
  })()`);
  check('C13 浏览器计划页给出明确说明', sch.desktopOnly === true);
  check('C14 计划页不再出现「无效」记录', sch.invalid === false);

  const failed = checks.filter((c) => !c.ok).length;
  log(`\nUI 探针：${checks.length - failed}/${checks.length} 通过`);
  return failed === 0 ? 0 : 1;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (error) {
    log(`[异常] ${error && error.stack ? error.stack : error}`);
  }
  app.exit(code);
});
