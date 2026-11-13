import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  downcastSchema,
  mcpPublicToolName,
  validateServerConfig,
  type McpServerConfig,
} from '@olivia/core';
import { McpClient } from './mcp-client';
import { McpManager } from './mcp-manager';

/**
 * M6 · MCP 自检（不需要任何外部服务）。
 *
 * 覆盖：命名映射、schema 降级、stdio 双时代握手、HTTP（含 SSE）、工具调用、
 * 工具级错误、MRTR 拒绝、超时、进程崩溃、连接管理器的风险放行与调用。
 */

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const mockPath = path.join(process.cwd(), 'scripts', 'mock-mcp.cjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('mock http 没有起来');
}

function stdioConfig(id: string, args: string[], timeoutMs = 8000): McpServerConfig {
  return {
    id,
    name: id,
    transport: 'stdio',
    enabled: true,
    command: process.execPath,
    args: [mockPath, ...args],
    timeoutMs,
    createdAt: Date.now(),
  };
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'olivia-mcp-'));
  const artifacts = path.join(root, 'artifacts');
  const clients: McpClient[] = [];

  try {
    // —— A. 纯函数 ——
    const a = mcpPublicToolName('filesystem-server', 'read.file');
    const b = mcpPublicToolName('filesystem_server', 'read.file');
    check('A1 公开名带命名空间且不含非法字符', /^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/.test(a), a);
    check('A2 不同服务器不会撞名', a !== b, `${a} / ${b}`);
    const long = mcpPublicToolName('s'.repeat(60), 't'.repeat(60));
    check('A3 超长名截断且 ≤60', long.length <= 60, `${long.length} 字符`);

    const rich = downcastSchema({
      type: 'object',
      $defs: { mode: { type: 'string', enum: ['fast', 'slow'] } },
      properties: {
        mode: { $ref: '#/$defs/mode' },
        target: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        nested: { type: 'object', properties: { deep: { type: 'boolean' } }, required: ['deep'] },
      },
      required: ['mode'],
    });
    check('A4 $ref 展开为 enum', Array.isArray(rich.schema.properties.mode?.enum), JSON.stringify(rich.schema.properties.mode));
    check('A5 anyOf 取第一支', rich.schema.properties.target?.type === 'string', rich.schema.properties.target?.type ?? '?');
    check('A6 嵌套对象与 required 保留', rich.schema.properties.nested?.properties?.deep?.type === 'boolean');
    check('A7 降级有警告', rich.warnings.length > 0, rich.warnings.join('；'));
    const empty = downcastSchema({ type: 'object' });
    check('A8 无参数 schema 可用', empty.schema.type === 'object' && Object.keys(empty.schema.properties).length === 0);

    check('A9 stdio 缺命令被拒', validateServerConfig({ name: 'x', transport: 'stdio' }) !== null);
    check('A10 http 非 http(s) 被拒', validateServerConfig({ name: 'x', transport: 'http', url: 'ftp://a' }) !== null);

    // —— B. stdio 现代协议 ——
    const modern = await McpClient.connect(stdioConfig('modern', ['--modern', '--tools', '7']), {
      artifactsDir: artifacts,
      log: () => undefined,
    });
    clients.push(modern);
    check('B1 现代协议识别', modern.era === 'modern' && modern.protocolVersion === '2026-07-28', `${modern.era}/${modern.protocolVersion}`);
    check('B2 服务器身份', modern.serverInfo?.name === 'mock-mcp', JSON.stringify(modern.serverInfo));
    const tools = await modern.listTools();
    check('B3 tools/list', tools.length === 7, `${tools.length} 个`);
    const echo = await modern.callTool('echo', { text: 'hi' });
    check('B4 工具调用返回文本', echo.ok && echo.text === 'echo:hi', JSON.stringify(echo.text));
    const failed = await modern.callTool('fail_tool', {});
    check('B5 工具级错误映射为失败', failed.ok === false, failed.text);
    let mrtr = '';
    try {
      await modern.callTool('needs_input', {});
    } catch (error) {
      mrtr = error instanceof Error ? error.message : String(error);
    }
    check('B6 MRTR 被拒绝', mrtr.includes('交互输入'), mrtr);
    const image = await modern.callTool('image_result', {});
    const imageExists = image.artifacts[0] ? await fs.stat(image.artifacts[0]).then(() => true).catch(() => false) : false;
    check('B7 图片落 artifacts', imageExists && image.text.includes('图片'), image.artifacts[0] ?? '无');
    const big = await modern.callTool('big_result', {});
    check('B8 大结果原样返回（由上层截断）', big.text.length >= 20_000, `${big.text.length} 字符`);

    // —— C. stdio 传统协议 ——
    const legacy = await McpClient.connect(stdioConfig('legacy', ['--legacy', '--tools', '2']), {
      artifactsDir: artifacts,
      log: () => undefined,
    });
    clients.push(legacy);
    check('C1 传统协议回退', legacy.era === 'legacy' && legacy.protocolVersion === '2025-11-25', `${legacy.era}/${legacy.protocolVersion}`);
    check('C2 传统协议也能列工具', (await legacy.listTools()).length === 2);

    // —— D. Streamable HTTP（tools/list 走 SSE）——
    const port = await freePort();
    const httpMock = spawn(process.execPath, [mockPath, '--http', String(port), '--modern', '--sse', '--tools', '7'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await waitForPort(port);
      const http = await McpClient.connect(
        {
          id: 'httpmock',
          name: 'httpmock',
          transport: 'http',
          enabled: true,
          url: `http://127.0.0.1:${port}/mcp`,
          timeoutMs: 8000,
          createdAt: Date.now(),
        },
        { artifactsDir: artifacts, log: () => undefined },
      );
      clients.push(http);
      check('D1 HTTP 现代协议', http.era === 'modern');
      const httpTools = await http.listTools();
      check('D2 SSE 响应可解析', httpTools.length === 7, `${httpTools.length} 个`);
      const httpEcho = await http.callTool('echo', { text: 'http' });
      check('D3 HTTP 工具调用', httpEcho.ok && httpEcho.text === 'echo:http');
    } finally {
      httpMock.kill();
    }

    // —— E. 超时 ——
    const slow = await McpClient.connect(stdioConfig('slow', ['--modern', '--timeout'], 1200), {
      artifactsDir: artifacts,
      log: () => undefined,
    });
    clients.push(slow);
    let timedOut = '';
    try {
      await slow.callTool('echo', { text: 'x' });
    } catch (error) {
      timedOut = error instanceof Error ? error.message : String(error);
    }
    check('E1 调用超时', timedOut.includes('超时'), timedOut);

    // —— F. 进程崩溃 ——
    const crashy = await McpClient.connect(stdioConfig('crashy', ['--modern', '--crash']), {
      artifactsDir: artifacts,
      log: () => undefined,
    });
    clients.push(crashy);
    await crashy.listTools();
    let crashed = '';
    try {
      await crashy.callTool('echo', { text: 'x' });
    } catch (error) {
      crashed = error instanceof Error ? error.message : String(error);
    }
    check('F1 进程崩溃有明确错误', crashed.length > 0, crashed.slice(0, 60));

    // —— G. 连接管理器：风险即启用集合 ——
    const manager = new McpManager({
      file: path.join(root, 'mcp.json'),
      artifactsDir: artifacts,
      resolveSecret: () => null,
      log: () => undefined,
    });
    await manager.load();
    const saved = await manager.saveConfig(stdioConfig('managed', ['--modern', '--tools', '7']));
    check('G1 配置保存', saved.ok && Boolean(saved.config?.id), saved.error ?? '');
    const state = await manager.connect(saved.config!.id);
    check('G2 连接就绪并列出工具', state.status === 'ready' && state.tools.length === 7, state.error ?? '');
    check('G3 默认不暴露任何工具', manager.registryTools().length === 0);
    await manager.setToolRisk(saved.config!.id, 'echo', 'exec');
    const exposed = manager.registryTools();
    check('G4 勾选后暴露', exposed.length === 1 && exposed[0]!.risk === 'exec', exposed[0]?.name ?? '');
    const called = await manager.callTool(exposed[0]!.name, { text: 'managed' });
    check('G5 经管理器调用', called.ok && called.text === 'echo:managed', called.text);
    await manager.setToolRisk(saved.config!.id, 'echo', null);
    check('G6 取消勾选后不再暴露', manager.registryTools().length === 0);
    manager.stopAll();

    // —— H. 失败不拖垮其它服务器 ——
    const manager2 = new McpManager({
      file: path.join(root, 'mcp2.json'),
      artifactsDir: artifacts,
      resolveSecret: () => null,
      log: () => undefined,
    });
    await manager2.load();
    const broken = await manager2.saveConfig({
      id: 'broken',
      name: 'broken',
      transport: 'stdio',
      enabled: true,
      command: 'definitely-not-a-real-command-xyz',
      createdAt: Date.now(),
    });
    const brokenState = await manager2.connect(broken.config!.id);
    check('H1 连接失败有原因', brokenState.status === 'error' && Boolean(brokenState.error), brokenState.error?.slice(0, 60) ?? '');
    const good = await manager2.saveConfig(stdioConfig('good', ['--modern', '--tools', '2']));
    const goodState = await manager2.connect(good.config!.id);
    check('H2 单个服务器失败不影响其它', goodState.status === 'ready', goodState.error ?? '');
    manager2.stopAll();
  } finally {
    for (const client of clients) client.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('自检崩溃：', error);
  process.exitCode = 1;
});