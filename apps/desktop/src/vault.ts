import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { GitProvider, VaultStatus } from '@olivia/core';

/** 令牌保险箱：safeStorage 加密后落盘，只有主进程能读。 */

interface VaultData {
  gitcode?: string;
  github?: string;
  /** 无人值守运行用的模型端点；Key 同样只写不读 */
  model?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

function vaultPath(): string {
  return path.join(app.getPath('userData'), 'credentials.bin');
}

function read(): VaultData {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const encrypted = fs.readFileSync(vaultPath());
    if (encrypted.length === 0) return {};
    const json = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(json) as VaultData;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(data: VaultData): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用（缺少 DPAPI/Keychain），为安全起见拒绝保存令牌');
  }
  fs.mkdirSync(path.dirname(vaultPath()), { recursive: true });
  fs.writeFileSync(vaultPath(), safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
}

export function token(provider: GitProvider): string | null {
  return read()[provider] ?? null;
}

export function setToken(provider: GitProvider, value: string): void {
  const data = read();
  const trimmed = value.trim();
  if (trimmed) data[provider] = trimmed;
  else delete data[provider];
  write(data);
}

export function clearToken(provider: GitProvider): void {
  const data = read();
  delete data[provider];
  write(data);
}

export function status(): VaultStatus {
  const data = read();
  return { gitcode: Boolean(data.gitcode), github: Boolean(data.github) };
}

// —— 无人值守模型凭据 ——

export interface ModelCredential {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 主进程内部读取；渲染层没有这个通道。 */
export function modelCredential(): ModelCredential | null {
  const data = read();
  const model = data.model;
  if (!model?.apiKey) return null;
  return {
    baseUrl: model.baseUrl || 'https://api.deepseek.com/v1',
    apiKey: model.apiKey,
    model: model.model || 'deepseek-v4.1-flash',
  };
}

export function setModelCredential(input: ModelCredential): void {
  const data = read();
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  const model = input.model.trim();
  if (!apiKey) throw new Error('API Key 不能为空');
  data.model = {
    baseUrl: baseUrl || 'https://api.deepseek.com/v1',
    apiKey,
    model: model || 'deepseek-v4.1-flash',
  };
  write(data);
}

export function clearModelCredential(): void {
  const data = read();
  delete data.model;
  write(data);
}

/** 界面只回显「配没配」与端点/模型名，Key 永远不回显。 */
export function modelStatus(): { saved: boolean; baseUrl: string; model: string } {
  const credential = modelCredential();
  return {
    saved: Boolean(credential),
    baseUrl: credential?.baseUrl ?? '',
    model: credential?.model ?? '',
  };
}
