import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SKILL_DOC_FILE,
  SKILL_LOCK_FILE,
  SKILL_MANIFEST_FILE,
  isSafeRelativePath,
  parseSkill,
  type SkillInfo,
  type SkillLockFile,
  type SkillSource,
} from '@olivia/core';

/**
 * 团队技能：扫描、安装、启用、加载。
 *
 * 完整性：安装时写 `.olivia-lock.json`（逐文件 sha256）。之后文件被改动就标记「已被修改」，
 * 自动停用并要求重新确认——不能指望 SKILL.md 给自己算哈希。
 */

interface SkillStateEntry {
  hash: string;
  enabled: boolean;
  confirmedAt: number;
}

type SkillStateFile = Record<string, Record<string, SkillStateEntry>>;

export interface SkillStoreOptions {
  stateFile: string;
  personalDir: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.olivia']);

export class SkillStore {
  constructor(private readonly options: SkillStoreOptions) {}

  private workspaceKey(workspace: string): string {
    return path.resolve(workspace).toLowerCase();
  }

  private async readState(): Promise<SkillStateFile> {
    try {
      const raw = await fs.readFile(this.options.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as SkillStateFile) : {};
    } catch {
      return {};
    }
  }

  private async writeState(state: SkillStateFile): Promise<void> {
    await fs.mkdir(path.dirname(this.options.stateFile), { recursive: true });
    const temp = `${this.options.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, this.options.stateFile);
  }

  private dirsFor(workspace: string): { dir: string; source: SkillSource }[] {
    return [
      { dir: path.join(workspace, '.olivia', 'skills'), source: 'workspace' },
      { dir: this.options.personalDir, source: 'personal' },
    ];
  }

  private async listDirs(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  }

  /** 计算目录内容哈希（忽略 lock 与隐藏文件、node_modules）。 */
  private async hashDir(dir: string): Promise<{ hash: string; files: Record<string, string> }> {
    const files: Record<string, string> = {};
    const walk = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== SKILL_DOC_FILE) continue;
        const full = path.join(current, entry.name);
        const rel = path.relative(dir, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await walk(full);
          continue;
        }
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > 256 * 1024) continue;
        const buffer = await fs.readFile(full).catch(() => null);
        if (!buffer) continue;
        files[rel] = createHash('sha256').update(buffer).digest('hex');
      }
    };
    await walk(dir);
    const joined = Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rel, hash]) => `${rel}:${hash}`)
      .join('\n');
    return { hash: createHash('sha256').update(joined).digest('hex'), files };
  }

  private async readSkill(dir: string, source: SkillSource, state: SkillStateFile, workspace: string): Promise<SkillInfo> {
    const name = path.basename(dir);
    const info: SkillInfo = {
      name,
      description: '',
      version: '0.0.0',
      source,
      dir,
      intact: false,
      enabled: false,
      requires: {},
      scripts: [],
      modifiedFiles: [],
      instructionsChars: 0,
    };
    const doc = await fs.readFile(path.join(dir, SKILL_DOC_FILE), 'utf8').catch(() => null);
    if (!doc) return { ...info, description: '（缺少 SKILL.md）' };
    const manifestRaw = await fs.readFile(path.join(dir, SKILL_MANIFEST_FILE), 'utf8').catch(() => null);
    const parsed = parseSkill(doc, manifestRaw);
    if (!parsed.ok) return { ...info, description: `（技能无效：${parsed.error}）` };

    const current = await this.hashDir(dir);
    const lock = await fs.readFile(path.join(dir, SKILL_LOCK_FILE), 'utf8').catch(() => null);
    let lockData: SkillLockFile | null = null;
    try {
      if (lock) lockData = JSON.parse(lock) as SkillLockFile;
    } catch {
      lockData = null;
    }
    const modifiedFiles = lockData
      ? Object.entries(current.files)
          .filter(([rel, hash]) => lockData!.files[rel] !== hash)
          .map(([rel]) => rel)
          .concat(Object.keys(lockData.files).filter((rel) => !(rel in current.files)))
      : [];
    const intact = lockData ? current.hash === lockData.hash : true;
    const entry = state[this.workspaceKey(workspace)]?.[parsed.skill.manifest.name];
    const enabled = Boolean(entry?.enabled) && intact && entry?.hash === current.hash;

    return {
      ...info,
      name: parsed.skill.manifest.name,
      description: parsed.skill.manifest.description,
      version: parsed.skill.manifest.version,
      intact,
      enabled,
      requires: parsed.skill.manifest.requires ?? {},
      scripts: parsed.skill.manifest.scripts ?? [],
      modifiedFiles,
      instructionsChars: parsed.skill.instructions.length,
    };
  }

  async scan(workspace: string): Promise<SkillInfo[]> {
    if (!workspace) return [];
    const state = await this.readState();
    const out: SkillInfo[] = [];
    for (const { dir, source } of this.dirsFor(workspace)) {
      for (const skillDir of await this.listDirs(dir)) {
        out.push(await this.readSkill(skillDir, source, state, workspace));
      }
    }
    return out;
  }

  /** 系统提示里的技能目录（只给名字与一句话）。 */
  async catalog(workspace: string): Promise<{ name: string; description: string }[]> {
    const skills = await this.scan(workspace);
    return skills
      .filter((skill) => skill.enabled && skill.intact && skill.description)
      .slice(0, 30)
      .map((skill) => ({ name: skill.name, description: skill.description }));
  }

  private find(skills: SkillInfo[], name: string): SkillInfo | undefined {
    return skills.find((skill) => skill.name === name);
  }

  async setEnabled(workspace: string, name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const skills = await this.scan(workspace);
    const skill = this.find(skills, name);
    if (!skill) return { ok: false, error: '技能不存在' };
    if (enabled && !skill.intact) {
      return { ok: false, error: '技能内容已被修改，需要重新确认后才能启用' };
    }
    const { hash } = await this.hashDir(skill.dir);
    const state = await this.readState();
    const key = this.workspaceKey(workspace);
    state[key] = state[key] ?? {};
    state[key]![name] = { hash, enabled, confirmedAt: Date.now() };
    await this.writeState(state);
    return { ok: true };
  }

  /** 从目录安装到工作区（复制 + 写 lock + 确认启用）。 */
  async install(workspace: string, sourceDir: string, options: { overwrite?: boolean } = {}): Promise<{ ok: boolean; skill?: SkillInfo; error?: string }> {
    const doc = await fs.readFile(path.join(sourceDir, SKILL_DOC_FILE), 'utf8').catch(() => null);
    if (!doc) return { ok: false, error: `源目录缺少 ${SKILL_DOC_FILE}` };
    const manifestRaw = await fs.readFile(path.join(sourceDir, SKILL_MANIFEST_FILE), 'utf8').catch(() => null);
    const parsed = parseSkill(doc, manifestRaw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const name = parsed.skill.manifest.name;

    const targetRoot = path.join(workspace, '.olivia', 'skills');
    const target = path.join(targetRoot, name);
    if (!isSafeRelativePath(name)) return { ok: false, error: '技能名不合法' };
    const exists = await fs.stat(target).then(() => true).catch(() => false);
    if (exists && !options.overwrite) return { ok: false, error: `已存在同名技能：${name}` };

    await fs.mkdir(targetRoot, { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });

    // 只复制安全相对路径的文件；跳过隐藏目录与超大文件
    const copy = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(current, entry.name);
        const rel = path.relative(sourceDir, full).split(path.sep).join('/');
        if (!isSafeRelativePath(rel)) return;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await fs.mkdir(path.join(target, rel), { recursive: true });
          await copy(full);
          continue;
        }
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > 256 * 1024) continue;
        await fs.copyFile(full, path.join(target, rel));
      }
    };
    await copy(sourceDir);

    const { hash, files } = await this.hashDir(target);
    const lock: SkillLockFile = { version: 1, installedAt: Date.now(), hash, files };
    await fs.writeFile(path.join(target, SKILL_LOCK_FILE), JSON.stringify(lock, null, 2), 'utf8');

    const state = await this.readState();
    const key = this.workspaceKey(workspace);
    state[key] = state[key] ?? {};
    state[key]![name] = { hash, enabled: true, confirmedAt: Date.now() };
    await this.writeState(state);

    const skills = await this.scan(workspace);
    return { ok: true, skill: this.find(skills, name) };
  }

  /** 技能内容被改动后，用户确认新版本：重新生成 lock 并启用。 */
  async confirm(workspace: string, name: string): Promise<{ ok: boolean; error?: string }> {
    const skills = await this.scan(workspace);
    const skill = this.find(skills, name);
    if (!skill) return { ok: false, error: '技能不存在' };
    const { hash, files } = await this.hashDir(skill.dir);
    const lock: SkillLockFile = { version: 1, installedAt: Date.now(), hash, files };
    await fs.writeFile(path.join(skill.dir, SKILL_LOCK_FILE), JSON.stringify(lock, null, 2), 'utf8');
    const state = await this.readState();
    const key = this.workspaceKey(workspace);
    state[key] = state[key] ?? {};
    state[key]![name] = { hash, enabled: true, confirmedAt: Date.now() };
    await this.writeState(state);
    return { ok: true };
  }

  async uninstall(workspace: string, name: string): Promise<{ ok: boolean; error?: string }> {
    const skills = await this.scan(workspace);
    const skill = this.find(skills, name);
    if (!skill) return { ok: false, error: '技能不存在' };
    if (skill.source === 'personal') return { ok: false, error: '个人技能请在文件管理器里删除' };
    await fs.rm(skill.dir, { recursive: true, force: true });
    const state = await this.readState();
    delete state[this.workspaceKey(workspace)]?.[name];
    await this.writeState(state);
    return { ok: true };
  }

  /** `use_skill`：返回指令正文 + 小文件内容（避免模型再逐个 read_file）。 */
  async load(workspace: string, name: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    const skills = await this.scan(workspace);
    const skill = this.find(skills, name);
    if (!skill) return { ok: false, error: `没有这个技能：${name}` };
    if (!skill.intact) {
      return { ok: false, error: `技能「${name}」的文件与安装时不一致，已停用，请让用户重新确认` };
    }
    if (!skill.enabled) return { ok: false, error: `技能「${name}」未启用` };

    const doc = await fs.readFile(path.join(skill.dir, SKILL_DOC_FILE), 'utf8');
    const manifestRaw = await fs.readFile(path.join(skill.dir, SKILL_MANIFEST_FILE), 'utf8').catch(() => null);
    const parsed = parseSkill(doc, manifestRaw);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const parts = [`[技能：${skill.name} v${skill.version}]\n\n${parsed.skill.instructions}`];
    const scripts = skill.scripts;
    if (scripts.length > 0) {
      parts.push(
        ['', '可用脚本（用 run_command 以参数数组调用，不要拼 shell）：', ...scripts.map((script) => `- ${script.name}: ${script.command} ${(script.args ?? []).join(' ')}`)].join(
          '\n',
        ),
      );
    }

    // 小文本文件内联进来（含子目录，最多 5 个）；大文件提示让模型自己读
    const extras: string[] = [];
    const collect = async (dir: string, depth: number): Promise<void> => {
      if (extras.length >= 5 || depth > 3) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (extras.length >= 5) break;
        if (entry.name.startsWith('.')) continue;
        if (depth === 0 && (entry.name === SKILL_DOC_FILE || entry.name === SKILL_MANIFEST_FILE)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await collect(full, depth + 1);
          continue;
        }
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > 8 * 1024) continue;
        const text = await fs.readFile(full, 'utf8').catch(() => null);
        if (text === null || text.includes('\u0000')) continue;
        const rel = path.relative(skill.dir, full).split(path.sep).join('/');
        extras.push(`--- ${rel} ---\n${text}`);
      }
    };
    await collect(skill.dir, 0);
    if (extras.length > 0) parts.push(['', '附带的参考文件：', ...extras].join('\n'));
    return { ok: true, text: parts.join('\n') };
  }
}