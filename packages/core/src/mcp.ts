import type { JsonSchema, JsonSchemaProperty, ToolSpec } from './tools';

/**
 * M6 · MCP 接入（客户端侧）。
 *
 * 目标协议：`2026-07-28`（现代：无握手，版本/能力随请求 `_meta` 携带，`server/discover` 探测）
 * 同时兼容 `2025-11-25` 及更早（传统：`initialize` 握手 + 会话）。
 *
 * 这里只放**双端共用**的类型与纯函数：命名映射、schema 降级。
 * 真正的传输与连接管理在主进程（apps/desktop/src/mcp-client.ts）。
 */

export type McpTransport = 'stdio' | 'http';
export type McpEra = 'modern' | 'legacy';
export type McpRisk = 'read' | 'write' | 'exec';

export const MCP_PROTOCOL_MODERN = '2026-07-28';
/** 传统协议里我们声明支持的版本，按新到旧 */
export const MCP_PROTOCOL_LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** stdio */
  command?: string;
  args?: string[];
  /** 显式环境变量白名单：不继承宿主全部环境，避免把模型密钥漏给第三方服务器 */
  env?: Record<string, string>;
  /** http（Streamable HTTP） */
  url?: string;
  /** 静态请求头；值可写成 `vault:mcp:<id>:<Header>`，由主进程从保险箱取 */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * 逐工具的风险判定；**同时也是工具的启用集合**：
   * 只有在这里出现过的工具才会暴露给模型（默认一个都不暴露，避免一接上就塞满上下文）。
   */
  risks?: Record<string, McpRisk>;
  createdAt: number;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpServerState {
  serverId: string;
  status: 'idle' | 'connecting' | 'ready' | 'error';
  era?: McpEra;
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  tools: McpToolInfo[];
  /** 逐工具的风险判定（默认 exec，用户可改判 read） */
  risks: Record<string, McpRisk>;
  /** 被降级/丢弃的 schema 细节，界面上要看得到 */
  warnings: string[];
  error?: string;
  connectedAt?: number;
}

export interface McpToolResult {
  ok: boolean;
  text: string;
  summary: string;
  rows?: string[];
  /** 二进制内容落盘后的路径（图片/音频），留给 M7 预览 */
  artifacts?: string[];
}

/** 单个服务器的工具预算：超过就不启用，宁可让人挑选也不要静默截断。 */
export const MCP_MAX_TOOLS_PER_SERVER = 48;
export const MCP_MAX_SCHEMA_BYTES = 2048;

/** 公开名 → 服务器原名的映射。 */
export interface McpToolBinding {
  publicName: string;
  serverId: string;
  rawName: string;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** 稳定的短哈希，用于超长名截断后保证唯一。 */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 6);
}

/**
 * 生产模型可见的工具名：`mcp__<server>__<tool>`。
 *
 * OpenAI 兼容端点对 function.name 有字符与长度限制，MCP 工具名又允许点号等字符，
 * 所以统一 slug 化；超长时截断并加哈希，保证「不同工具不会撞名」且可反查。
 */
export function mcpPublicToolName(serverId: string, toolName: string): string {
  const server = slug(serverId) || 'server';
  const tool = slug(toolName) || shortHash(toolName);
  const full = `mcp__${server}__${tool}`;
  if (full.length <= 60) return full;
  return `${full.slice(0, 53)}_${shortHash(full)}`;
}

/** 把 MCP 工具包装成本项目的 ToolSpec（risk 默认 exec）。 */
export function mcpToolSpec(server: McpServerConfig, tool: McpToolInfo, risk: McpRisk): ToolSpec {
  const { schema, warnings } = downcastSchema(tool.inputSchema);
  const description = [
    tool.description?.trim() || tool.name,
    warnings.length > 0 ? `（参数说明有降级：${warnings.slice(0, 3).join('；')}）` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    name: mcpPublicToolName(server.id, tool.name),
    description,
    risk,
    parameters: schema,
    kind: 'mcp',
    serverId: server.id,
    rawName: tool.name,
  };
}

// —— JSON Schema 降级 ——

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const ALLOWED_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

/**
 * 把 MCP 的完整 JSON Schema 降级成我们模型调用用的受限子集。
 *
 * 丢弃的只是提示质量，不影响安全性；但必须把降级原因带出来，
 * 否则「工具能调、参数老是不对」会很难查。
 */
