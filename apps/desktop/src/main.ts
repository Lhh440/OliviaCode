import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, protocol, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import {
  ToolRegistry,
  estimateImageTokens,
  estimateTokens,
  measureContext,
  normalizeAttachments,
  providerKeyName,
  providerModelKey,
  resolveContextWindow,
  validateProviderDraft,
  type ApprovalDecision,
  type ContextCheckpoint,
  type GitProvider,
  type ImageAttachment,
  type McpRisk,
  type McpServerConfig,
  type ModelOverride,
  type ModelPricing,
  type PatchDecision,
  type PreviewState,
  type PricingFile,
  type ProviderConfig,
  type ProviderDraft,
  type RunRecord,
  type ScheduleRecord,
  type SchedulerEvent,
  type TaskMemoryFile,
  type TurnEnvelope,
  type TurnEvent,
  type TurnStartArgs,
  type UnattendedPolicy,
  type UsageRecord,
  type WorkflowRunArgs,
  type WorkflowRunEvent,
} from '@olivia/core';
import { SnapshotStore, type Policy } from '@olivia/exec';
import { requestMemoryDraft, runAgentTurn } from './agent';
import { AttachmentService } from './attachments';
import { MemoryStore } from './memory-store';
import { ProviderStore } from './provider-store';
import { fetchProviderModels, testProviderConnection } from './provider-test';
import {
  checkout,
  clone,
  commit,
  createBranch,
  conflicts,
  isRepo,
  parseRemote,
  pull,
  push,
  readBranches,
  readFileDiff,
  readLog,
  readStatus,
  stageHunks,
  stagePaths,
  unstagePaths,
} from './git';
import { McpManager } from './mcp-manager';
import { PricingStore } from './pricing-store';
import { PreviewHost, type PreviewBounds } from './preview-host';
import { createPullRequest } from './providers';
import { Scheduler } from './scheduler';
import { SchedulerStore } from './scheduler-store';
import type { SyncInput } from './schedule-sync';
import { SessionStore } from './sessions';
import { SkillStore } from './skill-store';
import { UsageLedger } from './usage-ledger';
import { checkWorkspace } from './workspace';
import * as vault from './vault';
import { runWorkflow } from './workflow-runner';

const isDev = process.env.OLIVIA_DEV === '1';
const headless = process.env.OLIVIA_HEADLESS === '1';
const devUrl = process.env.OLIVIA_DEV_URL || 'http://127.0.0.1:5273';

// M7：artifact 预览协议必须在 app ready 之前登记为特权 scheme
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'olivia-artifact',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
/**
 * 单实例锁：两个实例会共享同一份 userData（providers.json、调度器账本、保险箱），
 * 同时写会把账本写坏，GPU 缓存也会互相锁文件。第二个实例只负责把已有窗口叫到前面。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
let sessions: SessionStore;
let snapshots: SnapshotStore;
let scheduler: Scheduler | null = null;
let mcp: McpManager | null = null;
let skills: SkillStore | null = null;
let pricing: PricingStore;
let usageLedger: UsageLedger;
let providerStore: ProviderStore;
let memoryStore: MemoryStore;
const attachments = new AttachmentService();
let previewHost: PreviewHost | null = null;
let previewWindow: BrowserWindow | null = null;

const reportsDir = (): string => path.join(app.getPath('userData'), 'reports');

/** 每次拿一份新的工具快照：MCP 工具勾选随时可能变。 */
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.setMcpTools(mcp?.registryTools() ?? []);
  return registry;
}

/** 向所有窗口广播（MCP 连接状态、技能变更等）。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

interface TurnContext {
  abort: AbortController;
  approvals: Map<string, (decision: ApprovalDecision) => void>;
  patches: Map<string, (decision: PatchDecision) => void>;
  taskId: string;
}

const turns = new Map<string, TurnContext>();

interface WorkflowRunContext {
  abort: AbortController;
  gates: Map<string, (approved: boolean) => void>;
}

const workflowRuns = new Map<string, WorkflowRunContext>();

function readEnv(): { baseUrl: string; apiKey: string; model: string; workspace: string } {
  return {
    baseUrl: process.env.OLIVIA_BASE_URL || '',
    apiKey: process.env.OLIVIA_API_KEY || '',
    model: process.env.OLIVIA_MODEL || '',
    workspace: process.env.OLIVIA_WORKSPACE || '',
  };
}

interface ModelResolution {
  ok: boolean;
  error?: string;
  providerId?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  vision: boolean;
}

/** 主进程只回传「配置 + hasKey」，明文 Key 永远不出主进程。 */
async function providersWithKey(): Promise<ProviderConfig[]> {
  const list = await providerStore.list();
  return list.map((provider) => ({
    ...provider,
    hasKey: Boolean(vault.secret(providerKeyName(provider.id))),
  }));
}

/**
 * 解析本回合实际使用的端点/密钥/模型：
 * - 选了提供商 → 地址与模型目录来自 providers.json，Key 来自保险箱；
 * - 没选 → 兼容旧的 baseUrl/apiKey 与环境变量（浏览器调试、M1–M7 配置）。
 */
async function resolveModelConfig(input: {
  providerId?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<ModelResolution> {
  const env = readEnv();
  const providerId = input.providerId?.trim();
  if (providerId) {
    const provider = await providerStore.get(providerId);
    if (!provider) {
      return { ok: false, error: '找不到这个提供商，请到设置 → 模型接入重新选择', baseUrl: '', apiKey: '', model: '', vision: false };
    }
    if (!provider.enabled) {
      return { ok: false, error: `提供商「${provider.name}」已停用，请先在设置里启用`, baseUrl: '', apiKey: '', model: '', vision: false };
    }
    if (!provider.baseUrl) {
      return { ok: false, error: `提供商「${provider.name}」还没有填 API 地址`, baseUrl: '', apiKey: '', model: '', vision: false };
    }
    const key = vault.secret(providerKeyName(provider.id));
    if (!key) {
      return {
        ok: false,
        error: `提供商「${provider.name}」还没有保存 API Key，请到设置 → 模型接入补上`,
        baseUrl: '',
        apiKey: '',
        model: '',
        vision: false,
      };
    }
    const modelId = (input.model || provider.models[0]?.id || '').trim();
    if (!modelId) {
      return {
        ok: false,
        error: `提供商「${provider.name}」还没有模型，请先在设置里获取或添加模型`,
        baseUrl: '',
        apiKey: '',
        model: '',
        vision: false,
      };
    }
    const model = provider.models.find((item) => item.id === modelId);
    if (!model) {
      return {
        ok: false,
        error: `模型 ${modelId} 不在提供商「${provider.name}」的模型目录里，请到设置里添加`,
        baseUrl: '',
        apiKey: '',
        model: '',
        vision: false,
      };
    }
    return {
      ok: true,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: key,
      model: model.id,
      contextWindow: model.contextWindow,
      vision: Boolean(model.vision),
    };
  }

  const apiKey = input.apiKey?.trim() || env.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      error: '还没有配置模型密钥：先在设置 → 模型接入里添加提供商并保存 Key',
      baseUrl: '',
      apiKey: '',
      model: '',
      vision: false,
    };
  }
  return {
    ok: true,
    baseUrl: input.baseUrl?.trim() || env.baseUrl || 'https://api.deepseek.com/v1',
    apiKey,
    model: input.model?.trim() || env.model || 'deepseek-v4.1-flash',
    vision: false,
  };
}

