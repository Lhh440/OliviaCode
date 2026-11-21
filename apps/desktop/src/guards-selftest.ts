import {
  MODELS,
  describeCron,
  diffText,
  formatHunkHeader,
  humanizeModelError,
  makeNode,
  seedWorkflow,
  tryParseCron,
  type Workflow,
} from '@olivia/core';
import { syncWorkflow } from './schedule-sync';

/**
 * 契约自检：把「界面上看着不对」的那几类问题钉死在测试里。
 *
 * 覆盖：
 * - 所有内置 seed 必须通过各自的校验器（种子计划不能再是「无效：每晚 22:00」）；
 * - 画布触发器 → 计划记录：cron 非法不派生、节点 id 变了也不重复派生；
 * - diff 头格式（新文件 `@@ -0,0 +1,N @@`、纯删除 `+0,0`）；
 * - 模型报错的人话化与「能不能重试」的判定。
 */

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function triggerWorkflow(schedule: string, id = 'wf_test'): Workflow {
  const trigger = makeNode({
    kind: 'trigger',
    title: '测试触发器',
    subtitle: '触发器',
    schedule,
    x: 0,
    y: 0,
  });
  return { id, name: '测试工作流', nodes: [trigger], edges: [], updatedAt: 0 };
}

const at = 1_700_000_000_000;

// —— A. 种子数据必须过校验器 ——
const seed = seedWorkflow();
const seedTrigger = seed.nodes.find((node) => node.kind === 'trigger');
check('A1 种子工作流有触发器', Boolean(seedTrigger));
const seedCron = tryParseCron(seedTrigger?.schedule ?? '');
check('A2 种子触发器的 cron 通过校验器', seedCron.ok, seedCron.ok ? describeCron(seedTrigger!.schedule!) : seedCron.error);
check('A3 种子工作流 id 稳定', seed.id === seedWorkflow().id);
check(
  'A4 内置模型 id 不再是虚构型号',
  MODELS.every((model) => !/qwen3\.8/i.test(model.id) && !/qwen3\.8/i.test(model.label)),
  MODELS.map((model) => model.id).join(', '),
);

// —— B. 画布 → 计划的派生规则 ——
const first = syncWorkflow([], { workflow: seed, workspace: 'D:/work' }, at);
check('B1 合法触发器派生出一条计划', first.records.length === 1 && first.invalid.length === 0);

// 重新载入画布会给节点生成新 id：不能因此多派生一条
const reloaded = { ...seedWorkflow(), id: seed.id };
const second = syncWorkflow(first.records, { workflow: reloaded, workspace: 'D:/work' }, at + 1000);
check(
  'B2 节点 id 变化不重复派生',
  second.records.length === 1,
  `实际 ${second.records.length} 条`,
);

const bad = syncWorkflow([], { workflow: triggerWorkflow('每晚 22:00', 'wf_bad'), workspace: 'D:/work' }, at);
check('B3 cron 不合法不生成计划', bad.records.length === 0 && bad.invalid.length === 1, bad.invalid[0] ?? '');

const fixed = syncWorkflow(bad.records, { workflow: triggerWorkflow('0 22 * * *', 'wf_bad'), workspace: 'D:/work' }, at + 1);
check('B4 改好 cron 后重新派生', fixed.records.length === 1 && fixed.records[0]!.cron === '0 22 * * *');

// —— C. diff 头 ——
check('C1 新文件头', formatHunkHeader(1, 0, 1, 3) === '@@ -0,0 +1,3 @@', formatHunkHeader(1, 0, 1, 3));
check('C2 纯删除头', formatHunkHeader(1, 1, 1, 0) === '@@ -1,1 +0,0 @@', formatHunkHeader(1, 1, 1, 0));
const created = diffText('', 'alpha\nbeta');
check(
  'C3 新建文件的 hunk 头是 -0,0',
  created.hunks[0]?.header === '@@ -0,0 +1,2 @@',
  created.hunks[0]?.header ?? '(无 hunk)',
);
const removed = diffText('alpha', '');
check(
  'C4 清空文件的 hunk 头带 +0,0',
  removed.hunks[0]?.header === '@@ -1,1 +0,0 @@',
  removed.hunks[0]?.header ?? '(无 hunk)',
);
const edited = diffText('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne');
const editedHeader = edited.hunks[0]?.header ?? '';
check(
  'C5 普通修改头两端都是 +/-,逗号数量正确',
  /^@@ -\d+,\d+ \+\d+,\d+ @@$/.test(editedHeader),
  editedHeader,
);
check('C6 增删计数与 hunk 一致', edited.adds === 1 && edited.dels === 1);

// —— D. 错误人话化 ——
const quota = humanizeModelError('{"error":{"code":"insufficient_quota","message":"You exceeded your quota"}}');
check('D1 余额不足给中文解释', quota.message.includes('余额'), quota.message);
check('D2 余额不足不建议盲目重试', quota.retryable === false);
const refused = humanizeModelError('TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:9931');
check('D3 连不上端点可重试', refused.retryable === true, refused.message);
check('D4 端点原文保留在括号里', refused.message.includes('端点原文'), refused.message);
const unknown = humanizeModelError('boom');
check('D5 认不出的错误也带上原文', unknown.message.includes('boom'), unknown.message);

// —— 收尾 ——
const failed = results.filter((item) => !item.ok);
console.log(
  `\n契约自检：${results.length - failed.length}/${results.length} 通过${failed.length ? `，失败 ${failed.length}` : ''}`,
);
if (failed.length) {
  for (const item of failed) console.error(`  FAIL  ${item.name}  ${item.detail}`);
  process.exit(1);
}
