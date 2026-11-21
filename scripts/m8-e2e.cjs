// M8 端到端：真实主进程 + 真实 preload + mock 视觉端点。
// 覆盖：提供商保存/密钥 → 图片附件 → turn.start 解析 provider → content parts → 日志 → 手动整理。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m8-e2e-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m8-e2e-ws-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
fs.writeFileSync(path.join(workspace, 'README.md'), '# M8 e2e workspace\n', 'utf8');

process.env.OLIVIA_HEADLESS = '1';
process.env.OLIVIA_WORKSPACE = workspace;
delete process.env.OLIVIA_API_KEY;
delete process.env.OLIVIA_BASE_URL;

const { createMockServer } = require('./mock-llm.cjs');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function runInWindow(win, code) {
  return await win.webContents.executeJavaScript(code);
}

async function main() {
  const server = createMockServer({ vision: true, usage: 'full', delayMs: 5 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  require(path.join(root, 'apps', 'desktop', 'dist', 'main.cjs'));

  let win = null;
  for (let attempt = 0; attempt < 120 && !win; attempt += 1) {
    await wait(250);
    win = BrowserWindow.getAllWindows()[0] ?? null;
  }
  if (!win) throw new Error('主窗口没有出现');
  await wait(1200);

  const taskId = `task_m8_e2e_${Date.now()}`;
  const provider = {
    id: 'mock-e2e',
    name: 'Mock Vision',
    baseUrl,
    protocol: 'openai-chat',
    models: [{ id: 'mock-wf', label: 'Mock Vision', contextWindow: 128000, vision: true }],
    apiKey: 'sk-test',
  };

  const saved = await runInWindow(
    win,
    `(async () => {
      const result = await window.olivia.provider.save(${JSON.stringify(provider)});
      const list = await window.olivia.provider.list();
      return { result, list };
    })()`,
  );
  check('provider saved through real IPC', saved.result.ok === true, JSON.stringify(saved.result));
  const stored = saved.list.find((item) => item.id === 'mock-e2e');
  check('provider has encrypted key marker', stored?.hasKey === true);
  check('provider config is returned to renderer', stored?.models?.[0]?.vision === true);

  const upload = await runInWindow(
    win,
    `(async () => {
      const result = await window.olivia.attachments.save({
        dataUrl: 'data:image/png;base64,${PNG.toString('base64')}',
        name: 'button.png',
        source: 'paste',
      });
      return result;
    })()`,
  );
  check('attachment saved and re-encoded', upload.ok === true, JSON.stringify(upload));
  check('attachment is an image with dimensions', upload.attachment?.width > 0 && upload.attachment?.height > 0);

  const turn = await runInWindow(
    win,
    `(async () => {
      const events = [];
      let text = '';
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const off = window.olivia.turn.onEvent((envelope) => {
        if (envelope.taskId !== ${JSON.stringify(taskId)}) return;
        events.push(envelope.event);
        if (envelope.event.type === 'text') text += envelope.event.delta;
        if (envelope.event.type === 'turn.done') { off(); resolveDone(); }
      });
      const started = await window.olivia.turn.start({
        turnId: 'turn_m8_e2e',
        taskId: ${JSON.stringify(taskId)},
        workspace: ${JSON.stringify(workspace)},
        prompt: '这张图里是什么？',
        model: 'mock-wf',
        providerId: 'mock-e2e',
        attachments: [${JSON.stringify(upload.attachment)}],
        compactThreshold: 85,
        approval: 'never',
        allowShell: false,
        history: [],
      });
      if (!started.ok) { off(); return { started, events, text: '' }; }
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 15000))]);
      return { started, events, text };
    })()`,
  );
  check('turn.start accepted provider + attachment', turn.started.ok === true, JSON.stringify(turn.started));
  check('turn produced model text', turn.text.includes('看到 1 张图'), turn.text.slice(0, 120));
  check('turn.done emitted', turn.events.some((event) => event.type === 'turn.done' && event.ok));
  const usage = turn.events.find((event) => event.type === 'usage')?.usage;
  const imagePart = usage?.context?.parts?.find((part) => part.key === 'images');
  check('usage accounts image tokens', (imagePart?.tokens ?? 0) > 0, JSON.stringify(imagePart));

  const log = await runInWindow(
    win,
    `window.olivia.task.load(${JSON.stringify(taskId)}).then((payload) => payload.events)`,
  );
  const userMessage = log.find((event) => event.type === 'user.message');
  check('session log stores attachment metadata', userMessage?.attachments?.[0]?.id === upload.attachment.id);
  check('session log never stores base64', !JSON.stringify(log).includes(PNG.toString('base64').slice(0, 24)));

  const compact = await runInWindow(
    win,
    `window.olivia.memory.compact({
      taskId: ${JSON.stringify(taskId)},
      providerId: 'mock-e2e',
      model: 'mock-wf',
    })`,
  );
  check('manual compaction succeeds through main', compact.ok === true, JSON.stringify(compact));
  check('checkpoint carries memory snapshot', compact.file?.checkpoints?.length === 1);
  check('memory has summary', (compact.file?.memory?.summary ?? '').includes('mock 摘要'));

  const memory = await runInWindow(win, `window.olivia.memory.get(${JSON.stringify(taskId)})`);
  check('memory persisted', memory?.memory?.summary === compact.file?.memory?.summary);
  check('active checkpoint recorded', Boolean(memory?.activeCheckpointId));

  await runInWindow(win, `window.olivia.memory.clear(${JSON.stringify(taskId)})`);
  const cleared = await runInWindow(win, `window.olivia.memory.get(${JSON.stringify(taskId)})`);
  check('explicit clear is not resurrected from old log', !cleared?.memory?.summary && cleared?.checkpoints?.length === 0);

  const removed = await runInWindow(win, `window.olivia.provider.remove('mock-e2e')`);
  check('provider remove clears config', removed.ok === true && !removed.providers.some((item) => item.id === 'mock-e2e'));
  await runInWindow(win, `window.olivia.memory.clear(${JSON.stringify(taskId)})`);

  server.close();
  console.log(`\nM8 e2e: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  app.quit();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
