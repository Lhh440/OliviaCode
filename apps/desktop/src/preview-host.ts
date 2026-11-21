import { BrowserWindow, WebContentsView, session, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  classifyPreviewUrl,
  isLoopbackHost,
  type PreviewState,
} from '@olivia/core';

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
}

interface PreviewHostOptions {
  window: BrowserWindow;
  artifactsDir: string;
  onState: (state: PreviewState) => void;
  log?: (line: string) => void;
}

const PARTITION = 'persist:olivia-preview';

function clampInt(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

/**
 * M7 · 内置预览宿主。
 *
 * 单个 WebContentsView、独立持久分区、无 preload；默认只允许 loopback，
 * 外部站点逐任务确认。模型没有浏览器工具，这里只服务人的眼睛。
 */
export class PreviewHost {
  private view: WebContentsView | null = null;
  private attached = false;
  private taskId = '';
  private bounds: PreviewBounds = { x: 0, y: 0, width: 600, height: 400, visible: false };
  private allowedHosts = new Map<string, Set<string>>();
  private pending: { url: string; host: string } | null = null;
  private state: PreviewState | null = null;
  private permissionsReady = false;

  constructor(private readonly options: PreviewHostOptions) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  private allowedFor(taskId: string): Set<string> {
    let set = this.allowedHosts.get(taskId);
    if (!set) {
      set = new Set();
      this.allowedHosts.set(taskId, set);
    }
    return set;
  }

  private publish(patch: Partial<PreviewState> = {}): void {
    if (!this.state) return;
    this.state = { ...this.state, ...patch };
    this.options.onState({ ...this.state });
  }

  private configurePermissions(): void {
    if (this.permissionsReady) return;
    this.permissionsReady = true;
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_contents, permission, callback) => {
      this.log(`[preview] 拒绝权限请求：${permission}`);
      callback(false);
    });
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => {
      this.log('[preview] 取消下载');
      event.preventDefault();
    });
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    this.configurePermissions();
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        devTools: false,
      },
    });
    view.setBackgroundColor('#0b0f14');
    this.view = view;
    this.wire(view);
    return view;
  }

  private wire(view: WebContentsView): void {
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      this.handlePopup(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (!this.inspectNavigation(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (!this.inspectNavigation(url)) event.preventDefault();
    });
    wc.on('did-start-loading', () => this.publish({ loading: true, error: undefined }));
    wc.on('did-stop-loading', () => this.refreshState(false));
    wc.on('page-title-updated', (_event, title) => this.publish({ title }));
    wc.on('did-navigate', (_event, url) => this.publish({ url, external: !this.isLoopbackUrl(url) }));
    wc.on('did-navigate-in-page', (_event, url) => this.publish({ url }));
    wc.on('did-fail-load', (_event, code, description, validatedUrl) => {
      if (code === -3) return; // ERR_ABORTED：导航被我们自己取消了
      this.publish({
        loading: false,
        error: `${description}${validatedUrl ? `（${validatedUrl}）` : ''}`,
      });
    });
    wc.on('render-process-gone', (_event, details) => {
      this.publish({ loading: false, error: `预览页面已崩溃：${details.reason}` });
    });
    wc.on('destroyed', () => {
      this.view = null;
      this.attached = false;
    });
  }

  private isLoopbackUrl(url: string): boolean {
    try {
      return isLoopbackHost(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  /** 返回 true 表示可以继续导航。 */
  private inspectNavigation(url: string): boolean {
    if (!url || url === 'about:blank') return true;
    if (!this.state) return true;
    const verdict = classifyPreviewUrl(url, { allowedHosts: [...this.allowedFor(this.taskId)] });
    if (verdict.action === 'allow') return true;
    if (verdict.action === 'external') {
      this.pending = { url: verdict.url, host: verdict.host };
      this.publish({ pendingExternal: verdict.url });
      this.log(`[preview] 外站导航待确认：${verdict.url}`);
      return false;
    }
    this.publish({ error: verdict.reason });
    this.log(`[preview] 拒绝导航：${verdict.reason}`);
    return false;
  }

  private handlePopup(url: string): void {
    if (!this.view) return;
    const verdict = classifyPreviewUrl(url, { allowedHosts: [...this.allowedFor(this.taskId)] });
    if (verdict.action === 'allow') {
      void this.view.webContents.loadURL(verdict.url).catch((error) => this.publish({ error: String(error) }));
      return;
    }
    if (verdict.action === 'external') {
      this.pending = { url: verdict.url, host: verdict.host };
      this.publish({ pendingExternal: verdict.url });
      return;
    }
    void shell.openExternal(url).catch(() => undefined);
  }

  open(input: { taskId: string; url: string; bounds: PreviewBounds }): void {
    this.taskId = input.taskId;
    this.bounds = { ...input.bounds };
    this.pending = null;
    this.state = {
      taskId: input.taskId,
      url: input.url,
      title: '',
      loading: true,
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
      external: false,
    };
    const view = this.ensureView();
    this.attach();
    view.setBounds(this.normalizeBounds());
    this.navigate(input.url);
  }

  navigate(raw: string): void {
    const view = this.view;
    if (!view) return;
    const value = raw.trim();
    if (!value) return;
    const verdict = classifyPreviewUrl(value, { allowedHosts: [...this.allowedFor(this.taskId)] });
    if (verdict.action === 'deny') {
      this.publish({ error: verdict.reason });
      return;
    }
    if (verdict.action === 'external') {
      this.pending = { url: verdict.url, host: verdict.host };
      this.publish({ pendingExternal: verdict.url });
      return;
    }
    this.pending = null;
    this.publish({ url: verdict.url, loading: true, error: undefined, pendingExternal: undefined });
    void view.webContents.loadURL(verdict.url).catch((error) => {
      this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) });
    });
  }

  allowExternal(): void {
    if (!this.pending) return;
    this.allowedFor(this.taskId).add(this.pending.host);
    const url = this.pending.url;
    this.pending = null;
    this.navigate(url);
  }

  back(): void {
    this.view?.webContents.navigationHistory.goBack();
  }

  forward(): void {
    this.view?.webContents.navigationHistory.goForward();
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  setZoom(factor: number): void {
    const zoom = Math.min(3, Math.max(0.4, Number(factor) || 1));
    this.view?.webContents.setZoomFactor(zoom);
    this.publish({ zoom });
  }

  setBounds(next: PreviewBounds): void {
    this.bounds = {
      x: clampInt(next.x),
      y: clampInt(next.y),
      width: Math.max(1, clampInt(next.width, 600)),
      height: Math.max(1, clampInt(next.height, 400)),
      visible: Boolean(next.visible),
    };
    if (!this.view) return;
    if (this.bounds.visible) {
      this.attach();
      this.view.setBounds(this.normalizeBounds());
    } else {
      this.detach();
    }
  }

  private normalizeBounds(): { x: number; y: number; width: number; height: number } {
    const [winWidth, winHeight] = this.options.window.getContentSize();
    const x = Math.max(0, Math.min(this.bounds.x, winWidth - 1));
    const y = Math.max(0, Math.min(this.bounds.y, winHeight - 1));
    const width = Math.max(1, Math.min(this.bounds.width, winWidth - x));
    const height = Math.max(1, Math.min(this.bounds.height, winHeight - y));
    return { x, y, width, height };
  }

  private attach(): void {
    if (!this.view || this.attached || !this.bounds.visible) return;
    this.options.window.contentView.addChildView(this.view);
    this.attached = true;
  }

  private detach(): void {
    if (!this.view || !this.attached) return;
    this.options.window.contentView.removeChildView(this.view);
    this.attached = false;
  }

  private refreshState(loading: boolean): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    this.publish({
      loading,
      url: wc.getURL() || this.state?.url,
      title: wc.getTitle(),
      canGoBack: this.canGoBack(),
      canGoForward: this.canGoForward(),
    });
  }

  private canGoBack(): boolean {
    try {
      return Boolean(this.view?.webContents.navigationHistory.canGoBack());
    } catch {
      return false;
    }
  }

  private canGoForward(): boolean {
    try {
      return Boolean(this.view?.webContents.navigationHistory.canGoForward());
    } catch {
      return false;
    }
  }

  async capture(): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!this.view) return { ok: false, error: '预览还没有打开' };
    try {
      const image = await this.view.webContents.capturePage();
      if (image.isEmpty()) return { ok: false, error: '预览页面还没有渲染出可截取的内容' };
      await fs.mkdir(this.options.artifactsDir, { recursive: true });
      const safeTask = (this.state?.taskId ?? 'preview').replace(/[^a-zA-Z0-9_-]/g, '_');
      const file = path.join(
        this.options.artifactsDir,
        `preview_${safeTask}_${Date.now().toString(36)}.png`,
      );
      await fs.writeFile(file, image.toPNG());
      return { ok: true, path: file };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async clearData(): Promise<void> {
    await session.fromPartition(PARTITION).clearStorageData().catch(() => undefined);
  }

  close(): void {
    this.pending = null;
    this.detach();
    if (this.view) {
      const wc = this.view.webContents;
      this.view = null;
      if (!wc.isDestroyed()) wc.close();
    }
    if (this.state) {
      this.state = { ...this.state, url: '', loading: false, closed: true } as PreviewState;
      this.options.onState({ ...this.state });
    }
    this.state = null;
  }

  destroy(): void {
    this.close();
    this.allowedHosts.clear();
  }
}
