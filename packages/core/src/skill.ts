/**
 * M6 · 团队技能（声明式能力包）。
 *
 * 技能 = 仓库里的一个目录：`SKILL.md`（元数据 + 给模型的指令）+ 可选 `olivia-skill.json`（权限/脚本）。
 * 技能**不执行自带二进制**：脚本只能通过 run_command 以参数数组调用，沿用既有围栏与审批。
 *
 * 完整性校验由客户端负责：安装时生成 `.olivia-lock.json`（每个文件的 sha256），
 * 之后文件被改动就标记「已被修改」，必须重新确认——不能指望 SKILL.md 给自己算哈希。
 */

export type SkillSource = 'workspace' | 'personal';

export interface SkillManifest {
  schema: 1;
  name: string;
  version: string;
  description: string;
  requires?: {
    tools?: string[];
    mcp?: string[];
    shell?: boolean;
  };
  scripts?: { name: string; command: string; args?: string[] }[];
  author?: string;
  license?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  dir: string;
  /** 文件哈希与安装时记录的一致 */
  intact: boolean;
  /** 用户确认并启用 */
  enabled: boolean;
  requires: NonNullable<SkillManifest['requires']>;
  scripts: NonNullable<SkillManifest['scripts']>;
  modifiedFiles: string[];
  instructionsChars: number;
}

export interface SkillLockFile {
  version: 1;
  installedAt: number;
  hash: string;
  files: Record<string, string>;
}

export const SKILL_MANIFEST_FILE = 'olivia-skill.json';
export const SKILL_DOC_FILE = 'SKILL.md';
export const SKILL_LOCK_FILE = '.olivia-lock.json';

export const SKILL_MAX_BYTES = 256 * 1024;
export const SKILL_MAX_FILES = 200;
export const SKILL_MAX_INSTRUCTIONS_CHARS = 24_000;

/** 极其轻量的 frontmatter 解析：只支持 `key: value` 单行，够 SKILL.md 用。 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: normalized };
  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  const data: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const value = match[2]!.trim().replace(/^["']|["']$/g, '');
    if (value) data[match[1]!] = value;
  }
  return { data, body };
}

/** 把 `tools: a, b` 这种单行列表拆开。 */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface ParsedSkill {
  manifest: SkillManifest;
  instructions: string;
}

/**
 * 从 SKILL.md（必需）与 olivia-skill.json（可选）解析出技能。
 * 元数据缺失时以 frontmatter 为准，让作者只写一个文件也能用。
 */
export function parseSkill(skillMd: string, manifestJson?: string | null): { ok: true; skill: ParsedSkill } | { ok: false; error: string } {
  const { data, body } = parseFrontmatter(skillMd);
  const instructions = body.trim();
  if (!instructions) return { ok: false, error: 'SKILL.md 没有正文（给模型的指令）' };
  if (instructions.length > SKILL_MAX_INSTRUCTIONS_CHARS) {
    return { ok: false, error: `SKILL.md 超过 ${SKILL_MAX_INSTRUCTIONS_CHARS} 字符` };
  }

  let json: Partial<SkillManifest> = {};
  if (manifestJson) {
    try {
      const parsed = JSON.parse(manifestJson) as unknown;
      if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'olivia-skill.json 不是对象' };
      json = parsed as Partial<SkillManifest>;
    } catch {
      return { ok: false, error: 'olivia-skill.json 不是合法 JSON' };
    }
  }

  const name = (json.name ?? data.name ?? '').trim();
  if (!name) return { ok: false, error: '缺少 name（frontmatter 或 olivia-skill.json）' };
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    return { ok: false, error: 'name 只能用字母、数字、下划线、连字符，且不超过 64 字符' };
  }
  const description = (json.description ?? data.description ?? '').trim();
  if (!description) return { ok: false, error: '缺少 description（一句话说明，进技能目录）' };

  const requires = {
    tools: json.requires?.tools ?? splitList(data.tools ?? data.requires),
    mcp: json.requires?.mcp ?? splitList(data.mcp),
    shell: json.requires?.shell ?? data.shell === 'true',
  };

  return {
    ok: true,
    skill: {
      manifest: {
        schema: 1,
        name,
        version: (json.version ?? data.version ?? '0.0.0').trim() || '0.0.0',
        description,
        requires,
        scripts: json.scripts ?? [],
        author: json.author ?? data.author,
        license: json.license ?? data.license,
      },
      instructions,
    },
  };
}

/** 技能目录内的相对路径必须安全：拒绝绝对路径、盘符、`..`。 */
export function isSafeRelativePath(rel: string): boolean {
  if (!rel || rel.trim() !== rel) return false;
  if (rel.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  const parts = rel.split(/[\\/]+/);
  return parts.every((part) => part !== '..' && part !== '' && part !== '.');
}

/** 脚本必须是参数数组，不接受带 shell 元字符的整串命令。 */
export function validateSkillScript(script: { name: string; command: string; args?: string[] }): string | null {
  if (!script.name?.trim()) return '脚本缺少 name';
  if (!script.command?.trim()) return `脚本 ${script.name} 缺少 command`;
  if (/[|&;<>()`$]/.test(script.command)) return `脚本 ${script.name} 的 command 不能包含 shell 元字符`;
  if (script.args && script.args.some((arg) => typeof arg !== 'string')) return `脚本 ${script.name} 的 args 必须是字符串数组`;
  return null;
}