/**
 * M8 · 图片附件（双端共用类型与限制）。
 *
 * 文件只在 <userData>/artifacts 内；渲染层拿到的只是元数据与路径，
 * 真正读文件、缩放、重编码由主进程完成。
 */

export type AttachmentMime = 'image/png' | 'image/jpeg' | 'image/webp';

export const ATTACHMENT_MIMES: AttachmentMime[] = ['image/png', 'image/jpeg', 'image/webp'];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_IMAGE_EDGE = 1600;
export const MAX_ENCODED_BYTES = 2 * 1024 * 1024;

export interface ImageAttachment {
  id: string;
  /** 绝对路径；必须在 <userData>/artifacts 内 */
  path: string;
  mime: AttachmentMime;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  source: 'paste' | 'file' | 'preview' | 'mcp';
  createdAt: number;
}

export function isAttachmentMime(value: string): value is AttachmentMime {
  return (ATTACHMENT_MIMES as string[]).includes(value);
}

export function attachmentLabel(attachment: ImageAttachment): string {
  const parts = attachment.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? attachment.id;
}

export function attachmentDedupKey(attachment: ImageAttachment): string {
  return `${attachment.sha256}:${attachment.width}x${attachment.height}`;
}

/**
 * M8：图片 token 粗估。OpenAI 视觉计费按 512×512 瓦片，
 * 这里只用于面板构成与端点不报 usage 时的兜底，不作为账单依据。
 */
export function estimateImageTokens(width: number, height: number): number {
  const tiles = Math.max(1, Math.ceil(Math.max(1, width) / 512) * Math.ceil(Math.max(1, height) / 512));
  return 85 + tiles * 170;
}

/** 历史消息里不重复上传图片，只留一条可核对、可重新附上的文本引用。 */
export function attachmentTextRef(attachment: ImageAttachment): string {
  return `[图片：${attachmentLabel(attachment)}，已存 artifacts；需要再看时请从预览浮层「加入输入」重新附上]`;
}

/** 只接受图片附件；旧会话/恶意输入里的其它形状一律丢弃。 */
export function normalizeAttachments(value: unknown): ImageAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: ImageAttachment[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const attachment = item as Partial<ImageAttachment>;
    if (
      typeof attachment.id !== 'string' ||
      typeof attachment.path !== 'string' ||
      typeof attachment.mime !== 'string' ||
      !isAttachmentMime(attachment.mime) ||
      typeof attachment.width !== 'number' ||
      typeof attachment.height !== 'number' ||
      typeof attachment.bytes !== 'number' ||
      typeof attachment.sha256 !== 'string'
    ) {
      continue;
    }
    const key = `${attachment.id}:${attachment.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: attachment.id,
      path: attachment.path,
      mime: attachment.mime,
      width: attachment.width,
      height: attachment.height,
      bytes: attachment.bytes,
      sha256: attachment.sha256,
      source:
        attachment.source === 'paste' ||
        attachment.source === 'file' ||
        attachment.source === 'preview' ||
        attachment.source === 'mcp'
          ? attachment.source
          : 'file',
      createdAt: typeof attachment.createdAt === 'number' ? attachment.createdAt : Date.now(),
    });
    if (out.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
  }
  return out;
}
