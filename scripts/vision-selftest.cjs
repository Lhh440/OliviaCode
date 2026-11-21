// M8 离线视觉自检：mock 端点接受 content parts、回显图片数量；未开启视觉时拒绝图片。
const { createMockServer } = require('./mock-llm.cjs');

function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readSse(response) {
  const text = await response.text();
  return text;
}

const IMAGE_MESSAGE = {
  role: 'user',
  content: [
    { type: 'text', text: '这张按钮歪了，帮我修' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
  ],
};

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) {
      passed += 1;
      console.log(`  ok  ${name}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  const seen = [];
  const vision = createMockServer({ vision: true, delayMs: 0, usage: 'full', onRequest: (body) => seen.push(body) });
  const blind = createMockServer({ vision: false, delayMs: 0, usage: 'full' });
  await new Promise((resolve) => vision.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => blind.listen(0, '127.0.0.1', resolve));
  const visionPort = vision.address().port;
  const blindPort = blind.address().port;

  const ok = await post(visionPort, { model: 'mock-wf', messages: [IMAGE_MESSAGE], stream: true });
  const sse = await readSse(ok);
  check('vision endpoint accepts content parts', ok.status === 200, `HTTP ${ok.status}`);
  check('vision reply counts images', sse.includes('看到 1 张图'), sse.slice(0, 200));
  check('text part still reaches the model', sse.includes('按钮歪了') || seen[0]?.messages?.[0]?.content?.[0]?.text === '这张按钮歪了，帮我修');
  check('server received image part', Array.isArray(seen[0]?.messages?.[0]?.content) && seen[0].messages[0].content[1].type === 'image_url');

  const rejected = await post(blindPort, { model: 'mock-wf', messages: [IMAGE_MESSAGE], stream: true });
  check('non-vision endpoint rejects images with 400', rejected.status === 400, `HTTP ${rejected.status}`);
  const plain = await post(blindPort, {
    model: 'mock-wf',
    messages: [{ role: 'user', content: '普通文本' }],
    stream: true,
  });
  check('non-vision endpoint still accepts text', plain.status === 200);

  vision.close();
  blind.close();
  console.log(`\nM8 vision self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
