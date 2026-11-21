import { app, nativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ENCODED_BYTES,
  MAX_IMAGE_EDGE,
  isAttachmentMime,
  type ImageAttachment,
} from '@olivia/core';

export interface AttachmentResolveResult {
  ok: boolean;
  error?: string;
  attachment?: ImageAttachment;
}

function artifactsRoot(): string {
  return path.resolve(path.join(app.getPath('userData'), 'artifacts'));
}

function insideArtifacts(target: string): boolean {
  const rel = path.relative(artifactsRoot(), target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function guessMime(buffer: Buffer): ImageAttachment['mime'] | null {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * M8 · 图片附件：
 * - 粘贴/文件选择 → 校验 → 等比缩到最长边 1600 → 重编码（丢 EXIF）→ 落 artifacts
 * - 预览截图 / MCP 图片 → adopt：只校验是否在 artifacts 内，不复制不改写
 */
export class AttachmentService {
  /** 重编码：JPEG/PNG 都到这里；失败返回 null，由调用方报错。 */
  private reencode(image: Electron.NativeImage, mime: ImageAttachment['mime']): { buffer: Buffer; mime: ImageAttachment['mime'] } | null {
    const size = image.getSize();
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(size.width, size.height));
    const resized =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'best',
          })
        : image;
    const wantsPng = mime === 'image/png';
    const buffer = wantsPng ? resized.toPNG() : resized.toJPEG(82);
    if (buffer.length === 0) return null;
    const outMime: ImageAttachment['mime'] = wantsPng ? 'image/png' : 'image/jpeg';
    return { buffer, mime: outMime };
  }

  async save(input: {
    dataUrl?: string;
    filePath?: string;
    source?: ImageAttachment['source'];
    name?: string;
  }): Promise<AttachmentResolveResult> {
    let raw: Buffer | null = null;
    try {
      if (input.dataUrl) {
        if (input.dataUrl.length > Math.ceil(MAX_ATTACHMENT_BYTES * 1.4)) {
          return { ok: false, error: '原图超过 10MB，请先压缩' };
        }
        const match = /^data:(image\/(?:png|jpeg|webp));base64,/i.exec(input.dataUrl.trim());
        if (!match) return { ok: false, error: '只支持 PNG / JPEG / WebP 图片（SVG / GIF 不接受）' };
        const declared = match[1]!.toLowerCase() as ImageAttachment['mime'];
        if (!isAttachmentMime(declared)) return { ok: false, error: '只支持 PNG / JPEG / WebP 图片' };
        const image = nativeImage.createFromDataURL(input.dataUrl);
        if (image.isEmpty()) return { ok: false, error: '这张图片读不出来（格式不支持或已损坏）' };
        const size = image.getSize();
        const encoded = this.reencode(image, declared);
        if (!encoded) return { ok: false, error: '图片重编码失败' };
        if (encoded.buffer.length > MAX_ENCODED_BYTES) {
          return { ok: false, error: '图片太大了：重编码后仍超过 2MB，请先压缩或裁切' };
        }
        await fs.mkdir(artifactsRoot(), { recursive: true });
        const ext = encoded.mime === 'image/png' ? 'png' : 'jpg';
        const file = path.join(artifactsRoot(), `upload_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}.${ext}`);
        await fs.writeFile(file, encoded.buffer);
        return {
          ok: true,
          attachment: {
            id: `img_${randomUUID().slice(0, 8)}`,
            path: file,
            mime: encoded.mime,
            width: Math.round(size.width * Math.min(1, MAX_IMAGE_EDGE / Math.max(size.width, size.height))),
            height: Math.round(size.height * Math.min(1, MAX_IMAGE_EDGE / Math.max(size.width, size.height))),
            bytes: encoded.buffer.length,
            sha256: sha256(encoded.buffer),
            source: input.source ?? 'file',
            createdAt: Date.now(),
          },
        };
      }
      if (input.filePath) {
        raw = await fs.readFile(input.filePath);
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!raw) return { ok: false, error: '没有收到图片数据' };
    if (raw.length > MAX_ATTACHMENT_BYTES) return { ok: false, error: '原图超过 10MB，请先压缩' };
    const mime = guessMime(raw);
    if (!mime) return { ok: false, error: '只支持 PNG / JPEG / WebP 图片（SVG / GIF 不接受）' };
    const image = nativeImage.createFromBuffer(raw);
    if (image.isEmpty()) return { ok: false, error: '这张图片读不出来（格式不支持或已损坏）' };
    const encoded = this.reencode(image, mime);
    if (!encoded) return { ok: false, error: '图片重编码失败' };
    if (encoded.buffer.length > MAX_ENCODED_BYTES) return { ok: false, error: '图片重编码后超过 2MB' };
    const size = image.getSize();
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(size.width, size.height));
    await fs.mkdir(artifactsRoot(), { recursive: true });
    const ext = encoded.mime === 'image/png' ? 'png' : 'jpg';
    const file = path.join(artifactsRoot(), `upload_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}.${ext}`);
    await fs.writeFile(file, encoded.buffer);
    return {
      ok: true,
      attachment: {
        id: `img_${randomUUID().slice(0, 8)}`,
        path: file,
        mime: encoded.mime,
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
        bytes: encoded.buffer.length,
        sha256: sha256(encoded.buffer),
        source: input.source ?? 'file',
        createdAt: Date.now(),
      },
    };
  }

  /** 已存在于 artifacts 的图片（预览截图、MCP 结果）：只校验，不复制。 */
  async adopt(filePath: string, source: ImageAttachment['source']): Promise<AttachmentResolveResult> {
    try {
      const real = await fs.realpath(filePath).catch(() => null);
      if (!real) return { ok: false, error: '这个文件不存在' };
      if (!insideArtifacts(real)) return { ok: false, error: '只接受应用 artifacts 目录里的图片' };
      const stat = await fs.stat(real);
      if (!stat.isFile()) return { ok: false, error: '不是文件' };
      if (stat.size > MAX_ENCODED_BYTES * 2) return { ok: false, error: '图片太大，先压缩一下' };
      const raw = await fs.readFile(real);
      const mime = guessMime(raw);
      if (!mime) return { ok: false, error: '只支持 PNG / JPEG / WebP 图片' };
      const image = nativeImage.createFromBuffer(raw);
      if (image.isEmpty()) return { ok: false, error: '这张图片读不出来' };
      const size = image.getSize();
      return {
        ok: true,
        attachment: {
          id: `img_${randomUUID().slice(0, 8)}`,
          path: real,
          mime,
          width: size.width,
          height: size.height,
          bytes: raw.length,
          sha256: sha256(raw),
          source,
          createdAt: Date.now(),
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 发给模型前把图片读成 data URL；调用方负责计数与大小上限。 */
  async readDataUrl(attachment: ImageAttachment): Promise<string | null> {
    try {
      const real = await fs.realpath(attachment.path).catch(() => null);
      if (!real || !insideArtifacts(real)) return null;
      const raw = await fs.readFile(real);
      if (raw.length > MAX_ENCODED_BYTES * 2) return null;
      return `data:${attachment.mime};base64,${raw.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
