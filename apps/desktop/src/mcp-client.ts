import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MCP_PROTOCOL_LEGACY,
  MCP_PROTOCOL_MODERN,
  type McpEra,
  type McpServerConfig,
  type McpToolInfo,
} from '@olivia/core';

/**
 * MCP 客户端（主进程）。
 *
 * - 现代协议 `2026-07-28`：无握手，版本与能力随每个请求的 `_meta` 携带；
 *   用 `server/discover` 探测；结果是 `resultType: complete`。
 * - 传统协议（`2025-11-25` 及更早）：`initialize` 握手 + `notifications/initialized`。
 *
 * 只实现我们需要的三个 RPC：discover / tools/list / tools/call。
 * MRTR（`input_required`）一律拒绝——无人值守时不能假装能替用户回答。
 */

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const STDIO_ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'APPDATA', 'LOCALAPPDATA',
];

function stdioEnv(config: McpServerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of STDIO_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(config.env ?? {})) env[key] = value;
  return env;
}

interface JsonRpcTransport {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): void;
}

/** stdio：换行分隔的 JSON-RPC（不是 LSP 的 Content-Length 框架）。 */
class StdioTransport implements JsonRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly config: McpServerConfig,
    private readonly log: (line: string) => void,
  ) {
    this.child = spawn(config.command!.trim(), config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: stdioEnv(config),
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) this.log(`[mcp:${config.id}] ${text.slice(0, 400)}`);
    });
    this.child.on('error', (error) => this.failAll(new McpError(`无法启动服务器：${error.message}`)));
    this.child.on('close', (code) => {
      this.closed = true;
      this.failAll(new McpError(`服务器进程已退出（code ${code ?? 'null'}）`));
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
    // 防御：单行超长说明对端没按换行分帧
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.buffer = '';
      this.log('[mcp] 丢弃超长未分帧数据');
    }
  }

  private handleLine(line: string): void {
    let message: RpcResponse | { method?: string };
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      this.log(`[mcp] 非法 JSON：${line.slice(0, 120)}`);
      return;
    }
    if ('id' in message && (message as RpcResponse).id !== undefined && !('method' in message)) {
      const response = message as RpcResponse;
      const pending = this.pending.get(String(response.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(response.id));
      if (response.error) {
        pending.reject(new McpError(response.error.message || '服务器返回错误', response.error.code));
      } else {
        pending.resolve(response.result ?? {});
      }
      return;
    }
    if ('method' in message && (message as { method?: string }).method) {
      // 通知（如 tools/list_changed）暂不消费，只记日志
      this.log(`[mcp] 通知：${(message as { method: string }).method}`);
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new McpError('连接已关闭'));
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new McpError(`请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(new McpError(`写入失败：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // 通知失败不影响主流程
    }
  }

  close(): void {
    this.closed = true;
    this.failAll(new McpError('连接已关闭'));
    try {
      this.child.kill();
    } catch {
      // 忽略
    }
  }
}

/** Streamable HTTP：单端点 POST，响应是 JSON 或请求级 SSE 流。 */
class HttpTransport implements JsonRpcTransport {
  private nextId = 1;
  private sessionId?: string;
  protocolVersion = MCP_PROTOCOL_MODERN;

  constructor(
    private readonly config: McpServerConfig,
    private readonly headers: Record<string, string>,
    private readonly log: (line: string) => void,
  ) {}

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    headers['MCP-Protocol-Version'] = this.protocolVersion;
    return headers;
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = await fetch(this.config.url!, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new McpError(`HTTP ${response.status}：${detail || response.statusText}`, response.status);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return await this.readSse(response, id);
    }
    const json = (await response.json()) as RpcResponse;
    if (json.error) throw new McpError(json.error.message || '服务器返回错误', json.error.code);
    return json.result ?? {};
  }

  private async readSse(response: Response, id: number): Promise<Record<string, unknown>> {
    if (!response.body) throw new McpError('SSE 响应没有 body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const message = JSON.parse(payload) as RpcResponse;
            if (message.id === id) {
              if (message.error) throw new McpError(message.error.message || '服务器返回错误', message.error.code);
              return message.result ?? {};
            }
          } catch (error) {
            if (error instanceof McpError) throw error;
            this.log(`[mcp] SSE 非法 JSON：${payload.slice(0, 120)}`);
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    throw new McpError('SSE 流结束但没有收到对应响应');
  }

  notify(): void {
    // 现代协议没有客户端→服务器的通知需求（取消走请求级流），这里留空
  }

  close(): void {
    // 无长连接需要关闭
  }
}