/** 整理用 transcript：只取正文与工具摘要，不含 thinking 与图片 base64。 */
function transcriptForMemory(events: Awaited<ReturnType<SessionStore['read']>>): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === 'user.message') {
      const images = event.attachments?.length ? ` [附了 ${event.attachments.length} 张图片：${event.attachments.map((item) => item.path.split(/[\\/]/).pop()).join('、')}]` : '';
      lines.push(`user: ${event.text}${images}`);
      continue;
    }
    if (event.type === 'assistant.message') {
      const text = event.parts
        .filter((part) => part.kind === 'text')
        .map((part) => (part.kind === 'text' ? part.text : ''))
        .join('')
        .trim();
      const tools = event.parts
        .filter((part) => part.kind === 'tool')
        .map((part) => (part.kind === 'tool' ? `${part.run.name}(${part.run.status})：${part.run.detail}` : ''));
      lines.push(`assistant: ${text}${tools.length ? ` [工具：${tools.join('；')}]` : ''}`);
      continue;
    }
    if (event.type === 'tool.call') {
      lines.push(`tool(${event.name}, ${event.status}): ${event.summary}`);
    }
  }
  const text = lines.join('\n');
  return text.length > 120_000 ? text.slice(-120_000) : text;
}

function lastContextUsed(events: Awaited<ReturnType<SessionStore['read']>>): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'usage') return event.usage.context.used;
  }
  return 0;
}

/**
 * 读任务记忆：磁盘文件优先；文件被清理但会话日志里还有 memory.updated 时，
 * 从最后一次检查点重建，保证换机器/清缓存后仍能继续。
 */
async function loadTaskMemory(taskId: string): Promise<TaskMemoryFile> {
  const file = await memoryStore.read(taskId);
  if (file.memory.summary || file.checkpoints.length > 0) return file;
  const events = await sessions.read(taskId);
  let cleared = false;
  let lastUpdate: Extract<(typeof events)[number], { type: 'memory.updated' }> | null = null;
  for (const event of events) {
    if (event.type === 'memory.cleared') {
      cleared = true;
      lastUpdate = null;
    } else if (event.type === 'memory.updated') {
      cleared = false;
      lastUpdate = event;
    }
  }
  if (cleared || !lastUpdate) return file;
  return {
    taskId,
    updatedAt: lastUpdate.at,
    memory: lastUpdate.memory,
    checkpoints: events
      .filter((event) => event.type === 'memory.updated')
      .map((event) => event.checkpoint),
    activeCheckpointId: lastUpdate.checkpoint.id,
  };
}

/** M7：artifact 预览（只服务 userData/artifacts 下的真实文件）。 */
function artifactsDir(): string {
  return path.join(app.getPath('userData'), 'artifacts');
}

const ARTIFACT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
};

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

async function serveArtifact(request: { url: string }): Promise<Response> {
  let target = '';
  try {
    const url = new URL(request.url);
    if (url.host !== 'local') return new Response('not found', { status: 404 });
    target = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return new Response('bad request', { status: 400 });
  }
  if (!target) return new Response('not found', { status: 404 });

  const root = path.resolve(artifactsDir());
  const absolute = path.resolve(target);
  const real = await fs.realpath(absolute).catch(() => null);
  if (!real) return new Response('not found', { status: 404 });
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return new Response('forbidden', { status: 403 });
  }
  const stat = await fs.stat(real).catch(() => null);
  if (!stat || !stat.isFile()) return new Response('forbidden', { status: 403 });
  if (stat.size > MAX_ARTIFACT_BYTES) return new Response('too large', { status: 413 });

  const ext = path.extname(real).toLowerCase();
  const mime = ARTIFACT_MIME[ext];
  if (!mime) return new Response('unsupported', { status: 415 });
  const data = await fs.readFile(real);
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // SVG 可能带脚本：直接导航时用 CSP 关掉脚本，<img> 里则只做静态渲染
  if (ext === '.svg') {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  }
  if (!mime.startsWith('image/') && !mime.startsWith('audio/') && !mime.startsWith('text/')) {
    headers['Content-Disposition'] = 'attachment';
  }
  return new Response(new Uint8Array(data), { headers });
}

function ensurePreview(win: BrowserWindow): PreviewHost {
  if (previewHost && previewWindow === win) return previewHost;
  previewHost?.destroy();
  previewWindow = win;
  previewHost = new PreviewHost({
    window: win,
    artifactsDir: artifactsDir(),
    log: (line) => console.log(line),
    onState: (state: PreviewState) => {
      if (!win.isDestroyed()) win.webContents.send('olivia:preview.event', state);
    },
  });
  return previewHost;
}

ipcMain.on('olivia:env', (event) => {
  event.returnValue = readEnv();
});

/** 渲染层的皮肤明暗同步给原生控件（select / 滚动条 / 菜单） */
ipcMain.on('olivia:theme', (_event, mode: 'light' | 'dark') => {
  nativeTheme.themeSource = mode === 'dark' ? 'dark' : 'light';
});

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : null;
}

// —— M7：价格表、用量账本 ——
ipcMain.handle('olivia:pricing.get', async () => await pricing.read());
ipcMain.handle(
  'olivia:pricing.set-window',
  async (_event, value: number) => await pricing.setDefaultWindow(Number(value)),
);
ipcMain.handle(
  'olivia:pricing.set-model',
  async (
    _event,
    args: { id: string; contextWindow?: number; pricing?: ModelPricing | null },
  ) => {
    const override: ModelOverride = {};
    if (typeof args.contextWindow === 'number' && args.contextWindow > 0) {
      override.contextWindow = Math.round(args.contextWindow);
    }
    if (args.pricing) override.pricing = args.pricing;
    return await pricing.setModel(args.id, override);
  },
);
ipcMain.handle('olivia:pricing.reset-model', async (_event, id: string) => await pricing.resetModel(id));
ipcMain.handle('olivia:pricing.reset', async () => await pricing.resetAll());
ipcMain.handle('olivia:usage.list', async (_event, days?: number) => await usageLedger.list(days ?? 7));
ipcMain.handle('olivia:usage.clear', async () => {
  await usageLedger.clear();
  return { ok: true };
});

