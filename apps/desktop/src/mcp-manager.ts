import { randomUUID } from 'node:crypto';
import {
  MCP_MAX_TOOLS_PER_SERVER,
  mcpPublicToolName,
  mcpToolSpec,
  validateServerConfig,
  type McpRisk,
  type McpServerConfig,
  type McpServerState,
  type McpToolInfo,
  type McpToolResult,
  type RegisteredTool,
} from '@olivia/core';
import { McpClient } from './mcp-client';
import { McpStore } from './mcp-store';

/**
 * MCP 连接管理（主进程）。
 *
 * - 配置持久化在 `mcp.json`；密钥引用由保险箱解析。
 * - 只有 `config.risks[tool]` 存在的工具才会暴露给模型（默认全不暴露）。
 * - 调用前按需连接；服务器崩溃后下一次调用会重连。
 */
export interface McpManagerOptions {
  file: string;
  artifactsDir: string;
  resolveSecret: (reference: string) => string | null;
  log?: (line: string) => void;
  onChange?: (state: McpServerState) => void;
}

export class McpManager {
  private readonly store: McpStore;
  private readonly clients = new Map<string, McpClient>();
  private readonly states = new Map<string, McpServerState>();
  private readonly configs = new Map<string, McpServerConfig>();

  constructor(private readonly options: McpManagerOptions) {
    this.store = new McpStore(options.file);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  async load(): Promise<void> {
    const list = await this.store.list();
    this.configs.clear();
    for (const config of list) {
      this.configs.set(config.id, config);
      this.states.set(config.id, this.idleState(config));
    }
  }

  private idleState(config: McpServerConfig): McpServerState {
    return {
      serverId: config.id,
      status: 'idle',
      tools: [],
      risks: { ...(config.risks ?? {}) },
      warnings: [],
    };
  }

  private publish(state: McpServerState): McpServerState {
    this.states.set(state.serverId, state);
    this.options.onChange?.(structuredClone(state));
    return state;
  }

  listConfigs(): McpServerConfig[] {
    return [...this.configs.values()].map((item) => structuredClone(item));
  }

  state(serverId: string): McpServerState {
    return this.states.get(serverId) ?? { serverId, status: 'idle', tools: [], risks: {}, warnings: [] };
  }

  allStates(): McpServerState[] {
    return [...this.states.values()].map((item) => structuredClone(item));
  }

  async saveConfig(input: Partial<McpServerConfig> & { id?: string }): Promise<{ ok: boolean; error?: string; config?: McpServerConfig }> {
    const problem = validateServerConfig(input);
    if (problem) return { ok: false, error: problem };
    const existing = input.id ? this.configs.get(input.id) : undefined;
    const config: McpServerConfig = {
      id: existing?.id ?? input.id ?? `mcp_${randomUUID().slice(0, 8)}`,
      name: input.name!.trim(),
      transport: input.transport ?? 'stdio',
      enabled: input.enabled ?? existing?.enabled ?? true,
      command: input.command?.trim() || undefined,
      args: input.args ?? existing?.args,
      env: input.env ?? existing?.env,
      url: input.url?.trim() || undefined,
      headers: input.headers ?? existing?.headers,
      timeoutMs: input.timeoutMs,
      risks: input.risks ?? existing?.risks ?? {},
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.configs.set(config.id, config);
    await this.store.save([...this.configs.values()]);
    // 配置变了就断开，下次按需重连
    await this.disconnect(config.id);
    this.states.set(config.id, this.idleState(config));
    this.publish(this.state(config.id));
    return { ok: true, config };
  }

  async remove(serverId: string): Promise<void> {
    this.configs.delete(serverId);
    await this.disconnect(serverId);
    this.states.delete(serverId);
    await this.store.save([...this.configs.values()]);
  }

  /** 手动断开（保留配置）。 */
  async disconnectServer(serverId: string): Promise<void> {
    await this.disconnect(serverId);
    const config = this.configs.get(serverId);
    if (config) this.publish({ ...this.idleState(config), status: 'idle' });
  }

  async setEnabled(serverId: string, enabled: boolean): Promise<McpServerState> {
    const config = this.configs.get(serverId);
    if (!config) throw new Error('服务器不存在');
    config.enabled = enabled;
    await this.store.save([...this.configs.values()]);
    if (!enabled) await this.disconnect(serverId);
    return this.publish({ ...this.idleState(config), status: enabled ? 'idle' : 'idle' });
  }

  /** 勾选/取消一个工具，并指定它的风险（null = 不暴露）。 */
  async setToolRisk(serverId: string, toolName: string, risk: McpRisk | null): Promise<McpServerState> {
    const config = this.configs.get(serverId);
    if (!config) throw new Error('服务器不存在');
    const risks = { ...(config.risks ?? {}) };
    if (risk) risks[toolName] = risk;
    else delete risks[toolName];
    config.risks = risks;
    await this.store.save([...this.configs.values()]);
    const current = this.state(serverId);
    return this.publish({ ...current, risks });
  }

  private async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    client?.close();
  }

  async connect(serverId: string): Promise<McpServerState> {
    const existing = this.clients.get(serverId);
    if (existing) return this.state(serverId);
    const config = this.configs.get(serverId);
    if (!config) return this.publish({ serverId, status: 'error', tools: [], risks: {}, warnings: [], error: '服务器不存在' });
    if (!config.enabled) return this.publish({ ...this.idleState(config), error: '服务器已禁用' });

    const connecting: McpServerState = {
      serverId,
      status: 'connecting',
      tools: [],
      risks: { ...(config.risks ?? {}) },
      warnings: [],
    };
    this.publish(connecting);

    try {
      const client = await McpClient.connect(config, {
        artifactsDir: this.options.artifactsDir,
        log: (line) => this.log(line),
        resolveSecret: this.options.resolveSecret,
      });
      const tools = await client.listTools();
      const warnings: string[] = [];
      if (tools.length > MCP_MAX_TOOLS_PER_SERVER) {
        warnings.push(`工具数 ${tools.length} 超过上限 ${MCP_MAX_TOOLS_PER_SERVER}，只保留前 ${MCP_MAX_TOOLS_PER_SERVER} 个`);
        tools.splice(MCP_MAX_TOOLS_PER_SERVER);
      }
      this.clients.set(serverId, client);
      return this.publish({
        serverId,
        status: 'ready',
        era: client.era,
        protocolVersion: client.protocolVersion,
        serverInfo: client.serverInfo,
        instructions: client.instructions,
        tools,
        risks: { ...(config.risks ?? {}) },
        warnings,
        connectedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[mcp:${serverId}] 连接失败：${message}`);
      return this.publish({ serverId, status: 'error', tools: [], risks: {}, warnings: [], error: message });
    }
  }

  async connectAll(): Promise<void> {
    for (const config of this.configs.values()) {
      if (config.enabled) await this.connect(config.id);
    }
  }

  async refresh(serverId: string): Promise<McpServerState> {
    await this.disconnect(serverId);
    return await this.connect(serverId);
  }

  /** 暴露给模型的 MCP 工具（只含用户勾选过的）。 */
  registryTools(): RegisteredTool[] {
    const out: RegisteredTool[] = [];
    for (const config of this.configs.values()) {
      if (!config.enabled) continue;
      const state = this.state(config.id);
      if (state.status !== 'ready') continue;
      for (const tool of state.tools) {
        const risk = state.risks[tool.name];
        if (!risk) continue;
        out.push({ ...mcpToolSpec(config, tool, risk), kind: 'mcp' } as RegisteredTool);
      }
    }
    return out;
  }

  /** 按公开名调用；必要时先连接。 */
  async callTool(publicName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    for (const config of this.configs.values()) {
      if (!config.enabled) continue;
      const state = this.state(config.id);
      const tool = state.tools.find((item) => mcpPublicToolName(config.id, item.name) === publicName);
      if (!tool) continue;
      if (!state.risks[tool.name]) {
        return { ok: false, text: '这个工具没有在设置里启用', summary: '未启用' };
      }
      let client = this.clients.get(config.id);
      if (!client) {
        const connected = await this.connect(config.id);
        if (connected.status !== 'ready') {
          return { ok: false, text: `MCP 服务器不可用：${connected.error ?? '连接失败'}`, summary: '连接失败' };
        }
        client = this.clients.get(config.id);
      }
      if (!client) return { ok: false, text: 'MCP 连接已丢失', summary: '连接失败' };
      const started = Date.now();
      try {
        const outcome = await client.callTool(tool.name, args);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const clipped = outcome.text.length > 12_000 ? `${outcome.text.slice(0, 12_000)}\n…（已截断）` : outcome.text;
        return {
          ok: outcome.ok,
          text: clipped,
          summary: `${tool.name} · ${outcome.ok ? 'ok' : 'error'} · ${seconds}s`,
          rows: clipped.split('\n').filter(Boolean).slice(0, 4),
          artifacts: outcome.artifacts.length > 0 ? outcome.artifacts : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 连接层错误：断开，下次重连
        await this.disconnect(config.id);
        this.publish({ ...state, status: 'error', error: message });
        return { ok: false, text: `MCP 调用失败：${message}`, summary: '调用失败' };
      }
    }
    return { ok: false, text: `未知的 MCP 工具：${publicName}`, summary: '未知工具' };
  }

  stopAll(): void {
    for (const [serverId, client] of this.clients) {
      client.close();
      this.clients.delete(serverId);
    }
  }
}