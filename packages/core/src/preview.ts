/**
 * M7 · 内置预览的地址策略（纯函数，主进程与自检共用）。
 *
 * 预览默认只允许 loopback；外部站点需要逐任务显式放行。
 * 这里不碰 Electron，方便脱离运行时单测。
 */

export interface PreviewPolicy {
  /** 本次任务临时放行的外部 hostname（内存，不落盘） */
  allowedHosts: string[];
}

export type PreviewNavigation =
  | { action: 'allow'; url: string }
  | { action: 'external'; url: string; host: string }
  | { action: 'deny'; reason: string };

export interface PreviewState {
  taskId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
  error?: string;
  /** 当前是否在 loopback 之外（界面显示黄色标记） */
  external: boolean;
  /** 页面请求跳外部站点，等用户确认 */
  pendingExternal?: string;
  /** 预览已关闭（主进程销毁视图时推一条） */
  closed?: boolean;
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;
const URL_IN_TEXT =
  /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#][^\s"'<>`]*)?/gi;

/** 去掉终端 ANSI 颜色，避免把 \x1b[32m 也算进 URL。 */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  return LOOPBACK_V4.test(host);
}

/**
 * 判定一次导航：loopback 放行；外部 host 若已在任务白名单里放行，
 * 否则交给界面确认；其它协议一律拒绝。
 */
export function classifyPreviewUrl(raw: string, policy: PreviewPolicy = { allowedHosts: [] }): PreviewNavigation {
  const value = raw.trim();
  if (!value) return { action: 'deny', reason: '地址为空' };
  if (value === 'about:blank') return { action: 'allow', url: value };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { action: 'deny', reason: '不是合法的 URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { action: 'deny', reason: `预览只打开 http(s)，不支持 ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { action: 'deny', reason: '地址里不要带账号密码' };
  }

  const host = url.hostname.toLowerCase();
  if (isLoopbackHost(host)) return { action: 'allow', url: url.toString() };

  const allowed = policy.allowedHosts.some((item) => item.toLowerCase() === host);
  if (allowed) return { action: 'allow', url: url.toString() };
  return { action: 'external', url: url.toString(), host };
}

/** 从命令输出里找本机地址；只做建议，不自动打开。 */
export function extractPreviewUrls(text: string): string[] {
  if (!text) return [];
  const clean = stripAnsi(text);
  const found = new Set<string>();
  for (const match of clean.matchAll(URL_IN_TEXT)) {
    const raw = match[0].replace(/[).,;:'"`\]}]+$/g, '');
    const verdict = classifyPreviewUrl(raw);
    if (verdict.action !== 'allow') continue;
    found.add(verdict.url.replace(/\/$/, ''));
  }
  return [...found];
}

/** 截图/图片路径 → 自定义协议地址（只用于界面展示）。 */
export function artifactUrl(filePath: string): string {
  return `olivia-artifact://local/${encodeURIComponent(filePath)}`;
}

export function isImageFile(filePath: string): boolean {
  return /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(filePath);
}

export function isAudioFile(filePath: string): boolean {
  return /\.(wav|mp3|ogg|m4a|aac)$/i.test(filePath);
}