// —— M7：内置预览 ——
ipcMain.handle(
  'olivia:preview.open',
  async (event, args: { taskId: string; url: string; bounds: PreviewBounds }) => {
    const win = senderWindow(event);
    if (!win) return { ok: false, error: '没有可用的窗口' };
    ensurePreview(win).open(args);
    return { ok: true };
  },
);
ipcMain.handle('olivia:preview.set-bounds', async (event, bounds: PreviewBounds) => {
  const win = senderWindow(event);
  if (!win) return { ok: false };
  ensurePreview(win).setBounds(bounds);
  return { ok: true };
});
ipcMain.handle('olivia:preview.navigate', async (_event, url: string) => {
  previewHost?.navigate(url);
  return { ok: true };
});
ipcMain.handle('olivia:preview.back', async () => {
  previewHost?.back();
  return { ok: true };
});
ipcMain.handle('olivia:preview.forward', async () => {
  previewHost?.forward();
  return { ok: true };
});
ipcMain.handle('olivia:preview.reload', async () => {
  previewHost?.reload();
  return { ok: true };
});
ipcMain.handle('olivia:preview.zoom', async (_event, factor: number) => {
  previewHost?.setZoom(Number(factor));
  return { ok: true };
});
ipcMain.handle('olivia:preview.allow-external', async () => {
  previewHost?.allowExternal();
  return { ok: true };
});
ipcMain.handle('olivia:preview.capture', async () => {
  if (!previewHost) return { ok: false, error: '预览还没有打开' };
  return await previewHost.capture();
});
ipcMain.handle('olivia:preview.clear-data', async () => {
  await previewHost?.clearData();
  return { ok: true };
});
ipcMain.handle('olivia:preview.close', async () => {
  previewHost?.close();
  return { ok: true };
});

/**
 * 系统目录选择框统一从这里走。
 * 传主窗口做父窗口才真正模态：之前弹出的框不是模态的，Esc 关不掉，
 * 还会出现「弹出 → 自己消失 → 又弹一次」的循环。
 */
async function pickDirectory(options: Electron.OpenDialogOptions): Promise<string | null> {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

/**
 * 界面入口文件的落点，开发态和打包态不一样：
 * - 开发：apps/desktop/dist/main.cjs → 上两级是 apps/ → apps/web/dist
 * - 打包：resources/app/desktop/main.cjs → 上一级是 resources/app/ → resources/app/web/dist
 * 两个都试，装错了目录也不至于白屏（白屏排查过一次，成本很高）。
 */
function indexHtmlPath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'web', 'dist', 'index.html'),
    path.join(__dirname, '..', 'web', 'dist', 'index.html'),
    path.join(app.getAppPath(), 'web', 'dist', 'index.html'),
  ];
  return candidates.find((file) => existsSync(file)) ?? candidates[0]!;
}

function createWindow(): void {
  // 打包后图标随 resources/app/desktop 一起走；开发态没有就交给 Electron 默认
  const windowIcon = path.join(__dirname, 'icon.png');
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#f2efe8',
    autoHideMenuBar: true,
    title: 'OliviaCode',
    icon: existsSync(windowIcon) ? windowIcon : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    if (!headless) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(indexHtmlPath());
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    if (previewWindow === win) {
      previewHost?.destroy();
      previewHost = null;
      previewWindow = null;
    }
  });
}

// —— 工作区 ——
ipcMain.handle('olivia:workspace.pick', async () =>
  await pickDirectory({
    title: '选择任务的工作区目录',
    properties: ['openDirectory', 'createDirectory'],
  }),
);

ipcMain.handle('olivia:workspace.check', async (_event, dir: string) => checkWorkspace(dir));

// —— 任务日志 ——
ipcMain.handle('olivia:task.load', async (_event, taskId: string) => {
  const events = await sessions.read(taskId);
  return { taskId, events };
});

ipcMain.handle(
  'olivia:task.undo',
  async (_event, args: { taskId: string; workspace: string; snapshotId?: string }) => {
    const check = await checkWorkspace(args.workspace);
    if (!check.ok) return { ok: false, paths: [], message: check.message, remaining: 0, skipped: [] };
    const policy: Policy = { mode: 'workspace-write', root: args.workspace };
    const snapshot = args.snapshotId
      ? await snapshots.get(args.taskId, args.snapshotId)
      : await snapshots.latest(args.taskId);
    if (!snapshot) {
      return { ok: false, paths: [], message: '这个任务还没有可撤销的写入', remaining: 0, skipped: [] };
    }
    const paths = await snapshots.restore(snapshot, policy);
    await snapshots.markUndone(args.taskId, snapshot.id);
    // 比这次更新的快照一并作废，避免回退顺序错乱
    for (const item of await snapshots.list(args.taskId)) {
      if (item.id > snapshot.id && !item.undone) {
        await snapshots.markUndone(args.taskId, item.id);
      }
    }
    const remaining = await snapshots.remaining(args.taskId);
    await sessions.append(args.taskId, { at: Date.now(), type: 'undo', snapshotId: snapshot.id });
    if (paths.paths.length === 0) {
      return {
        ok: false,
        paths: [],
        remaining,
        skipped: paths.skipped,
        message: paths.skipped.length
          ? `这些文件的内容没有存进快照（二进制或超过 2MB），无法还原：${paths.skipped.join('、')}`
          : '快照里没有可还原的文件',
      };
    }
    return {
      ok: true,
      paths: paths.paths,
      remaining,
      skipped: paths.skipped,
      message: paths.skipped.length
        ? `有 ${paths.skipped.length} 个文件内容未存进快照，已跳过：${paths.skipped.join('、')}`
        : undefined,
    };
  },
);

