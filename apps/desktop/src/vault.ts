import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { GitProvider, VaultStatus } from '@olivia/core';

/** 令牌保险箱：safeStorage 加密后落盘，只有主进程能读。 */

interface VaultData {
  gitcode?: string;
  github?: string;
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
