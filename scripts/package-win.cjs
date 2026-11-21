// 打 Windows 安装包：把 Electron 运行时 + 构建产物拼成便携目录，压缩成载荷，
// 再用系统自带的 csc 把载荷焊进一个自解压安装器。
//
// 为什么不用 electron-builder：这台机器离线，装不了依赖；csc + ZipArchive 都是系统自带的。
// 产出：release/OliviaCode0.1版.exe
//
// 用法：npm run package:win   （会先确保 web/main 已经构建过）
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');
const stageDir = path.join(releaseDir, 'stage');
const payloadZip = path.join(releaseDir, 'payload.zip');
const installerOut = path.join(releaseDir, 'OliviaCode0.1版.exe');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const webDist = path.join(root, 'apps', 'web', 'dist');
const mainDist = path.join(root, 'apps', 'desktop', 'dist');
const iconIco = path.join(root, 'build', 'icon.ico');
const iconPng = path.join(root, 'build', 'icon.png');
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

function sizeOf(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(full) : fs.statSync(full).size;
  }
  return total;
}

// —— 0. 前置检查 ——
if (!fs.existsSync(path.join(webDist, 'index.html'))) fail('缺少 apps/web/dist，先跑 npm run build:web');
if (!fs.existsSync(path.join(mainDist, 'main.cjs'))) fail('缺少 apps/desktop/dist，先跑 npm run build:main');
if (!fs.existsSync(electronDist)) fail('缺少 node_modules/electron/dist，先 npm install');
if (!fs.existsSync(iconIco)) fail('缺少 build/icon.ico，先 powershell -File scripts/build-icon.ps1');
if (!fs.existsSync(csc)) fail(`找不到 csc.exe：${csc}`);

// —— 1. 拼便携目录 ——
console.log('[package] 组装运行时…');
fs.rmSync(stageDir, { recursive: true, force: true });
copyDir(electronDist, stageDir);

// electron.exe 改名成产品名；resources/default_app.asar 换成本应用
const exeFrom = path.join(stageDir, 'electron.exe');
const exeTo = path.join(stageDir, 'OliviaCode.exe');
if (fs.existsSync(exeTo)) fs.rmSync(exeTo);
fs.renameSync(exeFrom, exeTo);
fs.rmSync(path.join(stageDir, 'resources', 'default_app.asar'), { force: true });

const appDir = path.join(stageDir, 'resources', 'app');
fs.mkdirSync(path.join(appDir, 'desktop'), { recursive: true });
// 主进程按 __dirname/../../web/dist 找页面，所以放成 app/desktop + app/web/dist
for (const file of fs.readdirSync(mainDist)) {
  if (!file.endsWith('.cjs')) continue;
  fs.copyFileSync(path.join(mainDist, file), path.join(appDir, 'desktop', file));
}
copyDir(webDist, path.join(appDir, 'web', 'dist'));
fs.copyFileSync(iconPng, path.join(appDir, 'desktop', 'icon.png'));

// name 决定 userData 目录：这里故意沿用开发态的 "@olivia/desktop"，
// 装完直接能看到已有的任务、提供商与用量账本，而不是一个空壳。
// （productName 一旦设置，Electron 会另起 %APPDATA%\OliviaCode，反而不接续。）
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: '@olivia/desktop',
      version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      description: 'OliviaCode 桌面端',
      main: 'desktop/main.cjs',
      private: true,
    },
    null,
    2,
  )}\n`,
);

console.log(`[package] 便携目录 ${(sizeOf(stageDir) / 1024 / 1024).toFixed(1)} MB`);

// —— 2. 压缩成载荷 ——
console.log('[package] 压缩载荷…');
if (fs.existsSync(payloadZip)) fs.rmSync(payloadZip);
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${stageDir}', '${payloadZip}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`,
  ],
  { stdio: 'inherit' },
);
console.log(`[package] 载荷 ${(fs.statSync(payloadZip).size / 1024 / 1024).toFixed(1)} MB`);

// —— 3. 编译安装器（载荷作为资源内嵌） ——
console.log('[package] 编译安装器…');
if (fs.existsSync(installerOut)) fs.rmSync(installerOut);
const sources = ['Installer.cs', 'SetupForm.cs'].map((name) => path.join(root, 'scripts', 'installer', name));
execFileSync(
  csc,
  [
    '/nologo',
    '/target:winexe',
    '/codepage:65001',
    `/win32icon:${iconIco}`,
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.IO.Compression.dll',
    '/r:System.IO.Compression.FileSystem.dll',
    '/r:Microsoft.CSharp.dll',
    `/resource:${payloadZip},payload.zip`,
    `/out:${installerOut}`,
    ...sources,
  ],
  { stdio: 'inherit' },
);

const installerSize = fs.statSync(installerOut).size / 1024 / 1024;
console.log(`[package] 完成：${installerOut} (${installerSize.toFixed(1)} MB)`);
fs.rmSync(stageDir, { recursive: true, force: true });
// 迭代调试时用 --keep-payload 留着载荷，省一次 2 分钟的压缩
if (process.argv.includes('--keep-payload') || process.env.OLIVIA_KEEP_PAYLOAD === '1') {
  console.log(`[package] 保留载荷：${payloadZip}`);
} else {
  fs.rmSync(payloadZip, { force: true });
}