// —— 回合 ——
ipcMain.handle('olivia:turn.start', async (event, args: TurnStartArgs & { turnId: string }) => {
  const check = await checkWorkspace(args.workspace);
  if (!check.ok) return { ok: false, error: check.message };
  const resolution = await resolveModelConfig({
    providerId: args.providerId,
    model: args.model,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
  });
  if (!resolution.ok) return { ok: false, error: resolution.error };

  const imageAttachments = normalizeAttachments(args.attachments);
  if (imageAttachments.length > 0 && !resolution.vision) {
    return { ok: false, error: '当前模型未开启图片输入：到设置 → 模型接入里为这个模型打开「支持图片」再发' };
  }
  const imagePayloads: { url: string; label: string; tokens: number }[] = [];
  let imageBytes = 0;
  for (const attachment of imageAttachments) {
    const url = await attachments.readDataUrl(attachment);
    if (!url) {
      return { ok: false, error: `图片 ${attachment.path.split(/[\\/]/).pop() ?? attachment.id} 读不出来，请重新附上` };
    }
    imageBytes += attachment.bytes;
    imagePayloads.push({
      url,
      label: attachment.path.split(/[\\/]/).pop() ?? attachment.id,
      tokens: estimateImageTokens(attachment.width, attachment.height),
    });
  }
  if (imageBytes > 8 * 1024 * 1024) {
    return { ok: false, error: '这次请求的图片总大小超过 8MB，请减少图片或压缩后再发' };
  }

  const turnId = args.turnId;
  const sender = event.sender;
  const abort = new AbortController();
  const context: TurnContext = {
    abort,
    approvals: new Map(),
    patches: new Map(),
    taskId: args.taskId,
  };
  turns.set(turnId, context);

  const emit = (turnEvent: TurnEvent): void => {
    if (turnEvent.type === 'usage') {
      const step = turnEvent.usage;
      const record: UsageRecord = {
        at: step.at,
        taskId: args.taskId,
        turnId,
        model: step.model ?? resolution.model,
        step: step.step,
        input: step.input,
        output: step.output,
        cached: step.cached,
        source: step.source,
        purpose: step.purpose,
      };
      void usageLedger.append(record);
    }
    const envelope: TurnEnvelope = { taskId: args.taskId, turnId, event: turnEvent };
    if (!sender.isDestroyed()) sender.send('olivia:turn.event', envelope);
  };

  const policy: Policy = { mode: 'workspace-write', root: args.workspace };

  // 固定住本轮引用的管理器实例（模块级变量可能在 await 期间被替换）
  const mcpManager = mcp;
  const skillStore = skills;
  // M6：本轮可用的工具 = 内置 + 已勾选的 MCP 工具；技能目录只放名字
  const registry = new ToolRegistry();
  registry.setMcpTools(mcpManager?.registryTools() ?? []);
  const skillCatalog = skillStore ? await skillStore.catalog(args.workspace) : [];

  void (async () => {
    let ok = true;
    let failure: string | undefined;
    try {
      const pricingFile = await pricing.read();
      const contextWindow =
        resolution.contextWindow && resolution.contextWindow > 0
          ? resolution.contextWindow
          : resolveContextWindow(resolution.model, pricingFile.defaultContextWindow, pricingFile.models);
      const memoryFile = await loadTaskMemory(args.taskId);
      const taskMemory = memoryFile.memory.summary ? memoryFile.memory : null;
      await runAgentTurn({
        taskId: args.taskId,
        turnId,
        prompt: args.prompt,
        history: args.history,
        model: resolution.model,
        contextWindow,
        baseUrl: resolution.baseUrl,
        apiKey: resolution.apiKey,
        approval: args.approval,
        allowShell: args.allowShell,
        policy,
        snapshots,
        sessions,
        emit,
        registry,
        attachments: imagePayloads,
        logAttachments: imageAttachments,
        vision: resolution.vision,
        modelKey: resolution.providerId ? providerModelKey(resolution.providerId, resolution.model) : resolution.model,
        memory: taskMemory,
        compactThreshold: args.compactThreshold ?? 85,
        saveMemory: async (draftRaw, meta) => {
          const result = await memoryStore.commit(args.taskId, { draftRaw, ...meta });
          if (!result.ok || !result.file) return { ok: false, error: result.error };
          const checkpoint = result.file.checkpoints[result.file.checkpoints.length - 1];
          if (checkpoint) {
            await sessions.append(args.taskId, {
              at: Date.now(),
              type: 'memory.updated',
              checkpoint,
              memory: result.file.memory,
            });
          }
          broadcast('olivia:memory.event', { taskId: args.taskId, file: result.file });
          return { ok: true };
        },
        callMcp: mcpManager ? (name, toolArgs) => mcpManager.callTool(name, toolArgs) : undefined,
        skillCatalog,
        loadSkill: skillStore ? (name) => skillStore.load(args.workspace, name) : undefined,
        gitToken: (provider) => vault.token(provider),
        signal: abort.signal,
        requestApproval: (request) =>
          new Promise<ApprovalDecision>((resolve) => {
            const timer = setTimeout(() => {
              context.approvals.delete(request.callId);
              resolve('reject');
            }, 5 * 60_000);
            context.approvals.set(request.callId, (decision) => {
              clearTimeout(timer);
              context.approvals.delete(request.callId);
              resolve(decision);
            });
          }),
        requestPatch: (input) =>
          new Promise<PatchDecision>((resolve) => {
            const timer = setTimeout(() => {
              context.patches.delete(input.callId);
              resolve(null);
            }, 5 * 60_000);
            context.patches.set(input.callId, (decision) => {
              clearTimeout(timer);
              context.patches.delete(input.callId);
              resolve(decision);
            });
          }),
      });
    } catch (error) {
      ok = false;
      failure = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) {
        ok = true;
        failure = undefined;
      }
    } finally {
      if (!sender.isDestroyed()) {
        sender.send('olivia:turn.event', {
          taskId: args.taskId,
          turnId,
          event: { type: 'turn.done', ok, error: failure },
        } satisfies TurnEnvelope);
      }
      context.approvals.clear();
      context.patches.clear();
      turns.delete(turnId);
    }
  })();

  return { ok: true };
});

ipcMain.on(
  'olivia:turn.approve',
  (_event, args: { turnId: string; callId: string; decision: ApprovalDecision }) => {
    turns.get(args.turnId)?.approvals.get(args.callId)?.(args.decision);
  },
);

ipcMain.on(
  'olivia:turn.patch',
  (_event, args: { turnId: string; callId: string; accepted: number[] | null }) => {
    turns.get(args.turnId)?.patches.get(args.callId)?.(args.accepted);
  },
);

ipcMain.on('olivia:turn.cancel', (_event, args: { turnId: string }) => {
  const turn = turns.get(args.turnId);
  if (!turn) return;
  turn.abort.abort();
  for (const [, resolve] of turn.approvals) resolve('reject');
  for (const [, resolve] of turn.patches) resolve(null);
  turn.approvals.clear();
  turn.patches.clear();
});

