/**
 * 工具契约：渲染层、主进程、模型三方共同遵守的唯一来源。
 * 加工具只改这里 + 主进程的执行分支，UI 不需要认识具体工具。
 */
export type ToolRisk = 'read' | 'write' | 'exec';

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: JsonSchemaProperty;
  enum?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: JsonSchema;
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'list_dir',
    description: '列出工作区目录树。自动忽略 node_modules、.git、dist。用于先建立仓库结构感。',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，默认仓库根目录' },
        depth: { type: 'number', description: '递归深度，默认 2，最大 4' },
      },
    },
  },
  {
    name: 'read_file',
    description: '读取工作区内一个文件的完整内容（超过 256KB 会被截断）。读之前先想清楚要读哪个。',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径，例如 src/App.tsx' } },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: '在工作区内做字面量检索，返回 路径:行号 与命中的那一行。查符号、报错文案、配置项时优先用它。',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的字面量' },
        include: { type: 'string', description: '可选，按扩展名过滤，例如 .tsx' },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_file',
    description: '写入或覆盖一个文件。仅在新建文件或整文件重写时使用；局部修改请用 apply_patch。',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    description:
      '局部修改文件：每条 edits 给出一段原文 old 与替换后的 new，old 必须在文件中唯一出现，否则报错。禁止凭记忆写 old，必须先 read_file。',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径' },
        edits: {
          type: 'array',
          description: '替换列表，按顺序应用',
          items: {
            type: 'object',
            properties: {
              old: { type: 'string', description: '文件中唯一存在的原文片段（含缩进）' },
              new: { type: 'string', description: '替换后的内容' },
            },
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'run_command',
    description:
      '在工作区根目录执行一条命令（不经过 shell，参数分开传）。用于跑测试、装依赖、构建。不要用它做文件修改。',
    risk: 'exec',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '可执行文件，例如 npm、node、git' },
        args: { type: 'array', description: '参数数组', items: { type: 'string' } },
        timeout_ms: { type: 'number', description: '超时毫秒，默认 120000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_status',
    description: '查看工作区当前的 git 分支与改动文件列表。改完代码后用来自检。',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: '查看未提交改动。可传 path 只看某个文件。',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '可选，相对路径' } },
    },
  },
  {
    name: 'git_commit',
    description:
      '把暂存区的改动提交。调用前先看 git_status；提交信息写清「改了什么、为什么」，首行不超过 60 字。未暂存的改动不会进这次提交。',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: '提交信息' } },
      required: ['message'],
    },
  },
  {
    name: 'git_push',
    description: '把当前分支推到 origin。需要用户已在设置里保存对应平台的令牌；绝不 force push。',
    risk: 'exec',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_create_pr',
    description:
      '在当前仓库创建 Pull Request，需要先 push。标题与描述要让用户先看；目标分支默认 main。',
    risk: 'exec',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR 标题' },
        body: { type: 'string', description: 'PR 描述（Markdown）' },
        base: { type: 'string', description: '目标分支，默认 main' },
      },
      required: ['title', 'body'],
    },
  },
];

export const TOOL_BY_NAME: Map<string, ToolSpec> = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function toolSpec(name: string): ToolSpec | undefined {
  return TOOL_BY_NAME.get(name);
}

export function isMutating(name: string): boolean {
  const risk = toolSpec(name)?.risk;
  return risk === 'write' || risk === 'exec';
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** 卡片标题里展示的一行说明。 */
export function describeCall(name: string, rawArgs: unknown): string {
  const args = asRecord(rawArgs);
  switch (name) {
    case 'read_file':
      return String(args.path ?? '');
    case 'list_dir':
      return String(args.path ?? '.');
    case 'search':
      return `"${String(args.query ?? '')}"${args.include ? ` · ${String(args.include)}` : ''}`;
    case 'write_file':
      return String(args.path ?? '');
    case 'apply_patch': {
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      return `${String(args.path ?? '')} · ${edits} 处修改`;
    }
    case 'run_command': {
      const list = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
      return [String(args.command ?? ''), ...list].join(' ').trim();
    }
    case 'git_diff':
      return String(args.path ?? '全部改动');
    case 'git_commit':
      return String(args.message ?? '').split('\n')[0]?.slice(0, 60) ?? '';
    case 'git_push':
      return '推送到 origin';
    case 'git_create_pr':
      return String(args.title ?? '');
    default:
      return '';
  }
}

/** 「始终允许」写进 .olivia/policy.json 时的匹配键。 */
export function approvalKey(name: string, rawArgs: unknown): string {
  const args = asRecord(rawArgs);
  if (name === 'run_command') {
    const list = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
    return `run_command:${[String(args.command ?? ''), ...list].join(' ').trim()}`;
  }
  if (name === 'write_file' || name === 'apply_patch') {
    const path = String(args.path ?? '');
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    return `${name}:${dir}`;
  }
  return `${name}:`;
}