export interface McpClientOptions {
  log?: (line: string) => void;
  artifactsDir: string;
  /** 解析 `vault:mcp:<id>:<Header>` 这类引用 */
  resolveSecret?: (reference: string) => string | null;
}

export interface McpCallOutcome {
  ok: boolean;
  text: string;
  artifacts: string[];
}

export class McpClient {
  private constructor(
    readonly config: McpServerConfig,
    private readonly transport: JsonRpcTransport,
    private readonly options: McpClientOptions,
  ) {}

  era: McpEra = 'modern';
  protocolVersion = MCP_PROTOCOL_MODERN;
  serverInfo?: { name: string; version: string };
  instructions?: string;

  static async connect(config: McpServerConfig, options: McpClientOptions): Promise<McpClient> {
    const log = options.log ?? (() => undefined);
    if (config.transport === 'stdio') {
      const transport = new StdioTransport(config, log);
      const client = new McpClient(config, transport, options);
      await client.handshake();
      return client;
    }

    const headers: Record<string, string> = {};
    for (const [name, raw] of Object.entries(config.headers ?? {})) {
      const value = raw.startsWith('vault:') ? options.resolveSecret?.(raw) ?? '' : raw;
      if (value) headers[name] = value;
    }
    const transport = new HttpTransport(config, headers, log);
    const client = new McpClient(config, transport, options);
    await client.handshake();
    return client;
  }

