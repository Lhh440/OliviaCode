// M8 视觉验收：真实 preload + 模拟主进程，截图为多提供商设置、图片输入与记忆面板。
const { app, BrowserWindow, ipcMain, nativeImage, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots-m8');
const indexHtml = path.join(root, 'apps', 'web', 'dist', 'index.html');
const preloadPath = path.join(root, 'apps', 'desktop', 'dist', 'preload.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m8-shot-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m8-ws-'));
const artifacts = path.join(profile, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const logFile = path.join(root, 'tmp-shots', 'shot-m8.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
function log(message) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  console.log(message);
}
log('boot');
process.on('uncaughtException', (error) => {
  log(`uncaught: ${error?.stack || error}`);
  app.exit(1);
});
process.on('unhandledRejection', (error) => {
  log(`unhandled: ${error?.stack || error}`);
  app.exit(1);
});

function buildPreviewPng() {
  const width = 320;
  const height = 200;
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      bitmap[offset] = Math.round(70 + (x / width) * 90);
      bitmap[offset + 1] = Math.round(90 + (y / height) * 70);
      bitmap[offset + 2] = Math.round(160 + (x / width) * 60);
      bitmap[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
}
const PNG = buildPreviewPng();
const imagePath = path.join(artifacts, 'upload_acceptance.png');
fs.writeFileSync(imagePath, PNG);

protocol.registerSchemesAsPrivileged([
  { scheme: 'olivia-artifact', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const now = Date.now();
let providers = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai-chat',
    enabled: true,
    hasKey: true,
    models: [
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', contextWindow: 128000, vision: true },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 128000 },
    ],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'local-gateway',
    name: '公司网关',
    baseUrl: 'https://llm.example.internal/v1',
    protocol: 'openai-chat',
    enabled: false,
    hasKey: false,
    models: [{ id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000, vision: true }],
    createdAt: now,
    updatedAt: now,
  },
];

const memoryFile = {
  taskId: 'task_m8',
  updatedAt: now,
  memory: {
    version: 1,
    taskId: 'task_m8',
    updatedAt: now,
    summary:
      '已把侧栏改成按状态分组，并补了空状态。测试通过；下一步把筛选入口加到分组头部，再跑一次 typecheck。',
    constraints: ['不要改 packages/core 的公开类型', '保持现有主题变量，不新增颜色'],
    decisions: ['复用现有 SelectMenu，不引第三方组件', '图片只在当前消息发送'],
    todos: [
      { text: '补筛选入口与空状态文案', status: 'open' },
      { text: '跑 npm run typecheck', status: 'open' },
    ],
    files: [
      { path: 'apps/web/src/components/Sidebar.tsx', note: '按状态分组' },
      { path: 'apps/web/src/views/Chat.tsx', note: '接入提供商模型' },
    ],
    questions: ['筛选入口要不要记忆上次选择？'],
  },
  activeCheckpointId: 'cp_2',
  checkpoints: [
    {
      id: 'cp_1',
      at: now - 8 * 60_000,
      reason: 'auto',
      beforeUsed: 108600,
      afterUsed: 3200,
      keptTurns: 2,
      droppedTurns: 6,
      usage: { input: 2100, output: 380, source: 'provider' },
      memory: {},
    },
    {
      id: 'cp_2',
      at: now - 2 * 60_000,
      reason: 'manual',
      beforeUsed: 119400,
      afterUsed: 2800,
      keptTurns: 2,
      droppedTurns: 9,
      usage: { input: 2400, output: 410, source: 'provider' },
      memory: {},
    },
  ],
};

ipcMain.on('olivia:env', (event) => {
  event.returnValue = { baseUrl: '', apiKey: '', model: '', workspace: '' };
});
ipcMain.handle('olivia:pricing.get', async () => ({ defaultContextWindow: 128000, models: {} }));
ipcMain.handle('olivia:usage.list', async () => []);
ipcMain.handle('olivia:vault.status', async () => ({ gitcode: false, github: false }));
ipcMain.handle('olivia:vault.model-status', async () => ({ saved: false, baseUrl: '', model: '' }));
ipcMain.handle('olivia:provider.list', async () => providers);
ipcMain.handle('olivia:provider.save', async (_event, draft) => {
  const existing = providers.find((item) => item.id === draft.id);
  const config = {
    ...draft,
    hasKey: existing?.hasKey ?? Boolean(draft.apiKey),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  providers = existing ? providers.map((item) => (item.id === draft.id ? config : item)) : [...providers, config];
  return { ok: true, providers };
});
ipcMain.handle('olivia:provider.enable', async (_event, args) => {
  providers = providers.map((item) => (item.id === args.id ? { ...item, enabled: args.enabled } : item));
  return { ok: true, providers };
});
ipcMain.handle('olivia:provider.remove', async (_event, id) => {
  providers = providers.filter((item) => item.id !== id);
  return { ok: true, providers };
});
ipcMain.handle('olivia:provider.fetch-models', async () => ({
  ok: true,
  models: ['deepseek-v4.1-flash', 'deepseek-reasoner', 'deepseek-coder-v3'],
}));
ipcMain.handle('olivia:attachment.save', async () => ({
  ok: true,
  attachment: {
    id: 'img_acceptance',
    path: imagePath,
    mime: 'image/png',
    width: 320,
    height: 200,
    bytes: PNG.length,
    sha256: 'acceptance',
    source: 'paste',
    createdAt: now,
  },
}));
ipcMain.handle('olivia:attachment.adopt', async (_event, args) => ({
  ok: true,
  attachment: {
    id: 'img_adopt',
    path: args.filePath,
    mime: 'image/png',
    width: 320,
    height: 200,
    bytes: PNG.length,
    sha256: 'adopt',
    source: args.source ?? 'preview',
    createdAt: now,
  },
}));
ipcMain.handle('olivia:turn.start', async (event, args) => {
  setTimeout(() => {
    event.sender.send('olivia:turn.event', {
      taskId: args.taskId,
      turnId: args.turnId,
      event: { type: 'turn.done', ok: true },
    });
  }, 350);
  return { ok: true };
});
ipcMain.handle('olivia:task.load', async () => ({ taskId: 'task_m8', events: [] }));
ipcMain.handle('olivia:memory.get', async () => memoryFile);
ipcMain.handle('olivia:memory.compact', async () => ({ ok: true, file: memoryFile }));
ipcMain.handle('olivia:memory.revert', async () => ({ ok: true, file: memoryFile }));
ipcMain.handle('olivia:memory.clear', async () => ({ ok: true }));
ipcMain.handle('olivia:memory.clear-all', async () => ({ ok: true }));

app.disableHardwareAcceleration();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(win, name, ms = 500) {
  await wait(ms);
  const image = await win.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`saved ${name}`);
}

async function clickByText(win, text, selector = 'button') {
  return await win.webContents.executeJavaScript(`
    (() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const target = nodes.find((node) => (node.textContent || '').trim() === ${JSON.stringify(text)})
        || nodes.find((node) => (node.textContent || '').includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
}

async function open(win, hash, ms = 1400) {
  log(`load ${hash}`);
  await win.loadFile(indexHtml, { hash, query: { r: String(Date.now()) } });
  await wait(ms);
  log(`loaded ${hash}`);
}

app.whenReady().then(async () => {
  log('ready');
  protocol.handle('olivia-artifact', async (request) => {
    const url = new URL(request.url);
    const file = path.join(artifacts, path.basename(decodeURIComponent(url.pathname)));
    const buffer = await fs.promises.readFile(file);
    return new Response(buffer, { headers: { 'content-type': 'image/png' } });
  });

  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    show: false,
    backgroundColor: '#0a0e12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  win.setPosition(-2600, 0);
  win.showInactive();
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log('[page]', String(message).slice(0, 200));
  });

  await win.loadFile(indexHtml, { hash: '/settings' });
  await wait(500);
  await win.webContents.executeJavaScript('localStorage.removeItem("olivia.state.v1"); true');
  await open(win, '/settings', 1600);
  await shot(win, 'settings-providers.png');

  await clickByText(win, '编辑', 'button');
  await wait(500);
  await shot(win, 'provider-dialog.png');

  const seededState = JSON.stringify({
    activeId: 'task_m8',
    settings: {
      baseUrl: '',
      apiKey: '',
      model: 'deepseek-v4.1-flash',
      providerId: 'deepseek',
      approval: 'ask',
      demo: false,
      allowShell: false,
      defaultContextWindow: 128000,
      compactThreshold: 85,
    },
    tasks: [
      {
        id: 'task_m8',
        title: '侧栏分组与图片反馈',
        branch: 'main',
        model: 'deepseek-v4.1-flash',
        providerId: 'deepseek',
        approval: 'ask',
        status: 'done',
        at: now,
        workspace,
        messages: [],
        usage: [],
      },
    ],
  });
  await win.webContents.executeJavaScript(
    `localStorage.setItem('olivia.state.v1', ${JSON.stringify(seededState)}); true;`,
  );

  await open(win, '/chat', 1500);
  await shot(win, 'chat-welcome.png');

  await win.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('button[aria-label="模型"]');
      if (button) button.click();
      return Boolean(button);
    })()
  `);
  await wait(350);
  await shot(win, 'model-menu.png');
  await win.webContents.executeJavaScript(
    'document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); true',
  );
  await wait(250);

  // 真实 DOM 拖入一张图片，走 preload.attachments.save → 附件托盘。
  const dropped = await win.webContents.executeJavaScript(`
    (() => {
      const composer = document.querySelector('.composer');
      if (!composer) return 'no-composer';
      const bytes = Uint8Array.from(atob('${PNG.toString('base64')}'), (char) => char.charCodeAt(0));
      const file = new File([bytes], 'button-preview.png', { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return 'dropped';
    })()
  `);
  console.log('drop:', dropped);
  await wait(900);
  await shot(win, 'composer-attachments.png');

  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = [...document.querySelectorAll('button')];
      const send = buttons.find((button) => button.title === '发送');
      if (send) send.click();
      return Boolean(send);
    })()
  `);
  await wait(1000);
  await shot(win, 'user-image-message.png');

  await win.webContents.executeJavaScript(`
    (() => {
      const open = [...document.querySelectorAll('button')].find((button) =>
        (button.title || '').includes('查看上下文构成'),
      );
      if (open) open.click();
      return Boolean(open);
    })()
  `);
  await wait(400);
  await clickByText(win, '记忆', 'button');
  await wait(450);
  await shot(win, 'memory-panel.png');

  app.quit();
});

app.on('window-all-closed', () => app.quit());