// —— 工作流 ——
ipcMain.handle(
  'olivia:workflow.run',
  async (event, args: WorkflowRunArgs & { model?: string; allowShell?: boolean }) => {
    const resolution = await resolveModelConfig({
      providerId: args.providerId,
      model: args.model,
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
    });
    if (!resolution.ok) return { ok: false, error: resolution.error ?? '还没有配置模型密钥，工作流没法真跑' };
    const check = await checkWorkspace(args.workspace);
    if (!check.ok) return { ok: false, error: check.message };
    if (workflowRuns.has(args.runId)) return { ok: false, error: '这次运行还在进行中' };

    const controller = new AbortController();
    const gates = new Map<string, (approved: boolean) => void>();
    workflowRuns.set(args.runId, { abort: controller, gates });
    const sender = event.sender;
    const mcpManager = mcp;
    const skillStore = skills;
    const skillCatalog = skillStore ? await skillStore.catalog(args.workspace) : [];
    const emit = (workflowEvent: WorkflowRunEvent): void => {
      if (!sender.isDestroyed()) {
        sender.send('olivia:workflow.event', { runId: args.runId, event: workflowEvent });
      }
    };

    void runWorkflow({
      runId: args.runId,
      workflow: args.workflow,
      workspace: args.workspace,
      worktreeRoot: path.join(app.getPath('userData'), 'worktrees'),
      apiKey: resolution.apiKey,
      baseUrl: resolution.baseUrl,
      model: resolution.model,
      allowShell: Boolean(args.allowShell),
      maxParallel: args.maxParallel,
      snapshots,
      emit,
      signal: controller.signal,
      registry: buildRegistry(),
      pricing: pricing.peek(),
      callMcp: mcpManager ? (name, toolArgs) => mcpManager.callTool(name, toolArgs) : undefined,
      skillCatalog,
      loadSkill: skillStore ? (name) => skillStore.load(args.workspace, name) : undefined,
      requestGate: (node) =>
        new Promise<boolean>((resolve) => {
          // 节点上的 timeout 是分钟；默认 30 分钟，超时按拒绝处理（并留一条日志）
          const minutes = Math.max(1, Math.min(120, Number(node.gateTimeout ?? node.timeout ?? 30)));
          const timer = setTimeout(() => {
            gates.delete(node.id);
            resolve(false);
          }, minutes * 60_000);
          gates.set(node.id, (approved) => {
            clearTimeout(timer);
            gates.delete(node.id);
            resolve(approved);
          });
        }),
    })
      .catch((error: unknown) => {
        emit({
          type: 'run.done',
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        workflowRuns.delete(args.runId);
      });

    return { ok: true };
  },
);

ipcMain.on(
  'olivia:workflow.gate',
  (_event, args: { runId: string; nodeId: string; approved: boolean }) => {
    workflowRuns.get(args.runId)?.gates.get(args.nodeId)?.(args.approved);
  },
);

ipcMain.on('olivia:workflow.cancel', (_event, args: { runId: string }) => {
  const run = workflowRuns.get(args.runId);
  if (!run) return;
  run.abort.abort();
  for (const [, resolve] of run.gates) resolve(false);
  run.gates.clear();
});

// —— 凭据 ——
ipcMain.handle('olivia:vault.status', async () => vault.status());
ipcMain.handle('olivia:vault.set', async (_event, args: { provider: GitProvider; token: string }) => {
  try {
    vault.setToken(args.provider, args.token);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('olivia:vault.clear', async (_event, provider: GitProvider) => {
  vault.clearToken(provider);
  return { ok: true };
});

// —— 无人值守模型凭据（Key 只写不读）——
ipcMain.handle('olivia:vault.model-status', async () => vault.modelStatus());
ipcMain.handle(
  'olivia:vault.model-set',
  async (_event, args: { baseUrl: string; apiKey: string; model: string }) => {
    try {
      vault.setModelCredential(args);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
);
ipcMain.handle('olivia:vault.model-clear', async () => {
  vault.clearModelCredential();
  return { ok: true };
});

// —— M8：多提供商与模型目录（Key 只进保险箱）——
ipcMain.handle('olivia:provider.list', async () => providersWithKey());

ipcMain.handle('olivia:provider.save', async (_event, draft: ProviderDraft) => {
  if (!draft || typeof draft !== 'object') return { ok: false, error: '提供商配置格式不对' };
  const providerId = String(draft.id ?? '').trim();
  const normalized: ProviderDraft = {
    ...draft,
    id: providerId,
    name: String(draft.name ?? '').trim(),
    baseUrl: String(draft.baseUrl ?? '').trim(),
    protocol: 'openai-chat',
    models: Array.isArray(draft.models)
      ? draft.models.map((model) => ({
          ...model,
          id: String(model?.id ?? '').trim(),
          label: model?.label ? String(model.label).trim() || undefined : undefined,
        }))
      : [],
  };
  const invalid = validateProviderDraft(normalized);
  if (invalid) return { ok: false, error: invalid };
  const apiKey = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : '';
  if (apiKey) {
    try {
      vault.setSecret(providerKeyName(providerId), apiKey);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const saved = await providerStore.save(normalized);
  if (!saved.ok) return saved;
  const providers = await providersWithKey();
  broadcast('olivia:provider.event', providers);
  return { ok: true, providers };
});

ipcMain.handle('olivia:provider.remove', async (_event, rawId: string) => {
  const id = String(rawId ?? '').trim();
  try {
    vault.setSecret(providerKeyName(id), '');
  } catch {
    // 删除配置不应因为保险箱不可用而卡住
  }
  await providerStore.remove(id);
  const providers = await providersWithKey();
  broadcast('olivia:provider.event', providers);
  return { ok: true, providers };
});

ipcMain.handle('olivia:provider.enable', async (_event, args: { id: string; enabled: boolean }) => {
  const id = String(args?.id ?? '').trim();
  await providerStore.setEnabled(id, Boolean(args?.enabled));
  const providers = await providersWithKey();
  broadcast('olivia:provider.event', providers);
  return { ok: true, providers };
});

ipcMain.handle(
  'olivia:provider.fetch-models',
  async (
    _event,
    args: { providerId?: string; baseUrl: string; apiKey?: string },
  ): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
    const baseUrl = String(args?.baseUrl ?? '').trim();
    if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'API 地址必须以 http:// 或 https:// 开头' };
    let apiKey = String(args?.apiKey ?? '').trim();
    if (!apiKey && args?.providerId) apiKey = vault.secret(providerKeyName(String(args.providerId))) ?? '';
    if (!apiKey) return { ok: false, error: '先填 API Key（编辑已有提供商时可以留空，会使用已保存的那份）' };
    const result = await fetchProviderModels(baseUrl, apiKey);
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.status === 401 || result.status === 403
            ? `密钥无效或没有权限（HTTP ${result.status}）`
            : result.error?.slice(0, 300) || `获取模型失败（HTTP ${result.status ?? '—'}）`,
      };
    }
    return { ok: true, models: result.models ?? [] };
  },
);

ipcMain.handle('olivia:provider.test', async (_event, draft: ProviderDraft) => {
  let apiKey = draft.apiKey?.trim() ?? '';
  if (!apiKey) apiKey = vault.secret(providerKeyName(draft.id)) ?? '';
  const result = await testProviderConnection({
    draft: {
      ...draft,
      name: draft.name.trim() || draft.id,
      baseUrl: draft.baseUrl.trim(),
      protocol: 'openai-chat',
      enabled: draft.enabled !== false,
      createdAt: 0,
      updatedAt: 0,
    },
    apiKey,
  });
  return result;
});

// —— M8：图片附件（先落 artifacts，再由用户发送）——
ipcMain.handle(
  'olivia:attachment.save',
  async (
    _event,
    input: { dataUrl?: string; filePath?: string; source?: ImageAttachment['source']; name?: string },
  ) => attachments.save(input ?? {}),
);

ipcMain.handle(
  'olivia:attachment.adopt',
  async (_event, args: { filePath: string; source?: ImageAttachment['source'] }) =>
    attachments.adopt(String(args?.filePath ?? ''), args?.source === 'mcp' ? 'mcp' : 'preview'),
);

// —— M8：任务记忆与检查点 ——
ipcMain.handle('olivia:memory.get', async (_event, rawTaskId: string): Promise<TaskMemoryFile | null> => {
  const taskId = String(rawTaskId ?? '').trim();
  if (!taskId) return null;
  return await loadTaskMemory(taskId);
});

ipcMain.handle(
  'olivia:memory.compact',
  async (_event, args: { taskId: string; providerId?: string; model?: string }) => {
    const taskId = String(args?.taskId ?? '').trim();
    if (!taskId) return { ok: false, error: '缺少任务 ID' };
    const events = await sessions.read(taskId);
    const transcript = transcriptForMemory(events);
    if (!transcript.trim()) return { ok: false, error: '这个任务还没有可整理的对话' };
    const resolution = await resolveModelConfig({
      providerId: args?.providerId,
      model: args?.model,
    });
    if (!resolution.ok) return { ok: false, error: resolution.error };
    const draft = await requestMemoryDraft(transcript, {
      model: resolution.model,
      baseUrl: resolution.baseUrl,
      apiKey: resolution.apiKey,
      signal: AbortSignal.timeout(90_000),
    });
    if (!draft.ok || !draft.raw) {
      return { ok: false, error: draft.error ?? '整理失败（继续用最近原文）' };
    }
    const beforeUsed = lastContextUsed(events);
    const afterUsed = estimateTokens(draft.raw);
    const userTurns = events.filter((item) => item.type === 'user.message').length;
    const result = await memoryStore.commit(taskId, {
      draftRaw: draft.raw,
      reason: 'manual',
      beforeUsed,
      afterUsed,
      keptTurns: 2,
      droppedTurns: Math.max(0, userTurns - 2),
      usage: { input: draft.input, output: draft.output, source: draft.source },
    });
    if (!result.ok || !result.file) return { ok: false, error: result.error ?? '整理结果校验失败' };
    const checkpoint: ContextCheckpoint | undefined = result.file.checkpoints[result.file.checkpoints.length - 1];
    if (checkpoint) {
      await sessions.append(taskId, {
        at: Date.now(),
        type: 'memory.updated',
        checkpoint,
        memory: result.file.memory,
      });
    }
    const pricingFile = await pricing.read();
    const step = Math.max(0, ...events.filter((item) => item.type === 'usage').map((item) => item.usage.step)) + 1;
    const usageStep = {
      step,
      at: Date.now(),
      durationMs: 0,
      model: resolution.model,
      purpose: 'compaction' as const,
      input: draft.input,
      output: draft.output,
      source: draft.source,
      context: measureContext({
        window: pricingFile.defaultContextWindow,
        parts: [{ key: 'history' as const, text: transcript, items: userTurns }],
        providerInput: draft.input,
      }),
    };
    await sessions.append(taskId, { at: Date.now(), type: 'usage', turnId: 'compact', usage: usageStep });
    await usageLedger.append({
      at: usageStep.at,
      taskId,
      turnId: 'compact',
      model: resolution.model,
      step: usageStep.step,
      input: usageStep.input,
      output: usageStep.output,
      source: usageStep.source,
      purpose: 'compaction',
    });
    broadcast('olivia:memory.event', { taskId, file: result.file });
    return { ok: true, file: result.file };
  },
);

ipcMain.handle(
  'olivia:memory.revert',
  async (_event, args: { taskId: string; checkpointId?: string | null }) => {
    const taskId = String(args?.taskId ?? '').trim();
    if (!taskId) return { ok: false, error: '缺少任务 ID' };
    const file = await memoryStore.revert(taskId, args.checkpointId ?? null);
    broadcast('olivia:memory.event', { taskId, file });
    return { ok: true, file };
  },
);

ipcMain.handle('olivia:memory.clear', async (_event, rawTaskId: string) => {
  const taskId = String(rawTaskId ?? '').trim();
  if (!taskId) return { ok: false };
  await memoryStore.clear(taskId);
  await sessions.append(taskId, { at: Date.now(), type: 'memory.cleared' });
  broadcast('olivia:memory.event', { taskId, file: null });
  return { ok: true };
});

ipcMain.handle('olivia:memory.clear-all', async () => {
  const taskIds = await sessions.taskIds();
  for (const taskId of taskIds) {
    await sessions.append(taskId, { at: Date.now(), type: 'memory.cleared' });
  }
  await memoryStore.clearAll();
  broadcast('olivia:memory.event', { taskId: null, file: null });
  return { ok: true };
});

// —— 定时任务（M5）——
ipcMain.handle('olivia:schedules.list', async (): Promise<ScheduleRecord[]> =>
  scheduler ? await scheduler.list() : [],
);
ipcMain.handle('olivia:schedules.runs', async (_event, scheduleId: string): Promise<RunRecord[]> =>
  scheduler ? await scheduler.listRuns(scheduleId) : [],
);
ipcMain.handle('olivia:schedules.recent', async (): Promise<RunRecord[]> =>
  scheduler ? await scheduler.recentRuns() : [],
);
ipcMain.handle('olivia:schedules.preview', async (_event, id: string): Promise<number[]> =>
  scheduler ? await scheduler.preview(id) : [],
);
ipcMain.handle('olivia:schedules.sync', async (_event, input: SyncInput) => {
  if (!scheduler) return { ok: false, error: '调度器还没启动' };
  const result = await scheduler.syncWorkflow(input);
  return { ok: true, ...result };
});
ipcMain.handle(
  'olivia:schedules.update',
  async (
    _event,
    args: { id: string; patch: Partial<Pick<ScheduleRecord, 'enabled' | 'mode' | 'policy'>> },
  ) => {
    if (!scheduler) return { ok: false, error: '调度器还没启动' };
    try {
      const schedule = await scheduler.update(args.id, args.patch as {
        enabled?: boolean;
        mode?: ScheduleRecord['mode'];
        policy?: UnattendedPolicy;
      });
      return schedule ? { ok: true, schedule } : { ok: false, error: '计划不存在' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
);
ipcMain.handle('olivia:schedules.run-now', async (_event, id: string) => {
  if (!scheduler) return { ok: false, error: '调度器还没启动' };
  return await scheduler.runNow(id);
});
ipcMain.on('olivia:schedules.cancel', (_event, id: string) => {
  scheduler?.cancel(id);
});
ipcMain.handle('olivia:schedules.open-report', async (_event, filePath: string) => {
  // 只允许打开报告目录内的文件，避免这条通道变成任意文件打开器
  const root = path.resolve(reportsDir());
  const target = path.resolve(filePath);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: '报告路径不在报告目录内' };
  }
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true };
});

// —— Git ——
ipcMain.handle('olivia:git.pick-dir', async () =>
  await pickDirectory({
    title: '选择目录',
    properties: ['openDirectory', 'createDirectory'],
  }),
);

ipcMain.handle('olivia:git.state', async (_event, dir: string) => {
  if (!dir) return null;
  const repo = await isRepo(dir).catch(() => false);
  if (!repo) {
    return {
      isRepo: false,
      root: dir,
      status: {
        ok: true,
        branch: '',
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        remote: null,
      },
      branches: [],
      log: [],
    };
  }
  const [status, branches, log] = await Promise.all([
    readStatus(dir),
    readBranches(dir),
    readLog(dir),
  ]);
  return { isRepo: true, root: dir, status, branches, log };
});

ipcMain.handle(
  'olivia:git.diff',
  async (_event, args: { dir: string; path: string; staged: boolean }) =>
    readFileDiff(args.dir, args.path, args.staged),
);

ipcMain.handle('olivia:git.stage', async (_event, args: { dir: string; paths: string[] }) => {
  await stagePaths(args.dir, args.paths);
  return { ok: true };
});

ipcMain.handle('olivia:git.unstage', async (_event, args: { dir: string; paths: string[] }) => {
  await unstagePaths(args.dir, args.paths);
  return { ok: true };
});

ipcMain.handle(
  'olivia:git.stage-hunks',
  async (_event, args: { dir: string; path: string; indexes: number[] }) => {
    await stageHunks(args.dir, args.path, args.indexes);
    return { ok: true };
  },
);

ipcMain.handle('olivia:git.commit', async (_event, args: { dir: string; message: string }) => {
  const hash = await commit(args.dir, args.message);
  return { ok: true, hash };
});

ipcMain.handle('olivia:git.checkout', async (_event, args: { dir: string; branch: string }) => {
  await checkout(args.dir, args.branch);
  return { ok: true };
});

ipcMain.handle(
  'olivia:git.create-branch',
  async (_event, args: { dir: string; branch: string }) => {
    await createBranch(args.dir, args.branch);
    return { ok: true };
  },
);

ipcMain.handle('olivia:git.pull', async (_event, args: { dir: string }) => {
  const status = await readStatus(args.dir);
  const provider = status.remote?.provider;
  const token = provider ? vault.token(provider) : null;
  try {
    // 认证走 git.ts 的进程内环境变量注入（GIT_CONFIG_*），不写任何配置文件
    const output = await pull(args.dir, provider && token ? { provider, token } : null);
    return { ok: true, output, conflicts: await conflicts(args.dir) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      conflicts: await conflicts(args.dir),
    };
  }
});

ipcMain.handle('olivia:git.push', async (_event, args: { dir: string }) => {
  const status = await readStatus(args.dir);
  const provider = status.remote?.provider;
  if (!provider) return { ok: false, message: '没有识别出远程仓库' };
  const token = vault.token(provider);
  if (!token) return { ok: false, message: `还没有保存 ${provider} 的令牌` };
  try {
    const output = await push(args.dir, { provider, token });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle(
  'olivia:git.pr',
  async (_event, args: { dir: string; title: string; body: string; base: string }) => {
    const status = await readStatus(args.dir);
    if (!status.remote) return { ok: false, message: '没有识别出远程仓库' };
    const token = vault.token(status.remote.provider);
    if (!token) return { ok: false, message: `还没有保存 ${status.remote.provider} 的令牌` };
    return await createPullRequest({
      remote: status.remote,
      token,
      title: args.title,
      body: args.body,
      head: status.branch,
      base: args.base || 'main',
    });
  },
);

ipcMain.handle(
  'olivia:git.clone',
  async (_event, args: { parentDir: string; url: string; name: string }) => {
    const remote = parseRemote(args.url);
    const provider = remote?.provider ?? 'gitcode';
    const token = vault.token(provider);
    try {
      const dir = await clone(
        args.parentDir,
        args.url,
        args.name,
        token ? { provider, token } : null,
      );
      return { ok: true, dir };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
);

// —— M6：MCP 服务器 ——
ipcMain.handle('olivia:mcp.list', async () => ({
  configs: mcp?.listConfigs() ?? [],
  states: mcp?.allStates() ?? [],
}));
ipcMain.handle('olivia:mcp.save', async (_event, input: Partial<McpServerConfig> & { id?: string }) =>
  mcp ? await mcp.saveConfig(input) : { ok: false, error: 'MCP 管理器还没启动' },
);
ipcMain.handle('olivia:mcp.remove', async (_event, id: string) => {
  await mcp?.remove(id);
  return { ok: true };
});
ipcMain.handle('olivia:mcp.enable', async (_event, args: { id: string; enabled: boolean }) =>
  mcp ? await mcp.setEnabled(args.id, args.enabled) : null,
);
ipcMain.handle('olivia:mcp.connect', async (_event, id: string) => (mcp ? await mcp.connect(id) : null));
ipcMain.handle('olivia:mcp.refresh', async (_event, id: string) => (mcp ? await mcp.refresh(id) : null));
ipcMain.handle('olivia:mcp.disconnect', async (_event, id: string) => {
  await mcp?.disconnectServer(id);
  return { ok: true };
});
ipcMain.handle(
  'olivia:mcp.risk',
  async (_event, args: { id: string; tool: string; risk: McpRisk | null }) =>
    mcp ? await mcp.setToolRisk(args.id, args.tool, args.risk) : null,
);
ipcMain.handle('olivia:mcp.secret', async (_event, args: { key: string; value: string }) => {
  try {
    vault.setSecret(args.key, args.value);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

// —— M6：团队技能 ——
ipcMain.handle('olivia:skills.pick', async () =>
  await pickDirectory({ title: '选择技能目录（含 SKILL.md）', properties: ['openDirectory'] }),
);
ipcMain.handle('olivia:skills.list', async (_event, workspace: string) =>
  skills && workspace ? await skills.scan(workspace) : [],
);
ipcMain.handle('olivia:skills.install', async (_event, args: { workspace: string; dir: string }) =>
  skills ? await skills.install(args.workspace, args.dir) : { ok: false, error: '技能管理器还没启动' },
);
ipcMain.handle(
  'olivia:skills.enable',
  async (_event, args: { workspace: string; name: string; enabled: boolean }) =>
    skills ? await skills.setEnabled(args.workspace, args.name, args.enabled) : { ok: false, error: '未初始化' },
);
ipcMain.handle('olivia:skills.confirm', async (_event, args: { workspace: string; name: string }) =>
  skills ? await skills.confirm(args.workspace, args.name) : { ok: false, error: '未初始化' },
);
ipcMain.handle('olivia:skills.uninstall', async (_event, args: { workspace: string; name: string }) =>
  skills ? await skills.uninstall(args.workspace, args.name) : { ok: false, error: '未初始化' },
);
ipcMain.handle('olivia:skills.load', async (_event, args: { workspace: string; name: string }) =>
  skills ? await skills.load(args.workspace, args.name) : { ok: false, error: '未初始化' },
);

if (!gotSingleInstanceLock) {
  // 第二个实例：拿不到锁就直接退出，窗口交给已经在跑的那个（它会被 second-instance 唤起）
  app.quit();
} else {
  app.whenReady().then(async () => {
    // 无障碍树默认关着，屏幕阅读器拿到的是空树；这里显式打开
    app.setAccessibilitySupportEnabled(true);
    sessions = new SessionStore(path.join(app.getPath('userData'), 'sessions'));
  snapshots = new SnapshotStore(path.join(app.getPath('userData'), 'snapshots'));
  pricing = new PricingStore(path.join(app.getPath('userData'), 'pricing.json'));
  providerStore = new ProviderStore(path.join(app.getPath('userData'), 'providers.json'));
  memoryStore = new MemoryStore(path.join(app.getPath('userData'), 'memory'));
  await pricing.read();
  await providerStore.list();
  usageLedger = new UsageLedger(path.join(app.getPath('userData'), 'usage.jsonl'));
  protocol.handle('olivia-artifact', (request) => serveArtifact(request));
  nativeTheme.themeSource = 'dark';

  /**
   * M6：MCP 连接管理器。配置在机器级（不进仓库），密钥引用走保险箱；
   * 勾选了风险的工具才会暴露给模型。
   */
  mcp = new McpManager({
    file: path.join(app.getPath('userData'), 'mcp.json'),
    artifactsDir: path.join(app.getPath('userData'), 'artifacts'),
    resolveSecret: (reference) => {
      const match = reference.match(/^vault:(.+)$/);
      return match ? vault.secret(match[1]!) : null;
    },
    log: (line) => console.log(line),
    onChange: (state) => broadcast('olivia:mcp.event', state),
  });
  await mcp.load();
  void mcp.connectAll();

  /** M6：技能（工作区 `.olivia/skills` 随仓库走；个人技能在应用数据目录）。 */
  skills = new SkillStore({
    stateFile: path.join(app.getPath('userData'), 'skill-state.json'),
    personalDir: path.join(app.getPath('userData'), 'skills'),
  });

  /**
   * M5 调度器：常驻主进程，关掉窗口也照跑。
   * 凭据解析顺序：保险箱里存的（无人值守需要）→ 环境变量；都没有则预检失败。
   */
  const env = readEnv();
  scheduler = new Scheduler({
    store: new SchedulerStore(app.getPath('userData')),
    snapshots,
    worktreeRoot: path.join(app.getPath('userData'), 'worktrees'),
    reportsDir: reportsDir(),
    mcp: {
      createRegistry: buildRegistry,
      callMcp: (name, toolArgs) =>
        mcp
          ? mcp.callTool(name, toolArgs)
          : Promise.resolve({ ok: false, text: 'MCP 管理器未启动', summary: '不可用' }),
    },
    skills: {
      catalog: (workspace) => (skills ? skills.catalog(workspace) : Promise.resolve([])),
      load: (workspace, name) =>
        skills ? skills.load(workspace, name) : Promise.resolve({ ok: false, error: '技能管理器未启动' }),
    },
    resolveCredentials: () => {
      const saved = vault.modelCredential();
      if (saved) return saved;
      if (env.apiKey) {
        return {
          baseUrl: env.baseUrl || 'https://api.deepseek.com/v1',
          apiKey: env.apiKey,
          model: env.model || 'deepseek-v4.1-flash',
        };
      }
      return null;
    },
    pricing: () => pricing.peek(),
    gitToken: (provider) => vault.token(provider),
    emit: (event: SchedulerEvent) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('olivia:schedules.event', event);
      }
    },
    notify: (title, body) => {
      try {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      } catch {
        // 通知失败不影响调度
      }
    },
  });
  void scheduler.start().catch((error) => {
    console.error('调度器启动失败：', error);
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  });
}

app.on('before-quit', () => {
  scheduler?.stop();
  mcp?.stopAll();
  previewHost?.destroy();
  previewHost = null;
});

app.on('window-all-closed', () => {
  for (const turn of turns.values()) turn.abort.abort();
  if (process.platform !== 'darwin') app.quit();
});
