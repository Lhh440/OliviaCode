// 极简 OpenAI 兼容端点，用于离线跑通 agent / 工作流自检。
//
// 约定：最后一条 user 消息里出现 [[WRITE:path:content]] 时，先回一个 write_file 工具调用；
// 拿到 tool 结果后收尾成文本。没有标记就只回一句话（评审节点走这条）。
//
// 直接运行：node scripts/mock-llm.cjs [port]
// 作为模块：const { createMockServer } = require('./mock-llm.cjs')
const http = require('node:http');

const MARKER = /\[\[WRITE:([^:\[\]]+):([\s\S]*?)\]\]/;

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user') return String(message.content ?? '');
  }
  return '';
}

function sseLine(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta, finishReason = null) {
  return {
    id: `chatcmpl-mock-${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-wf',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some((message) => message && message.role === 'tool');
  const userText = lastUserText(messages);
  const match = userText.match(MARKER);

  if (!match) {
    return { text: '（mock）看完了，没有需要改动的地方；结论：可以通过。' };
  }
  if (hasToolResult) {
    return { text: `（mock）已写入 ${match[1]}，完成。` };
  }
  return {
    tool: {
      name: 'write_file',
      args: JSON.stringify({ path: match[1], content: match[2] }),
    },
  };
}

function createMockServer(options = {}) {
  const delayMs = Number(options.delayMs ?? process.env.MOCK_DELAY_MS ?? 120);
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-wf', object: 'model' }] }));
      return;
    }
    if (request.method !== 'POST' || !request.url.startsWith('/v1/chat/completions')) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end('{"error":"not found"}');
      return;
    }

    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (piece) => {
      raw += piece;
    });
    request.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        response.writeHead(400).end('{"error":"bad json"}');
        return;
      }
      const plan = decide(body);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      setTimeout(() => {
        if (plan.tool) {
          response.write(
            sseLine(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${Date.now().toString(36)}`,
                    type: 'function',
                    function: { name: plan.tool.name, arguments: plan.tool.args },
                  },
                ],
              }),
            ),
          );
          response.write(sseLine(chunk({}, 'tool_calls')));
        } else {
          response.write(sseLine(chunk({ role: 'assistant', content: plan.text })));
          response.write(sseLine(chunk({}, 'stop')));
        }
        response.write('data: [DONE]\n\n');
        response.end();
      }, delayMs);
    });
  });

  return server;
}

module.exports = { createMockServer, MARKER };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.MOCK_PORT || 9311);
  const server = createMockServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock-llm listening on http://127.0.0.1:${port}/v1`);
  });
}