export function downcastSchema(input: unknown): { schema: JsonSchema; warnings: string[] } {
  const warnings: string[] = [];
  const root: JsonSchema = { type: 'object', properties: {} };

  if (!isRecord(input)) {
    warnings.push('inputSchema 不是对象，按空参数处理');
    return { schema: root, warnings };
  }

  const defs = isRecord(input.$defs) ? input.$defs : isRecord(input.definitions) ? input.definitions : {};

  function resolveRef(node: Record<string, unknown>, depth: number): Record<string, unknown> {
    if (depth > 3) {
      warnings.push('$ref 嵌套超过 3 层，已降级为 object');
      return { type: 'object' };
    }
    const ref = node.$ref;
    if (typeof ref !== 'string') return node;
    const name = ref.split('/').pop() ?? '';
    const target = defs[name];
    if (!isRecord(target)) {
      warnings.push(`无法解析 $ref: ${ref}`);
      return { type: 'object' };
    }
    return resolveRef(target, depth + 1);
  }

  function pickType(node: Record<string, unknown>): JsonSchemaProperty {
    const type = typeof node.type === 'string' ? node.type : undefined;
    if (type && ALLOWED_TYPES.has(type)) return build(type, node);
    // 没有 type 但有 anyOf/oneOf：取第一支并提示
    const branches = (Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null) as
      | unknown[]
      | null;
    if (branches && branches.length > 0 && isRecord(branches[0])) {
      warnings.push('anyOf/oneOf 只保留第一支');
      return pickType(resolveRef(branches[0], 1));
    }
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      return { type: 'string', enum: node.enum.map((item) => String(item)) };
    }
    warnings.push('缺少可识别的 type，按 string 处理');
    return { type: 'string' };
  }

  function build(type: string, node: Record<string, unknown>): JsonSchemaProperty {
    const out: JsonSchemaProperty = { type: type as JsonSchemaProperty['type'] };
    if (typeof node.description === 'string') out.description = node.description;
    if (Array.isArray(node.enum)) out.enum = node.enum.map((item) => String(item));
    if (type === 'array') {
      const items = isRecord(node.items) ? resolveRef(node.items, 1) : null;
      out.items = items ? pickType(items) : { type: 'string' };
    }
    if (type === 'object') {
      const properties: Record<string, JsonSchemaProperty> = {};
      if (isRecord(node.properties)) {
        for (const [key, value] of Object.entries(node.properties)) {
          if (!isRecord(value)) continue;
          properties[key] = pickType(resolveRef(value, 1));
        }
      }
      out.properties = properties;
      if (Array.isArray(node.required)) {
        out.required = node.required.filter((item): item is string => typeof item === 'string');
      }
    }
    return out;
  }

  if (isRecord(input.properties)) {
    for (const [key, value] of Object.entries(input.properties)) {
      if (!isRecord(value)) continue;
      root.properties[key] = pickType(resolveRef(value, 1));
    }
  } else {
    warnings.push('inputSchema 没有 properties，按空参数处理');
  }
  if (Array.isArray(input.required)) {
    root.required = input.required.filter((item): item is string => typeof item === 'string');
  }
  if (input.additionalProperties === false) root.additionalProperties = false;

  // $ref / anyOf / 额外约束这些「被丢掉的东西」统一汇总成一条可读警告
  const flattened: string[] = [];
  (function scan(node: unknown, depth: number): void {
    if (!isRecord(node) || depth > 4) return;
    if ('$ref' in node) flattened.push('$ref');
    if ('allOf' in node) flattened.push('allOf');
    if ('patternProperties' in node || 'additionalProperties' in node) flattened.push('additionalProperties');
    if ('format' in node) flattened.push('format');
    for (const value of Object.values(node)) scan(value, depth + 1);
  })(input, 0);
  if (flattened.length > 0) {
    warnings.push(`已忽略部分约束：${[...new Set(flattened)].join('、')}`);
  }

  try {
    if (JSON.stringify(root).length > MCP_MAX_SCHEMA_BYTES) {
      warnings.push(`参数 schema 超过 ${MCP_MAX_SCHEMA_BYTES} 字节，描述已截断`);
    }
  } catch {
    // JSON.stringify 失败极罕见，忽略
  }

  return { schema: root, warnings };
}

/** 校验一份服务器配置是否可用，返回人话错误。 */
export function validateServerConfig(config: Partial<McpServerConfig>): string | null {
  if (!config.name?.trim()) return '服务器名称不能为空';
  if (config.transport === 'stdio') {
    if (!config.command?.trim()) return 'stdio 服务器需要填启动命令';
  } else if (config.transport === 'http') {
    if (!config.url?.trim()) return 'HTTP 服务器需要填 URL';
    if (!/^https?:\/\//i.test(config.url.trim())) return 'HTTP 服务器 URL 必须以 http(s):// 开头';
  } else {
    return '未知的传输类型';
  }
  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000)) {
    return '超时至少 1000ms';
  }
  return null;
}