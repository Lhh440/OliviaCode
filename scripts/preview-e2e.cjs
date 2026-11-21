// M7 · 内置预览的无头 smoke：真实 WebContentsView + 本地 HTTP 页面。
// 用法：node scripts/electron-run.cjs scripts/preview-e2e.cjs
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { PreviewHost } = require(path.join(root, 'apps', 'desktop', 'dist', 'preview-host.cjs'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.disableHardwareAcceleration();

async function main() {
  const server = http.createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><title>Preview Fixture</title><a id="go" href="/next">next</a><h1>hello preview</h1>',
      );
      return;
    }
    if (request.url === '/next') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Next Page</title><p>next</p>');
      return;
    }
    response.writeHead(404).end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-preview-'));
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    backgroundColor: '#0b0f14',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  window.setPosition(40, 40);
  window.showInactive();
  await window.loadURL('data:text/html,<title>host</title>host');

  const states = [];
  const host = new PreviewHost({
    window,
    artifactsDir,
    log: (line) => console.log('[preview]', line),
    onState: (state) => states.push(state),
  });

  const bounds = { x: 40, y: 40, width: 720, height: 560, visible: true };
  host.setBounds(bounds);
  host.open({ taskId: 'selftest', url: `http://127.0.0.1:${port}/`, bounds });
  await wait(1800);

  const first = states[states.length - 1];
  assert.ok(first, '应该收到预览状态');
  assert.match(first.url, /^http:\/\/127\.0\.0\.1/);
  assert.match(first.title, /Preview Fixture/);
  assert.equal(first.external, false);
  assert.equal(first.error, undefined);

  // 页内一样可以导航到 loopback
  host.navigate(`http://127.0.0.1:${port}/next`);
  await wait(1200);
  const second = states[states.length - 1];
  assert.match(second.url, /\/next$/);
  assert.match(second.title, /Next Page/);
  assert.equal(second.canGoBack, true);
  host.back();
  await wait(900);

  // 外部站点：先挂起等确认（离线只验证拦截，不真的连外网）
  host.navigate('https://example.com/');
  await wait(300);
  const pending = states[states.length - 1];
  assert.equal(pending.pendingExternal, 'https://example.com/');
  host.navigate(`http://127.0.0.1:${port}/next`);
  await wait(900);
  assert.equal(states[states.length - 1].pendingExternal, undefined);

  // 危险协议：拒绝
  host.navigate('file:///C:/windows/win.ini');
  await wait(300);
  const denied = states[states.length - 1];
  assert.ok(denied.error, 'file:// 应该被拒绝');
  assert.match(denied.error, /只打开 http/);

  // 截图：无头离屏环境可能没有可截取的显示表面，只在成功时校验 PNG 头
  await wait(600);
  const shot = await host.capture();
  if (shot.ok) {
    assert.ok(shot.path && fs.existsSync(shot.path));
    const png = fs.readFileSync(shot.path);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    console.log('[preview] 截图已生成', shot.path);
  } else {
    console.log('[preview] 当前环境无法截图（可见窗口下才有显示表面）：', shot.error);
  }

  host.close();
  await wait(200);
  const closed = states[states.length - 1];
  assert.equal(closed.closed, true);
  host.destroy();
  window.destroy();
  server.close();
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  console.log('preview-e2e: 通过');
}

app
  .whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error('preview-e2e failed:', error);
    app.exit(1);
  });

// 用 setTimeout 兜底，避免无头环境下事件循环挂死
setTimeout(() => {
  console.error('preview-e2e timeout');
  app.exit(1);
}, 40_000).unref();
