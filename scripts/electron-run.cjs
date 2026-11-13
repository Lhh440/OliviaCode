// Electron 启动垫片（scripts/*.cjs 用 npm run 调起）。
//
// 为什么需要它：某些环境（含本仓库的 CI/沙箱）会把 ELECTRON_RUN_AS_NODE=1 设进进程环境，
// 此时 electron.exe 会以纯 Node 模式运行，`require('electron').app` 是 undefined，
// 截图 / e2e 脚本会直接崩在 app.setPath。这里显式清掉这些变量再启动真正的 Electron。
const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');
const target = process.argv[2];
if (!target) {
  console.error('用法：node scripts/electron-run.cjs <脚本路径> [参数…]');
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const binary = typeof electron === 'string' ? electron : path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(binary, [path.resolve(target), ...process.argv.slice(3)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('error', (error) => {
  console.error('Electron 启动失败：', error.message);
  process.exit(1);
});
child.on('close', (code, signal) => {
  if (signal) console.error(`Electron 被信号 ${signal} 终止`);
  process.exit(code ?? 1);
});