  private meta(): Record<string, unknown> {
    return {
      'io.modelcontextprotocol/protocolVersion': this.protocolVersion,
      'io.modelcontextprotocol/clientInfo': { name: 'OliviaCode', version: '0.7.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const body = this.era === 'modern' ? { ...params, _meta: this.meta() } : params;
    return await this.transport.request(method, body, timeoutMs);
  }

  /**
   * 双时代握手：先 `server/discover`（现代）；失败就回退 `initialize`（传统）。
   * 现代协议下这一步顺便拿到服务器身份与能力。
   */
  private async handshake(): Promise<void> {
    const timeout = this.config.timeoutMs ?? 20_000;
    try {
      const result = await this.request('server/discover', {}, Math.min(timeout, 15_000));
      const versions = Array.isArray(result.supportedVersions)
        ? (result.supportedVersions as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
      this.era = 'modern';
      this.protocolVersion = versions.includes(MCP_PROTOCOL_MODERN) ? MCP_PROTOCOL_MODERN : versions[0] ?? MCP_PROTOCOL_MODERN;
      this.captureIdentity(result);
      return;
    } catch (error) {
      // 传统服务器要么不认这个方法（-32601 / 404 / 405），要么直接报参数错误
      this.era = 'legacy';
      const init = await this.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_LEGACY[0],
          capabilities: {},
          clientInfo: { name: 'OliviaCode', version: '0.7.0' },
        },
        Math.min(timeout, 20_000),
      ).catch((initError) => {
        const first = error instanceof Error ? error.message : String(error);
        const second = initError instanceof Error ? initError.message : String(initError);
        throw new McpError(`无法识别协议：discover 失败（${first}），initialize 也失败（${second}）`);
      });
      const version = typeof init.protocolVersion === 'string' ? init.protocolVersion : MCP_PROTOCOL_LEGACY[0];
      this.protocolVersion = version;
      this.captureIdentity(init);
      this.transport.notify('notifications/initialized', {});
    }
  }

  private captureIdentity(result: Record<string, unknown>): void {
    const meta = result._meta as Record<string, unknown> | undefined;
    const info = (meta?.['io.modelcontextprotocol/serverInfo'] ?? result.serverInfo) as
      | { name?: unknown; version?: unknown }
      | undefined;
    if (info && typeof info.name === 'string') {
      this.serverInfo = { name: info.name, version: typeof info.version === 'string' ? info.version : '' };
    }
    if (typeof result.instructions === 'string') this.instructions = result.instructions.slice(0, 2000);
  }

  /** 分页拉完整个工具列表。 */
  async listTools(): Promise<McpToolInfo[]> {
    const timeout = Math.min(this.config.timeoutMs ?? 20_000, 20_000);
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, timeout);
      for (const raw of (Array.isArray(result.tools) ? result.tools : []) as Record<string, unknown>[]) {
        if (typeof raw?.name !== 'string') continue;
        tools.push({
          name: raw.name,
          title: typeof raw.title === 'string' ? raw.title : undefined,
          description: typeof raw.description === 'string' ? raw.description : undefined,
          inputSchema:
            raw.inputSchema && typeof raw.inputSchema === 'object'
              ? (raw.inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} },
          annotations:
            raw.annotations && typeof raw.annotations === 'object'
              ? (raw.annotations as Record<string, unknown>)
              : undefined,
        });
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /** 调工具；结果里的二进制落 artifacts，返回给模型的是文本 + 占位。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
    const timeout = this.config.timeoutMs ?? 60_000;
    const result = await this.request('tools/call', { name, arguments: args }, timeout);
    if (result.resultType === 'input_required') {
      throw new McpError('该工具需要交互输入（MRTR），当前没有可应答的人，已拒绝', -32003);
    }
    const content = Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : [];
    const texts: string[] = [];
    const artifacts: string[] = [];
    for (const item of content) {
      const type = typeof item.type === 'string' ? item.type : '';
      if (type === 'text' && typeof item.text === 'string') {
        texts.push(item.text);
        continue;
      }
      if ((type === 'image' || type === 'audio') && typeof item.data === 'string') {
        const saved = await this.saveArtifact(type, item.data, typeof item.mimeType === 'string' ? item.mimeType : '');
        if (saved) {
          artifacts.push(saved);
          texts.push(`[${type === 'image' ? '图片' : '音频'}已保存到 ${saved}]`);
        } else {
          texts.push(`[${type} 内容过大，已丢弃]`);
        }
        continue;
      }
      if (type === 'resource') {
        const resource = item.resource as Record<string, unknown> | undefined;
        if (typeof resource?.text === 'string') texts.push(resource.text);
        else texts.push(`[资源 ${String(resource?.uri ?? '')}]`);
        continue;
      }
      if (type === 'resource_link' && typeof item.uri === 'string') {
        texts.push(`[资源链接 ${item.uri}]`);
        continue;
      }
    }
    if (texts.length === 0 && result.structuredContent !== undefined) {
      texts.push(JSON.stringify(result.structuredContent, null, 2));
    }
    return {
      ok: result.isError !== true,
      text: texts.join('\n').trim() || '（工具没有返回文本内容）',
      artifacts,
    };
  }

  private async saveArtifact(kind: string, base64: string, mimeType: string): Promise<string | null> {
    if (base64.length > 8 * 1024 * 1024) return null;
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('wav') ? 'wav' : kind === 'image' ? 'bin' : 'dat';
    const file = path.join(this.options.artifactsDir, `mcp_${this.config.id}_${Date.now().toString(36)}.${ext}`);
    try {
      await fs.mkdir(this.options.artifactsDir, { recursive: true });
      await fs.writeFile(file, Buffer.from(base64, 'base64'));
      return file;
    } catch {
      return null;
    }
  }

  close(): void {
    this.transport.close();
  }
}