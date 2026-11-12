import { promises as fs } from 'node:fs';
import path from 'node:path';
import { approvalKey } from '@olivia/core';

export interface PolicyRuleFile {
  version: 1;
  /** 形如 run_command:npm test、write_file:docs */
  allow: string[];
}

const EMPTY_POLICY: PolicyRuleFile = { version: 1, allow: [] };

export function policyPath(root: string): string {
  return path.join(root, '.olivia', 'policy.json');
}

export async function checkWorkspace(dir: string): Promise<{ ok: boolean; message: string; name?: string }> {
  if (!dir) return { ok: false, message: '没有选择目录' };
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return { ok: false, message: '这不是一个目录' };
    return { ok: true, message: 'ok', name: path.basename(dir) };
  } catch {
    return { ok: false, message: '目录不存在或没有访问权限' };
  }
}

export async function loadPolicy(root: string): Promise<PolicyRuleFile> {
  try {
    const raw = await fs.readFile(policyPath(root), 'utf8');
    const parsed = JSON.parse(raw) as PolicyRuleFile;
    if (!Array.isArray(parsed.allow)) return EMPTY_POLICY;
    return { version: 1, allow: parsed.allow.filter((item) => typeof item === 'string') };
  } catch {
    return EMPTY_POLICY;
  }
}

export async function rememberRule(root: string, tool: string, args: unknown): Promise<string> {
  const key = approvalKey(tool, args);
  const policy = await loadPolicy(root);
  if (policy.allow.includes(key)) return key;
  const next: PolicyRuleFile = { version: 1, allow: [...policy.allow, key] };
  await fs.mkdir(path.dirname(policyPath(root)), { recursive: true });
  await fs.writeFile(policyPath(root), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return key;
}

export function policyAllows(policy: PolicyRuleFile, tool: string, args: unknown): boolean {
  return policy.allow.includes(approvalKey(tool, args));
}
