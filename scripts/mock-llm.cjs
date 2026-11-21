// 极简 OpenAI 兼容端点，用于离线跑通 agent / 工作流自检。
//
// 约定：最后一条 user 消息里出现 [[WRITE:path:content]] 时，先回一个 write_file 工具调用；
// 拿到 tool 结果后收尾成文本。没有标记就只回一句话（评审节点走这条）。
//
// M7 用量模式（--usage 或 USAGE_MODE）：
//   full    最后一个 chunk 带 usage（默认）
//   none    完全不返回 usage
//   reject  见到 stream_options 返回 400，去掉后正常
//   partial 流到一半断开，已发部分内容且不给 usage
//
// M8 视觉模式（--vision 或 VISION_MODE=1）：
//   接受 OpenAI content parts（text + image_url），回显「看到 N 张图」；
//   未开启时收到图片返回 400，模拟不支持视觉的端点。
//
// 直接运行：node scripts/mock-llm.cjs [port] [--vision]
// 作为模块：const { createMockServer } = require('./mock-llm.cjs')
const http = require('node:http');

const MARKER = /\[\[WRITE:([^:\[\]]+):([\s\S]*?)\]\]/;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n');
}

function countImages(messages) {
  let count = 0;
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && part.type === 'image_url') count += 1;
    }
  }
  return count;
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user') return textOfContent(message.content);
  }
  return '';
}

function countChars(messages) {
  let total = 0;
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && part.type === 'text') total += String(part.text ?? '').length;
        else if (part && part.type === 'image_url') total += 85;
      }
    } else {
      total += String(message.content ?? '').length;
    }
    if (Array.isArray(message.tool_calls)) total += JSON.stringify(message.tool_calls).length;
  }
  return total;
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
  const mode = options.usage ?? process.env.USAGE_MODE ?? 'full';
  const vision =
    options.vision === true || process.env.VISION_MODE === '1' || process.argv.includes('--vision');
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
      if (mode === 'reject' && body.stream_options) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end('{"error":{"message":"Unrecognized request argument: stream_options"}}');
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const images = countImages(messages);
      if (images > 0 && !vision) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end('{"error":{"message":"this mock endpoint does not accept image content"}}');
        return;
      }
      options.onRequest?.(body);

      // M8 上下文整理：请求不带工具、stream:false，用固定 JSON 模拟摘要模型。
      const systemText = String(messages[0]?.content ?? '');
      const isMemoryDraft = body.stream === false && systemText.includes('上下文整理器');
      if (isMemoryDraft) {
        const memory = {
          summary: '（mock 摘要）已完成前半段，测试通过；下一步补空状态。',
          constraints: ['不要改公开类型'],
          decisions: ['复用现有组件'],
          todos: [{ text: '补空状态', status: 'open' }],
          files: [{ path: 'apps/web/src/views/Chat.tsx', note: '已接入提供商' }],
          questions: [],
        };
        const content = JSON.stringify(memory);
        const prompt = Math.max(1, Math.ceil(countChars(messages) / 4));
        const completion = Math.max(1, Math.ceil(content.length / 4));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            id: `chatcmpl-mock-${Date.now().toString(36)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-wf',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
          }),
        );
        return;
      }

      const plan =
        images > 0
          ? { text: `（mock）看到 ${images} 张图；已按图片输入处理。` }
          : decide(body);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const usage =
        mode === 'full'
          ? {
              prompt_tokens: Math.max(1, Math.ceil(countChars(body.messages ?? []) / 4)),
              completion_tokens: Math.max(1, Math.ceil((plan.tool ? plan.tool.args : plan.text).length / 4)),
              total_tokens: 0,
            }
          : null;
      if (usage) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

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
        if (mode === 'partial') {
          // 模拟「没有 [DONE]、也没有 usage」的半截响应
          response.end();
          return;
        }
        if (usage) {
          response.write(
            sseLine({
              id: `chatcmpl-mock-${Date.now().toString(36)}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'mock-wf',
              choices: [],
              usage,
            }),
          );
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
  const portArg = process.argv.slice(2).find((item) => /^\d+$/.test(item));
  const port = Number(portArg || process.env.MOCK_PORT || 9311);
  const server = createMockServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock-llm listening on http://127.0.0.1:${port}/v1${process.argv.includes('--vision') ? ' (vision)' : ''}`);
  });
}
