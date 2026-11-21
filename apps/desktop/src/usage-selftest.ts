// M7 · 用量、价格与预算（纯函数 + mock 端点）
import { promises as fsp } from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '@olivia/exec';
import {
  runAgentTurn,
} from './agent';
import { SessionStore } from './sessions';
const fs = require('node:fs') as typeof import('node:fs');
const {
  measureContext,
  estimateTokens,
  costOf,
  addUsageTotals,
  emptyUsageTotals,
  resolvePricing,
  resolveContextWindow,
  formatTokens,
  formatUsd,
  replayUsage,
  usageTotalsOf,
  classifyPreviewUrl,
  extractPreviewUrls,
  artifactUrl,
  BUILTIN_PRICING,
} = require('@olivia/core');

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const asyncCheck = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

async function main() {
  check('CJK 与代码的估算系数', () => {
    assert.equal(estimateTokens(''), 0);
    // 4 个汉字 = 4 token
    assert.equal(estimateTokens('你好世界'), 4);
    // 16 个 ASCII = 4 token
    assert.equal(estimateTokens('abcdefghijklmnop'), 4);
    // 混排：2 汉字 + 8 ASCII = 2 + 2
    assert.equal(estimateTokens('汉字abcdefgh'), 4);
    assert.ok(estimateTokens('const x = 1;') >= 1);
  });

  check('上下文六类：没有真实值时按估算，和值一致', () => {
    const snapshot = measureContext({
      window: 1000,
      parts: [
        { key: 'system', text: 'x'.repeat(400), items: 1 },
        { key: 'toolSchemas', text: 'y'.repeat(200), items: 10 },
      ],
    });
    assert.equal(snapshot.source, 'estimate');
    const sum = snapshot.parts.reduce((acc: number, part: { tokens: number }) => acc + part.tokens, 0);
    assert.equal(snapshot.used, sum);
    assert.equal(snapshot.parts[1].items, 10);
  });

  check('上下文：真实 prompt_tokens 做总量，构成按比例归一', () => {
    const snapshot = measureContext({
      window: 10000,
      parts: [
        { key: 'system', text: 'x'.repeat(300), items: 1 },
        { key: 'turn', text: 'x'.repeat(100), items: 1 },
        { key: 'toolResults', text: 'x'.repeat(600), items: 3 },
      ],
      providerInput: 5000,
    });
    assert.equal(snapshot.source, 'provider');
    assert.equal(snapshot.used, 5000);
    const sum = snapshot.parts.reduce((acc: number, part: { tokens: number }) => acc + part.tokens, 0);
    assert.equal(sum, 5000, '取整误差要补到最大的一块');
    assert.ok(snapshot.parts[2].tokens > snapshot.parts[0].tokens);
  });

  check('成本：输入/输出/缓存折扣与缺价', () => {
    const pricing = { inPerM: 2, outPerM: 8, cachedInPerM: 0.5, currency: 'USD', updatedAt: '2026-01-01', source: 'builtin' };
    const cost = costOf({ input: 1_000_000, output: 500_000, cached: 400_000 }, pricing);
    // 600k 输入 * 2 + 400k 缓存 * 0.5 + 500k 输出 * 8 = 1.2 + 0.2 + 4 = 5.4
    assert.equal(cost, 5.4);
    assert.equal(costOf({ input: 10, output: 10 }, null), null);
    // 缓存为 0 的价格：全部按输入价
    const flat = { ...pricing, cachedInPerM: undefined };
    assert.equal(costOf({ input: 1_000_000, output: 0, cached: 500_000 }, flat), 2);
    // cached 大于 input 时容错
    assert.equal(costOf({ input: 100, output: 0, cached: 999 }, flat), 0.0002);
  });

  check('汇总：步数、估算标记与费用累加', () => {
    let totals = emptyUsageTotals();
    totals = addUsageTotals(totals, { input: 100, output: 20, source: 'provider' }, 0.001);
    totals = addUsageTotals(totals, { input: 50, output: 5, source: 'estimate' }, 0.0005);
    assert.equal(totals.steps, 2);
    assert.equal(totals.input, 150);
    assert.equal(totals.costUsd, 0.0015);
    const steps = [
      { step: 1, at: 1, input: 100, output: 20, source: 'provider', context: { window: 1000, used: 100, parts: [], source: 'provider' } },
      { step: 2, at: 2, input: 50, output: 5, source: 'estimate', context: { window: 1000, used: 150, parts: [], source: 'estimate' } },
    ];
    const summary = usageTotalsOf(steps);
    assert.equal(summary.estimated, true);
    assert.equal(summary.totals.steps, 2);
  });

  check('价格与窗口解析：用户覆盖优先于内置', () => {
    const builtin = resolvePricing('deepseek-v4.1-flash');
    assert.ok(builtin && builtin.inPerM > 0);
    const override = resolvePricing('deepseek-v4.1-flash', {
      'deepseek-v4.1-flash': { pricing: { ...BUILTIN_PRICING['deepseek-v4.1-flash'], inPerM: 9, source: 'user' } },
    });
    assert.equal(override.inPerM, 9);
    assert.equal(resolvePricing('unknown-model'), null);
    assert.equal(resolveContextWindow('deepseek-v4.1-flash', 64000), 64000);
    assert.equal(
      resolveContextWindow('x', 64000, { x: { contextWindow: 32000 } }),
      32000,
    );
  });

  check('格式化：token 与美元', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1234), '1.2k');
    assert.equal(formatTokens(1_500_000), '1.5M');
    assert.equal(formatUsd(0.12), '$0.1200');
    assert.equal(formatUsd(2.5), '$2.50');
    assert.equal(formatUsd(0.00001), '<$0.0001');
    assert.equal(formatUsd(null), '—');
  });

  check('旧会话日志没有 usage：重放返回空数组', () => {
    const events = [
      { at: 1, type: 'user.message', id: 'u1', text: 'hi' },
      { at: 2, type: 'assistant.message', id: 'a1', parts: [] },
    ];
    assert.deepEqual(replayUsage(events), []);
    const withUsage = replayUsage([
      ...events,
      {
        at: 3,
        type: 'usage',
        turnId: 't1',
        usage: { step: 1, at: 3, input: 10, output: 5, source: 'provider', context: { window: 100, used: 10, parts: [], source: 'provider' } },
      },
    ]);
    assert.equal(withUsage.length, 1);
    assert.equal(withUsage[0].input, 10);
  });

  check('预览地址策略：loopback 放行、外站待确认、危险协议拒绝', () => {
    assert.equal(classifyPreviewUrl('http://localhost:5173/').action, 'allow');
    assert.equal(classifyPreviewUrl('http://127.0.0.1:3000/x?y=1#z').action, 'allow');
    assert.equal(classifyPreviewUrl('https://127.4.3.2:8080/').action, 'allow');
    assert.equal(classifyPreviewUrl('http://[::1]:5173/').action, 'allow');
    assert.equal(classifyPreviewUrl('about:blank').action, 'allow');
    const external = classifyPreviewUrl('https://example.com/a');
    assert.equal(external.action, 'external');
    assert.equal(external.host, 'example.com');
    assert.equal(
      classifyPreviewUrl('https://example.com/a', { allowedHosts: ['EXAMPLE.com'] }).action,
      'allow',
    );
    assert.equal(classifyPreviewUrl('file:///C:/windows/system32/').action, 'deny');
    assert.equal(classifyPreviewUrl('javascript:alert(1)').action, 'deny');
    assert.equal(classifyPreviewUrl('data:text/html,<b>x</b>').action, 'deny');
    assert.equal(classifyPreviewUrl('http://user:pass@localhost:5173/').action, 'deny');
    assert.equal(classifyPreviewUrl('not a url').action, 'deny');
    assert.equal(classifyPreviewUrl('').action, 'deny');
  });

  check('从命令输出里发现本机地址', () => {
    const output = [
      '\u001b[32m  VITE v5.4.11  ready in 300 ms\u001b[39m',
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: http://192.168.1.7:5173/',
      '页面在 http://127.0.0.1:8823/index.html. 打不开就看 http://localhost:5173/',
    ].join('\n');
    const urls = extractPreviewUrls(output);
    assert.deepEqual(urls.sort(), ['http://127.0.0.1:8823/index.html', 'http://localhost:5173']);
    assert.deepEqual(extractPreviewUrls('没有地址'), []);
  });

  check('artifact 地址：自定义协议并编码路径', () => {
    assert.equal(
      artifactUrl('C:\\Users\\a\\artifacts\\x y.png'),
      'olivia-artifact://local/C%3A%5CUsers%5Ca%5Cartifacts%5Cx%20y.png',
    );
  });

  // —— mock 端点的 usage 四种模式 ——
  // 从仓库根找脚本：源码在 apps/desktop/src，编译产物在 apps/desktop/dist
  const { createMockServer } = require(
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'mock-llm.cjs'),
  );

  const requestOnce = async (port: number, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text().catch(() => '');
    return { status: response.status, text };
  };

  for (const mode of ['full', 'none', 'reject', 'partial']) {
    await asyncCheck(`mock 端点 usage=${mode}`, async () => {
      const server = createMockServer({ usage: mode, delayMs: 5 });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      try {
        const first = await requestOnce(port, {
          model: 'mock-wf',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
          stream_options: { include_usage: true },
        });
        if (mode === 'reject') {
          assert.equal(first.status, 400);
          assert.match(first.text, /stream_options/);
          const second = await requestOnce(port, {
            model: 'mock-wf',
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          });
          assert.equal(second.status, 200);
          assert.ok(!second.text.includes('"usage"'));
          return;
        }
        assert.equal(first.status, 200);
        if (mode === 'full') assert.match(first.text, /"usage"/);
        if (mode === 'none') assert.ok(!first.text.includes('"usage"'));
        if (mode === 'partial') assert.ok(!first.text.includes('[DONE]'));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }

  // —— 与 agent 串起来：真实 provider usage / 估算 / 回退重试 ——
  const runMockTurn = async (mode: string) => {
    const server = createMockServer({ usage: mode, delayMs: 5 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-usage-'));
    const sessions = new SessionStore(path.join(dir, 'sessions'));
    const snapshots = new SnapshotStore(path.join(dir, 'snapshots'));
    const events: { type: string; usage?: { source: string; input: number; output: number; context: { source: string; used: number } } }[] = [];
    try {
      await runAgentTurn({
        taskId: 'task',
        turnId: 'turn',
        prompt: '你好',
        history: [],
        model: 'mock-wf',
        contextWindow: 1000,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test',
        approval: 'auto',
        allowShell: false,
        policy: { mode: 'workspace-write', root: dir },
        snapshots,
        sessions,
        emit: (event) => events.push(event as never),
        requestApproval: async () => 'reject',
        requestPatch: async () => null,
        gitToken: () => null,
        signal: new AbortController().signal,
      });
      const usage = events.filter((event) => event.type === 'usage').map((event) => event.usage!);
      const log = await sessions.read('task');
      return { usage, log };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  await asyncCheck('agent：端点给 usage 时按真实值记账并落日志', async () => {
    const { usage, log } = await runMockTurn('full');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].source, 'provider');
    assert.ok(usage[0].input > 0);
    assert.ok(usage[0].output > 0);
    assert.equal(usage[0].context.source, 'provider');
    assert.equal(usage[0].context.used, usage[0].input);
    assert.ok(log.some((event) => event.type === 'usage'));
  });

  await asyncCheck('agent：端点不报 usage 时标估算', async () => {
    const { usage } = await runMockTurn('none');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].source, 'estimate');
    assert.equal(usage[0].context.source, 'estimate');
    assert.ok(usage[0].input > 0);
  });

  await asyncCheck('agent：端点拒绝 stream_options 后去掉重试', async () => {
    const { usage } = await runMockTurn('reject');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].source, 'estimate');
  });

  // —— M8：图片 content parts / 记忆投影 / 自动整理 ——
  const runCaptureTurn = async (options: {
    mock?: Record<string, unknown>;
    agent?: Partial<Parameters<typeof runAgentTurn>[0]>;
  } = {}) => {
    const requests: { messages: { role: string; content: unknown }[] }[] = [];
    const server = createMockServer({
      usage: 'full',
      delayMs: 5,
      vision: true,
      onRequest: (body: { messages: { role: string; content: unknown }[] }) => requests.push(body),
      ...(options.mock ?? {}),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-m8-'));
    const sessions = new SessionStore(path.join(dir, 'sessions'));
    const snapshots = new SnapshotStore(path.join(dir, 'snapshots'));
    const events: { type: string; usage?: { purpose?: string; context: { parts: { key: string; tokens: number }[] } }; message?: string }[] = [];
    try {
      await runAgentTurn({
        taskId: 'task_m8',
        turnId: 'turn_m8',
        prompt: '你好',
        history: [],
        model: 'mock-wf',
        contextWindow: 100_000,
        compactThreshold: 85,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test',
        approval: 'auto',
        allowShell: false,
        policy: { mode: 'workspace-write', root: dir },
        snapshots,
        sessions,
        emit: (event) => events.push(event as never),
        requestApproval: async () => 'reject',
        requestPatch: async () => null,
        gitToken: () => null,
        signal: new AbortController().signal,
        ...(options.agent ?? {}),
      });
      const log = await sessions.read('task_m8');
      return { requests, events, log };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  await asyncCheck('M8：当前消息图片进入 content parts，日志只存元数据', async () => {
    const image = {
      id: 'img_m8',
      path: 'C:\\artifacts\\upload_m8.png',
      mime: 'image/png' as const,
      width: 800,
      height: 600,
      bytes: 1024,
      sha256: 'sha_m8',
      source: 'paste' as const,
      createdAt: Date.now(),
    };
    const { requests, events, log } = await runCaptureTurn({
      mock: { usage: 'none' },
      agent: {
        attachments: [{ url: 'data:image/png;base64,AAAA', label: 'upload_m8.png', tokens: 300 }],
        logAttachments: [image],
      },
    });
    const last = requests[0]?.messages[requests[0].messages.length - 1];
    assert.ok(Array.isArray(last?.content), '当前 user 消息应是 content parts');
    const parts = last.content as { type: string; image_url?: { url: string } }[];
    assert.equal(parts[0]?.type, 'text');
    assert.equal(parts[1]?.type, 'image_url');
    assert.match(parts[1]?.image_url?.url ?? '', /^data:image\/png;base64,/);
    const userEvent = log.find((event) => event.type === 'user.message');
    assert.equal(userEvent?.type === 'user.message' ? userEvent.attachments?.[0]?.id : null, 'img_m8');
    assert.ok(!JSON.stringify(log).includes('base64,AAAA'), '日志里不能落 base64');
    const usage = events.find((event) => event.type === 'usage')?.usage;
    assert.ok((usage?.context.parts.find((part) => part.key === 'images')?.tokens ?? 0) > 0);
  });

  await asyncCheck('M8：有记忆时投影改为「记忆 + 最近两轮」', async () => {
    const memory = {
      version: 1 as const,
      taskId: 'task_m8',
      updatedAt: Date.now(),
      summary: '旧摘要',
      constraints: ['必须保留 A'],
      decisions: ['已决定乙'],
      todos: [{ text: '待办丙', status: 'open' as const }],
      files: [{ path: 'a.ts', note: '已改' }],
      questions: [],
    };
    const history = Array.from({ length: 12 }, (_item, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `历史第 ${index} 条`,
    }));
    const { requests } = await runCaptureTurn({ agent: { memory, history } });
    const messages = requests[0]?.messages ?? [];
    const system = String(messages[0]?.content ?? '');
    assert.match(system, /任务记忆/);
    assert.match(system, /必须保留 A/);
    assert.match(system, /已决定乙/);
    const nonSystem = messages.filter((message) => message.role !== 'system');
    assert.equal(nonSystem.length, 5, '最近两轮（4 条）+ 本次提示');
    assert.equal(nonSystem[0]?.content, '历史第 8 条');
    assert.equal(nonSystem[3]?.content, '历史第 11 条');
  });

  await asyncCheck('M8：达到阈值自动整理并计入 compaction 用量', async () => {
    const saved = { raw: '', meta: { reason: '' }, called: false };
    const { events } = await runCaptureTurn({
      agent: {
        contextWindow: 150,
        saveMemory: async (raw, meta) => {
          saved.raw = raw;
          saved.meta = meta;
          saved.called = true;
          return { ok: true };
        },
      },
    });
    assert.ok(saved.called, 'saveMemory 应被调用');
    assert.equal(saved.meta.reason, 'auto');
    const draft = JSON.parse(saved.raw || '{}') as { summary?: string; constraints?: string[] };
    assert.match(draft.summary ?? '', /mock 摘要/);
    assert.ok(draft.constraints?.includes('不要改公开类型'));
    const usage = events.filter((event) => event.type === 'usage').map((event) => event.usage);
    assert.ok(usage.some((item) => item?.purpose === 'compaction'), '整理调用要单独记账');
    assert.ok(events.some((event) => event.type === 'info' && /任务记忆/.test(event.message ?? '')));
  });

  console.log(`\nusage-selftest: ${passed} 条通过`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
