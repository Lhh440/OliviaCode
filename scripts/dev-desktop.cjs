// 桌面端开发一键启动：`npm run dev:desktop`
//
// 以前每次都要手动两步：先 `npm run dev:web` 起 Vite，再
// `OLIVIA_DEV=1 node scripts/electron-run.cjs apps/desktop`。这是每天按十次的按钮，
// 所以收成一个脚本：先拉起 Vite，等 5273 端口真的能连上，再启动 Electron；
// 任一进程退出就把另一个一起收掉，不留孤儿 Vite 占端口。
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const DEV_URL = process.env.OLIVIA_DEV_URL || 'http://127.0.0.1:5273';
const HOST = '127.0.0.1';
const PORT = Number(new URL(DEV_URL).port || 5273);
const WAIT_MS = 30_000;

const children = [];

function shutdown(code) {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {
        // 退出阶段的失败不值得再报错
      }
    }
  }
  process.exit(code);
}

function waitForPort(timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: HOST, port: PORT });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`${HOST}:${PORT} 在 ${Math.round(timeoutMs / 1000)}s 内没起来`));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

const vite = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:web'], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false,
});
children.push(vite);
vite.on('close', (code) => {
  if (code) console.error(`[dev:desktop] vite 退出（${code}）`);
  shutdown(code ?? 0);
});

waitForPort(WAIT_MS)
  .then(() => {
    console.log(`[dev:desktop] Vite 就绪：${DEV_URL}，启动 Electron…`);
    const electron = spawn(
      process.execPath,
      [path.join(__dirname, 'electron-run.cjs'), 'apps/desktop'],
      {
        stdio: 'inherit',
        env: { ...process.env, OLIVIA_DEV: '1', OLIVIA_DEV_URL: DEV_URL },
        windowsHide: false,
      },
    );
    children.push(electron);
    electron.on('close', (code) => shutdown(code ?? 0));
  })
  .catch((error) => {
    console.error(`[dev:desktop] ${error.message}`);
    console.error(
      `[dev:desktop] 端口可能被上次没关干净的 Vite 占着：先 npx kill-port ${PORT}，或改 OLIVIA_DEV_URL。`,
    );
    shutdown(1);
  });

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
