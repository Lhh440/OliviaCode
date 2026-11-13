import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_EDIT_BYTES,
  SnapshotStore,
  applyEdits,
  listDir,
  readFile,
  runCommand,
  searchText,
  writeText,
  type Policy,
} from '@olivia/exec';

/**
 * 执行层离线自检：不需要模型、不需要 Electron。
 *
 * 覆盖的都是「围栏与快照」的硬约束：
 * - 符号链接 / junction 指向工作区外，读写必须被拒；
 * - 超过 4MB 的文件拒绝 patch，不能截断写回；
 * - 快照对二进制/超大文件只标记不可还原，撤销时不能删文件；
 * - 旧格式快照（没有 existed/restorable）一律不删文件；
 * - 命令子进程继承「禁止交互式索要凭据」的环境。
 */

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function temp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function expectDenied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

/** 在 dir 下建一个指向 outside 的链接；Windows 优先 junction（不需要管理员）。 */
async function linkOutside(dir: string, outside: string): Promise<string | null> {
  const link = path.join(dir, 'linked');
  try {
    await fs.symlink(outside, link, 'junction');
    return link;
  } catch {
    try {
      await fs.symlink(outside, link, 'dir');
      return link;
    } catch {
      return null;
    }
  }
}

async function main(): Promise<void> {
  const root = await temp('olivia-exec-');
  const outside = await temp('olivia-outside-');
  const snapshotsDir = await temp('olivia-snaps-');
  const policy: Policy = { mode: 'workspace-write', root };

  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n', 'utf8');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET\n', 'utf8');

    // —— A1 正常读写仍然通畅 ——
    const read = await readFile(policy, 'a.txt');
    check('A1 工作区内正常读取', read.includes('hello'), JSON.stringify(read.trim()));

    // —— A2 字面量越界必须拒绝 ——
    const escaped = await expectDenied(() => readFile(policy, '../secret.txt'));
    const absolute = await expectDenied(() => readFile(policy, path.join(outside, 'secret.txt')));
    check('A2 .. 与绝对路径被拒', escaped && absolute, `relative=${escaped} absolute=${absolute}`);

    // —— A3 符号链接 / junction 越界必须拒绝（P0）——
    const link = await linkOutside(root, outside);
    if (!link) {
      check('A3 链接围栏', false, '当前环境不允许创建链接，用例无法执行');
    } else {
      const readThrough = await expectDenied(() => readFile(policy, 'linked/secret.txt'));
      const writeThrough = await expectDenied(() => writeText(policy, 'linked/secret.txt', 'pwned\n'));
      const escapedAfter = (await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).includes('TOP SECRET');
      const listed = (await listDir(policy, '.', 3)).some((entry) => entry.path.startsWith('linked/'));
      check('A3 链接围栏（读）', readThrough, 'linked/secret.txt 读取被拒');
      check('A4 链接围栏（写）', writeThrough && escapedAfter, `写入被拒=${writeThrough} 外部未被改=${escapedAfter}`);
      check('A5 链接不出现在目录树', !listed, 'linked/ 已被过滤');
      await fs.rm(link, { recursive: true, force: true });
    }

    // —— A6 多级不存在的路径，只要落在根内就允许创建 ——
    const nestedOk = await writeText(policy, 'deep/nested/new.txt', 'ok\n').then(() => true).catch(() => false);
    check('A6 新建多级目录仍可用', nestedOk, 'deep/nested/new.txt');

    // —— B1 超过 4MB 的文件拒绝 patch，原文件不变（P0）——
    const bigPath = path.join(root, 'big.txt');
    const bigContent = `FIRST_LINE\n${'x'.repeat(MAX_EDIT_BYTES + 1024)}`;
    await fs.writeFile(bigPath, bigContent, 'utf8');
    const beforeSize = (await fs.stat(bigPath)).size;
    const bigDenied = await expectDenied(() => applyEdits(policy, 'big.txt', [{ old: 'FIRST_LINE', new: 'CHANGED' }]));
    const afterSize = (await fs.stat(bigPath)).size;
    const stillOriginal = (await fs.readFile(bigPath, 'utf8')).startsWith('FIRST_LINE');
    check('B1 超大文件拒绝写入', bigDenied, `size=${afterSize}`);
    check('B2 超大文件未被截断', afterSize === beforeSize && stillOriginal, `before=${beforeSize} after=${afterSize}`);

    // —— B3 正常 patch 仍然工作 ——
    const patched = await applyEdits(policy, 'a.txt', [{ old: 'hello', new: 'hi' }]);
    check('B3 正常 patch', patched.after.startsWith('hi'), JSON.stringify(patched.after.trim()));

    // —— C1 快照：原本存在 → 撤销还原内容 ——
    const store = new SnapshotStore(snapshotsDir);
    const snapExist = await store.create('task_exist', policy, ['a.txt']);
    await writeText(policy, 'a.txt', 'changed\n');
    const restored = await store.restore(snapExist, policy);
    const content = await fs.readFile(path.join(root, 'a.txt'), 'utf8');
    check('C1 撤销还原内容', content.startsWith('hi') && restored.paths.includes('a.txt'), JSON.stringify(content.trim()));

    // —— C2 快照：原本不存在 → 撤销删除 ——
    const snapNew = await store.create('task_new', policy, ['created.txt']);
    await writeText(policy, 'created.txt', 'temp\n');
    await store.restore(snapNew, policy);
    const gone = await fs.stat(path.join(root, 'created.txt')).then(() => false).catch(() => true);
    check('C2 撤销删除新建文件', gone, 'created.txt 已移除');

    // —— C3 二进制 / 超大文件：只标记不可还原，撤销不能删（P0）——
    const snapBig = await store.create('task_big', policy, ['big.txt']);
    check(
      'C3 超大文件快照标记不可还原',
      snapBig.files[0]?.restorable === false && snapBig.files[0]?.existed === true,
      `restorable=${snapBig.files[0]?.restorable}`,
    );
    const bigRestore = await store.restore(snapBig, policy);
    const bigStillThere = await fs.stat(bigPath).then(() => true).catch(() => false);
    check('C4 不可还原文件不被删除', bigStillThere && bigRestore.skipped.includes('big.txt'), `skipped=${bigRestore.skipped.join(',')}`);

    // —— C5 旧格式快照（无 existed/restorable）也不能误删 ——
    const legacyDir = path.join(snapshotsDir, 'task_legacy');
    await fs.mkdir(legacyDir, { recursive: true });
    const legacySnapshot = {
      id: 'snap_legacy',
      at: Date.now(),
      taskId: 'task_legacy',
      files: [{ path: 'a.txt', content: null }],
    };
    await fs.writeFile(path.join(legacyDir, 'snap_legacy.json'), JSON.stringify(legacySnapshot), 'utf8');
    const legacy = await store.get('task_legacy', 'snap_legacy');
    const legacyRestore = legacy ? await store.restore(legacy, policy) : { paths: [], skipped: [] };
    const aStillThere = await fs.stat(path.join(root, 'a.txt')).then(() => true).catch(() => false);
    check('C5 旧快照不误删文件', aStillThere && legacyRestore.skipped.includes('a.txt'), `skipped=${legacyRestore.skipped.join(',')}`);

    // —— C6 同一毫秒连续创建不会互相覆盖 ——
    const ids = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      ids.add((await store.create('task_many', policy, ['a.txt'])).id);
    }
    check('C6 快照 id 不重复', ids.size === 5, `${ids.size}/5 个唯一 id`);

    // —— C7 latest / remaining / undone ——
    const many = await store.list('task_many');
    check('C7 快照按时间排序', many.length === 5 && many.every((item, index) => index === 0 || many[index - 1]!.at <= item.at), `count=${many.length}`);

    // —— D1 命令：git 不弹凭据、工作目录在围栏内 ——
    const probe = await runCommand(policy, process.execPath, [
      '-e',
      'console.log(process.env.GIT_TERMINAL_PROMPT + "|" + process.cwd())',
    ]);
    const [promptFlag, cwd] = probe.stdout.trim().split('|');
    check('D1 命令环境禁止交互凭据', promptFlag === '0', `GIT_TERMINAL_PROMPT=${promptFlag}`);
    check('D2 命令工作目录在围栏内', path.resolve(cwd ?? '') === path.resolve(root), cwd ?? '');

    // —— D3 搜索不会因链接泄露外部内容 ——
    if (await linkOutside(root, outside)) {
      const hits = await searchText(policy, 'TOP SECRET');
      check('D3 搜索不穿透链接', hits.length === 0, `${hits.length} 处命中`);
      await fs.rm(path.join(root, 'linked'), { recursive: true, force: true });
    } else {
      check('D3 搜索不穿透链接', true, '跳过：环境不允许建链接');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(snapshotsDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('自检崩溃：', error);
  process.exitCode = 1;
});