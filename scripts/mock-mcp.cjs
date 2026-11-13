// Mock MCP 服务器：给自检用，不依赖任何外部服务。
//
// 用法：
//   node scripts/mock-mcp.cjs --modern              # stdio，现代协议（server/discover）
//   node scripts/mock-mcp.cjs --legacy              # stdio，传统协议（initialize 握手）
//   node scripts/mock-mcp.cjs --http 9311 --modern  # Streamable HTTP
//
// 可叠加的坏行为：
//   --tools N        工具数量（默认 4）
//   --timeout        某个工具永不返回
//   --crash          处理 2 个请求后退出
//   --sse            HTTP 模式下用 SSE 返回 tools/list
const http = require('node:http');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const mode = flag('--legacy') ? 'legacy' : 'modern';
const toolCount = Number(value('--tools', '4'));
const crashAfter = flag('--crash') ? 2 : 0;
const timeoutMode = flag('--timeout');
const httpPort = value('--http', null);

const SERVER_INFO = { name: 'mock-mcp', version: '1.0.0' };
const PROTOCOL_MODERN = '2026-07-28';
const PROTOCOL_LEGACY = '2025-11-25';

function toolDefs() {
  const tools = [
    {
      name: 'echo',
      description: '把输入原样返回',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: '两个数相加',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
    {
      name: 'fail_tool',
      description: '总是返回工具级错误',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'needs_input',
      description: '需要用户输入（MRTR）',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'big_result',
      description: '返回 20KB 文本',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'image_result',
      description: '返回一张 1x1 图片',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'rich_schema',
      description: '带 anyOf / $ref / enum 的复杂参数',
      inputSchema: {
        type: 'object',
        $defs: { mode: { type: 'string', enum: ['fast', 'slow'] } },
        properties: {
          mode: { $ref: '#/$defs/mode' },
          target: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          nested: {
            type: 'object',
            properties: { deep: { type: 'boolean' } },
            required: ['deep'],
          },
        },
      },
    },
  ];
  return tools.slice(0, Math.max(1, toolCount));
}

function sse(payload) {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function handleRpc(request) {
  const { id, method, params } = request;
  const ok = (result) => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'server/discover') {
    if (mode === 'legacy') return error(-32601, 'Method not found');
    return ok({
      supportedVersions: [PROTOCOL_MODERN],
      capabilities: { tools: { listChanged: false } },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      instructions: 'mock 服务器：用于 OliviaCode 自检',
    });
  }

  if (method === 'initialize') {
    if (mode === 'modern') return error(-32601, 'Method not found');
    return ok({
      protocolVersion: PROTOCOL_LEGACY,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'notifications/initialized') return null;

  if (method === 'tools/list') {
    return ok({ tools: toolDefs() });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'echo') {
      return ok({ content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }], isError: false });
    }
    if (name === 'add') {
      return ok({ content: [{ type: 'text', text: String(Number(args.a ?? 0) + Number(args.b ?? 0)) }] });
    }
    if (name === 'fail_tool') {
      return ok({ content: [{ type: 'text', text: '这个工具故意失败' }], isError: true });
    }
    if (name === 'needs_input') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'input_required',
          inputRequests: { ask: { method: 'elicitation/create', params: { message: '请输入名字' } } },
        },
      };
    }
    if (name === 'big_result') {
      return ok({ content: [{ type: 'text', text: 'x'.repeat(20 * 1024) }] });
    }
    if (name === 'image_result') {
      // 1x1 透明 PNG
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      return ok({ content: [{ type: 'image', data: png, mimeType: 'image/png' }] });
    }
    if (name === 'rich_schema') {
      return ok({ content: [{ type: 'text', text: JSON.stringify(args) }] });
    }
    if (name === 'slow') {
      return null; // 永不返回
    }
    return error(-32602, `Unknown tool: ${name}`);
  }

  return error(-32601, `Method not found: ${method}`);
}

// —— stdio ——
function runStdio() {
  let buffer = '';
  let handled = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      handled += 1;
      if (crashAfter > 0 && handled > crashAfter) {
        process.exit(7);
      }
      if (timeoutMode && request.method === 'tools/call' && request.params?.name === 'echo') {
        continue; // 不回复，触发客户端超时
      }
      const response = handleRpc(request);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// —— Streamable HTTP ——
function runHttp(port) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end('{"error":"method not allowed"}');
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (piece) => {
      raw += piece;
    });
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(raw);
      } catch {
        res.writeHead(400).end('{"error":"bad json"}');
        return;
      }
      const useSse = flag('--sse') && request.method === 'tools/list';
      const response = handleRpc(request);
      if (!response) {
        res.writeHead(202).end();
        return;
      }
      if (useSse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse(response));
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock-mcp http on ${port} (${mode}, sse=${flag('--sse')})`);
  });
}

if (httpPort) runHttp(Number(httpPort));
else runStdio();