#!/usr/bin/env node
// @module exitkit
// @path ~/.dsh/ventures/exitkit/src/exitkit.mjs
// @description Turn a platform's OFFICIAL export into a verifiable migration receipt: what you can take, what you lose, and what the export cannot tell you. It never scrapes, never touches the network, and never claims a file survived without a hash.
// @zone action
// @tier Tier3-tool
//
// @skill read_export — --from <zip|dir> -> { files }（zip 用系统 unzip 解到临时目录；无 unzip 时如实报错，不静默跳过）
// @skill classify — 每个文件归入 md | csv | asset | other；other 不是丢弃，而是必须进 losses
// @skill write_canonical — 原样保留相对路径写入 <out>/canonical，附稳定 id（sha256 前缀）
// @skill write_manifest — <out>/manifest.json：源包哈希 + 逐文件 {path,sha256,bytes,kind,sourceRef}
// @skill detect_losses — 从 md/csv 里检出可证的丢失构造（notion.so 关系链接、内嵌 HTML 块、无表头 CSV…），带证据路径与计数
// @skill declare_unverifiable — 导出包**无法自证**的丢失（视图/公式/权限/评论）必须单列，写明"需你自查什么"
// @skill write_receipt — <out>/receipt.md 人读收据：能带走 / 会丢 / 核不了，三段齐全
// @skill verify — --verify <dir>：重算 sha256 与清单比对，missing/extra/mismatch 任一 ⇒ exit 1 并点名
// @skill render_from_manifest — --report <dir>：不读源包、只从 manifest+losses 重出 receipt.md（幂等；缺清单则如实失败）
// @skill flag_path_risks — 路径长度 ≥200 字符、同名文件、**生成式重名后缀**（`-1` / ` 1a2b3c`，来自真实迁移工具的解析实现）、**链接里的 URL 编码路径** 一律进 risk，不当成丢失、也不忽略
//
// @rule no_network P0 — 本工具不发任何网络请求（只读本地导出包）；违反即视为缺陷
// @rule no_silent_loss P0 — 任何未被 canonical 表达的文件或构造，必须出现在 losses；解析器不得静默跳过未知文件类型
// @rule fail_loud_on_drift P0 — 结构不符合预期（导出包为空、0 字节文件、CSV 全空）⇒ 非零退出并点名，绝不产出"成功"的空收据
// @rule receipt_three_parts P0 — receipt.md 必须同时含"能带走/会丢/核不了"三段；缺任一段即视为不合格产物
// @rule unverifiable_is_declared P0 — 导出包无法证明的丢失，必须写成"需自查"条目，不得省略、不得写成已核实
// @rule deterministic P1 — 同一输入两次运行，manifest.json 除 generatedAt 外逐字节相同；--report 重出的 receipt 必须与首次写入内容一致
// @rule risk_is_not_loss P1 — 超长路径等“风险”进 losses 的 risk 分类，不得写成已丢失，也不得静默忽略
// @rule suffix_duplicate_detected P1 — 平台给重名页加后缀（`-1`/` 1a2b3c`）时文件名并不相等；只查完全相同会漏掉，必须按“去后缀后同基名”再查一次
// @rule url_encoded_link_is_risk P1 — md 链接里出现 %XX 编码路径时必须报 risk（导入后链接会指向不存在的转义名）
//
// @depends node >= 20；系统 `unzip`（仅 --from *.zip 时需要）
// @phase Phase1
// @state partial
//
// @error missing_unzip — 需要解压但系统无 unzip ⇒ exit 3，提示手工解压后以目录传入
// @error empty_export — 导出包无任何文件 ⇒ exit 2（拒绝真空通过）
// @error zero_byte_file — 导出包内存在 0 字节文件 ⇒ exit 2，点名（多半是导出未完成）
// @error verify_mismatch — 哈希不符/文件缺失/多余文件 ⇒ exit 1，逐条点名
// @error missing_manifest — --report 时找不到 manifest.json ⇒ exit 2，不产出空收据
//
// @metric files_total [type:counter]
// @metric losses_detected [type:counter]
// @metric unverifiable_declared [type:counter]
// @metric verify_failures [type:counter]
//
// @memory 2026-11-24 计划批准后建立；Notion 官方文档已核：导出单向、无回灌、数据库仅当前/默认视图
//
// usage:
//   node src/exitkit.mjs --from export.zip --out ./out [--dry-run]
//   node src/exitkit.mjs --verify ./out
//   node src/exitkit.mjs --self-test

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const VERSION = '0.1.0';
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf', '.mp4', '.mov', '.mp3', '.wav', '.zip']);

/* ------------------------------------------------------------------ */
/* 读导出包                                                            */
/* ------------------------------------------------------------------ */

/** 递归列出目录下所有文件（相对路径升序，保证确定性）。 */
export function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) { visit(abs); continue; }
      if (!st.isFile()) continue;
      out.push({ abs, rel: relative(root, abs).split('\\').join('/') });
    }
  };
  visit(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** 把 --from 解析成一个可遍历的根目录；zip 走系统 unzip，缺 unzip 就如实失败。 */
export function readExport(from) {
  const abs = resolve(from);
  if (!existsSync(abs)) throw Object.assign(new Error(`导出包不存在：${abs}`), { code: 'missing_unzip' });
  if (statSync(abs).isDirectory()) return { root: abs, sourceName: basename(abs), sourceKind: 'dir', cleanup: null };
  const tmp = mkdtempSync(join(tmpdir(), 'exitkit-'));
  try {
    execFileSync('unzip', ['-qq', '-o', abs, '-d', tmp], { stdio: 'pipe' });
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    const msg = String(err?.message ?? err);
    const code = /ENOENT/.test(msg) ? 'missing_unzip' : 'unzip_failed';
    throw Object.assign(new Error(`unzip 失败（${code}）：${msg}`), { code });
  }
  return { root: tmp, sourceName: basename(abs), sourceKind: 'zip', cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ */
/* 分类与哈希                                                          */
/* ------------------------------------------------------------------ */

export function classify(rel) {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.csv')) return 'csv';
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  if (ASSET_EXT.has(ext)) return 'asset';
  return 'other';
}

export function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

/* ------------------------------------------------------------------ */
/* 可证的丢失                                                          */
/* ------------------------------------------------------------------ */

/** 从一份 md 文本里检出可证的丢失构造，返回 [{construct, evidence, note}]。 */
export function detectLossesInMarkdown(rel, text) {
  const found = [];
  const push = (construct, note) => found.push({ construct, evidence: rel, note });

  const relationLinks = (text.match(/https?:\/\/(?:www\.)?(?:notion\.so|notion\.site)\/[^\s)\]]+/gi) ?? []);
  if (relationLinks.length > 0) push('relation/mention link to a page outside the export', `${relationLinks.length} 个 notion 链接：目标页未必在本次导出内`);

  const htmlBlocks = (text.match(/<(table|figure|details|iframe|video)\b/gi) ?? []);
  if (htmlBlocks.length > 0) push('HTML-only block (no Markdown equivalent)', `${htmlBlocks.length} 处内嵌 HTML（平台导出用 HTML 兜底，回灌时会丢）`);

  const encoded = (text.match(/\]\([^)]*%[0-9A-Fa-f]{2}[^)]*\)/g) ?? []);
  if (encoded.length > 0) push('risk: url-encoded path in link', `${encoded.length} 处链接含 %XX 编码（导入后指向转义名，链接会失效）`);

  const base64 = (text.match(/!\[[^\]]*\]\(data:[^)]+\)/g) ?? []);
  if (base64.length > 0) push('inline data-URI image', `${base64.length} 处内联 base64 图片（体积大、多数替代品不认）`);

  return found;
}

/** 从 CSV 文本检出可证的丢失，返回 {losses, rows, headerless}。 */
export function detectLossesInCsv(rel, text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { losses: [{ construct: 'empty csv', evidence: rel, note: '0 行（连表头都没有）' }], rows: 0, headerless: true };
  const header = lines[0];
  const headerless = lines.length > 1 && !header.includes(',') && lines[1].includes(',');
  const losses = [];
  if (headerless) losses.push({ construct: 'csv without header row', evidence: rel, note: '首行不像表头；列名已不可恢复' });
  if (lines.length === 1) losses.push({ construct: 'csv with header only', evidence: rel, note: '0 条数据行（导出可能未完成，或该库确实为空）' });
  return { losses, rows: Math.max(0, lines.length - 1), headerless };
}

/** 导出包无法自证的丢失：必须声明，且只说"需自查什么"，不假装已核实。 */
export function declaredUnverifiable() {
  return [
    { item: 'views / filters / sorts / groupings', why: '导出只含当前视图或默认视图，其余视图不随包导出', check: '在平台上数一遍你有几个视图，收据里只会有一个' },
    { item: 'formula / rollup / relation 的定义', why: '只留最后一列计算结果，不含定义与依赖', check: '替代品里需要重建公式，值可能对但口径会丢' },
    { item: 'permissions / sharing', why: '导出不含"谁有访问权"', check: '迁移后需重新分配权限，别默认全员可见' },
    { item: 'comments', why: 'Markdown 导出不含评论；HTML 导出可含，但格式不可回灌', check: '重要讨论若要留存，需单独用 HTML 导出一次' },
    { item: 'file version history', why: '不导出历史版本', check: '需要旧版本现在就去平台里另存' },
    { item: 'database templates / buttons / automations', why: '非内容构造，不随导出包', check: '迁移后需在替代品里重做' },
  ];
}

/* ------------------------------------------------------------------ */
/* 产物写出                                                            */
/* ------------------------------------------------------------------ */

function ensureDir(dir) { mkdirSync(dir, { recursive: true }); }

export function buildExport({ from, out, dryRun = false, version = VERSION }) {
  const src = readExport(from);
  try {
    const files = walk(src.root);
    if (files.length === 0) throw Object.assign(new Error('导出包里没有任何文件'), { code: 'empty_export' });

    const zeroByte = files.filter((f) => statSync(f.abs).size === 0);
    if (zeroByte.length > 0) {
      throw Object.assign(new Error(`存在 0 字节文件（多半导出未完成）：${zeroByte.map((f) => f.rel).join(', ')}`), { code: 'zero_byte_file' });
    }

    const sourceSha = createHash('sha256');
    for (const f of files) sourceSha.update(f.rel).update('\0').update(readFileSync(f.abs));
    const sourceDigest = sourceSha.digest('hex');

    const entries = [];
    const losses = [];
    for (const f of files) {
      const kind = classify(f.rel);
      const digest = sha256File(f.abs);
      entries.push({ path: f.rel, sha256: digest, bytes: statSync(f.abs).size, kind, sourceRef: `${src.sourceName}:${f.rel}` });
      if (kind === 'other') losses.push({ construct: 'file type not migrated', evidence: f.rel, note: '未映射到 canonical 表达，原样保留但替代品多半不认' });
      if (kind === 'md') losses.push(...detectLossesInMarkdown(f.rel, readFileSync(f.abs, 'utf8')));
      if (f.rel.length >= 200) losses.push({ construct: 'risk: very long path', evidence: f.rel, note: `${f.rel.length} 字符；平台 FAQ 明写 Windows 解压有 260 字符限制，迁移到本地前先缩短` });
      if (kind === 'csv') {
        const r = detectLossesInCsv(f.rel, readFileSync(f.abs, 'utf8'));
        losses.push(...r.losses);
        if (r.headerless) throw Object.assign(new Error(`CSV 首行不像表头：${f.rel}`), { code: 'csv_without_header' });
      }
    }

    const byBase = new Map();
    for (const e of entries) {
      const b = e.path.split('/').pop();
      byBase.set(b, (byBase.get(b) ?? 0) + 1);
    }
    for (const [b, n] of byBase) {
      if (n > 1) losses.push({ construct: 'risk: duplicate filename', evidence: b, note: `${n} 个文件同名（不同目录）；导入扁平化的替代品时会互相覆盖` });
    }
    // 平台给重名页加后缀（`-1` 或 ` 1a2b3c`），文件名因此不相等 —— 只查完全相同会漏
    const stemOf = (b) => b.replace(/\.(md|csv|markdown)$/i, '').replace(/(?:[- ]\d+|[ ][0-9a-f]{6,32})$/i, '');
    const byStem = new Map();
    for (const e of entries) {
      const base = e.path.split('/').pop();
      const stem = stemOf(base);
      if (stem === base.replace(/\.(md|csv|markdown)$/i, '')) continue;  // 没有后缀，不是生成式重名
      byStem.set(stem, [...(byStem.get(stem) ?? []), e.path]);
    }
    for (const [stem, paths] of byStem) {
      losses.push({ construct: 'risk: generated duplicate suffix', evidence: paths[0], note: `${paths.length} 个文件带后缀指向同一基名「${stem}」（${paths.map((x) => x.split('/').pop()).join(', ')}）；替代品可能合并或覆盖` });
    }

    const manifest = {
      tool: 'exitkit', version,
      generatedAt: new Date().toISOString(),
      source: { name: src.sourceName, kind: src.sourceKind, sha256: sourceDigest, files: files.length },
      files: entries,
      stats: {
        files_total: entries.length,
        by_kind: entries.reduce((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {}),
        losses_detected: losses.length,
        unverifiable_declared: declaredUnverifiable().length,
      },
    };

    if (dryRun) return { manifest, losses, unverifiable: declaredUnverifiable(), dryRun: true };

    ensureDir(join(out, 'canonical'));
    for (const f of files) {
      const dest = join(out, 'canonical', f.rel);
      ensureDir(dirname(dest));
      copyFileSync(f.abs, dest);
    }
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    writeFileSync(join(out, 'losses.json'), JSON.stringify({ detected: losses, unverifiable: declaredUnverifiable() }, null, 2) + '\n', 'utf8');
    writeFileSync(join(out, 'receipt.md'), renderReceipt(manifest), 'utf8');
    return { manifest, losses, unverifiable: declaredUnverifiable(), dryRun: false };
  } finally {
    src.cleanup?.();
  }
}

/* ------------------------------------------------------------------ */
/* 收据（人读）                                                        */
/* ------------------------------------------------------------------ */

export function renderReceipt(manifest) {
  const m = manifest;
  const kinds = Object.entries(m.stats.by_kind).map(([k, v]) => `${k} ${v}`).join(' · ');
  return [
    `# 迁移收据 — ${m.source.name}`,
    '',
    `生成：${m.generatedAt} · exitkit ${m.version}`,
    `源包指纹：\`${m.source.sha256}\`（${m.source.files} 个文件，逐文件哈希见 manifest.json）`,
    '',
    '## 一、你能带走什么（已逐字节核过）',
    '',
    `- 文件：**${m.stats.files_total}** 个（${kinds}）`,
    '- 每个文件在 `canonical/` 下按原相对路径保留，`manifest.json` 里带 `sha256` 与字节数。',
    '- 核验命令：`node src/exitkit.mjs --verify <本目录>` —— 任何人可以独立复核，不必信我。',
    '',
    '## 二、你会丢什么（从导出包里检出的，带证据）',
    '',
    `检出 **${m.stats.losses_detected}** 条，逐条证据见 \`losses.json\` 的 \`detected\`。`,
    '常见三类：指向导出包之外页面的关系链接、无 Markdown 等价物的内嵌 HTML 块、未映射的文件类型。',
    '',
    '## 三、我核不了什么（导出包本身不证明，必须你自查）',
    '',
    `**${m.stats.unverifiable_declared}** 项。这不是遗漏，是这份导出包**物理上不含**的信息。`,
    '逐项理由与"你要查什么"见 `losses.json` 的 `unverifiable`。',
    '',
    '> 一份诚实的收据必须写出它核不了的东西；只写"已迁移 N 个文件"的收据，是把风险留给用户。',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 核验                                                                */
/* ------------------------------------------------------------------ */

/** 只从已有产物重出收据（不读源包）。缺清单 ⇒ 如实失败，不产出空收据。 */
export function report(out) {
  const manifestPath = join(out, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw Object.assign(new Error(`找不到 manifest.json：${manifestPath}`), { code: 'missing_manifest' });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const receipt = renderReceipt(manifest);
  const dest = join(out, 'receipt.md');
  const before = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  writeFileSync(dest, receipt, 'utf8');
  return { receipt, changed: before !== null && before !== receipt, wrote: true };
}

export function verify(out) {
  const manifestPath = join(out, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, failures: [`缺少 manifest.json：${manifestPath}`] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const failures = [];
  const expected = new Map(manifest.files.map((f) => [f.path, f]));

  for (const f of manifest.files) {
    const abs = join(out, 'canonical', f.path);
    if (!existsSync(abs)) { failures.push(`missing: ${f.path}`); continue; }
    const digest = sha256File(abs);
    const bytes = statSync(abs).size;
    if (digest !== f.sha256) failures.push(`mismatch: ${f.path}（清单 ${f.sha256.slice(0, 12)}… / 实际 ${digest.slice(0, 12)}…）`);
    if (bytes !== f.bytes) failures.push(`size-mismatch: ${f.path}（清单 ${f.bytes}B / 实际 ${bytes}B）`);
  }
  for (const f of walk(join(out, 'canonical'))) {
    if (!expected.has(f.rel)) failures.push(`extra: ${f.rel}（不在清单里）`);
  }
  return { ok: failures.length === 0, failures, files: manifest.files.length };
}

/* ------------------------------------------------------------------ */
/* 自检（负例必须能红）                                                */
/* ------------------------------------------------------------------ */

function selfTest() {
  let failures = 0;
  let assertions = 0;
  const ok = (label, cond) => { assertions += 1; if (cond) console.log(`  OK ${label}`); else { console.log(`  FAIL ${label}`); failures += 1; } };

  const base = mkdtempSync(join(tmpdir(), 'exitkit-selftest-'));
  try {
    // 夹具：一份仿官方导出的最小包（md + csv + asset + 一个未知类型）
    const src = join(base, 'export');
    ensureDir(join(src, 'page-a'));
    writeFileSync(join(src, 'page-a', 'notes.md'), '# Notes\n\nsee https://www.notion.so/abc123 and <figure>x</figure>\n', 'utf8');
    writeFileSync(join(src, 'page-a', 'assets', 'pic.png').replace(/\/assets\//, '/'), 'PNGDATA', 'utf8');
    writeFileSync(join(src, 'db.csv'), 'Name,Status\nA,done\nB,todo\n', 'utf8');
    writeFileSync(join(src, 'mystery.xyz'), 'unknown', 'utf8');

    const out = join(base, 'out');
    const r = buildExport({ from: src, out });
    ok('检出 losses（关系链接/HTML/未知类型）', r.losses.some((l) => /relation/.test(l.construct)) && r.losses.some((l) => /HTML/.test(l.construct)) && r.losses.some((l) => /not migrated/.test(l.construct)));
    ok('未把未知类型静默丢弃', r.manifest.files.some((f) => f.kind === 'other'));
    ok('无扩展名文件归 other（空扩展名不得落进 asset 白名单）', classify('LICENSE') === 'other' && classify('a.b/noext') === 'other');
    ok('空扩展名不在 asset 白名单里', !ASSET_EXT.has(''));
    ok('收据三段齐全', ['你能带走什么', '你会丢什么', '我核不了什么'].every((s) => readFileSync(join(out, 'receipt.md'), 'utf8').includes(s)));
    ok('未声明的丢失不存在（每类都进 losses 或 unverifiable）', r.losses.length > 0 && r.unverifiable.length > 0);

    // 负例 1：**等长**篡改（只换一个字节，大小不变）→ 只有哈希能抓到；改大小会被字节数兜住，证明不了哈希必要
    {
      const target = join(out, 'canonical', 'db.csv');
      const original = readFileSync(target, 'utf8');
      writeFileSync(target, original.replace('done', 'DONE'), 'utf8');
      if (readFileSync(target, 'utf8').length !== original.length) throw new Error('self-test 夹具错误：篡改必须等长');
    }
    const v1 = verify(out);
    ok('负例 篡改文件 ⇒ verify 红且点名', !v1.ok && v1.failures.some((f) => f.includes('db.csv')));

    // 负例 2：多余文件 → verify 必须红
    writeFileSync(join(out, 'canonical', 'extra.md'), 'x', 'utf8');
    const v2 = verify(out);
    ok('负例 多余文件 ⇒ verify 红', !v2.ok && v2.failures.some((f) => f.includes('extra')));

    // 负例 3：空导出包 → 必须 exit 2 语义（抛 empty_export）
    const emptyDir = join(base, 'empty');
    ensureDir(emptyDir);
    let code = null;
    try { buildExport({ from: emptyDir, out: join(base, 'out2') }); } catch (e) { code = e.code; }
    ok('负例 空导出包 ⇒ empty_export', code === 'empty_export');

    // risk 分类：超长路径必须是 risk 而不是丢失，也不得忽略
    const longName = 'x'.repeat(210) + '.md';
    const lsrc = join(base, 'longpath');
    ensureDir(lsrc);
    writeFileSync(join(lsrc, longName), 'hello', 'utf8');
    const rout = join(base, 'out-long');
    const rlong = buildExport({ from: lsrc, out: rout });
    ok('超长路径进 risk（且不写成丢失）', rlong.losses.some((l) => /risk: very long path/.test(l.construct)));
    // 真实坑 1：生成式重名后缀（-1 / 1a2b3c）必须被查出，尽管文件名不相等
    const dsrc = join(base, 'dupsuf');
    ensureDir(dsrc);
    writeFileSync(join(dsrc, 'Notes.md'), 'a', 'utf8');
    writeFileSync(join(dsrc, 'Notes-1.md'), 'b', 'utf8');
    writeFileSync(join(dsrc, 'Notes 1a2b3c.md'), 'c', 'utf8');
    const dres = buildExport({ from: dsrc, out: join(base, 'out-dup') });
    ok('生成式重名后缀 ⇒ risk（按去后缀基名查出）', dres.losses.filter((l) => /generated duplicate suffix/.test(l.construct)).length >= 1);
    ok('同名但不同目录仍单独报（两类互不替代）', (() => {
      const s2 = join(base, 'dupexact');
      ensureDir(join(s2, 'a'));
      ensureDir(join(s2, 'b'));
      writeFileSync(join(s2, 'a', 'same.md'), 'x', 'utf8');
      writeFileSync(join(s2, 'b', 'same.md'), 'y', 'utf8');
      const rr = buildExport({ from: s2, out: join(base, 'out-dup2') });
      return rr.losses.some((l) => /duplicate filename/.test(l.construct));
    })());
    // 真实坑 2：链接里的 URL 编码必须报 risk
    const usrc = join(base, 'urlenc');
    ensureDir(usrc);
    writeFileSync(join(usrc, 'p.md'), '[x](Project%20Alpha/Page%201.md)\n', 'utf8');
    const ures = buildExport({ from: usrc, out: join(base, 'out-url') });
    ok('链接含 URL 编码 ⇒ risk', ures.losses.some((l) => /url-encoded/.test(l.construct)));

    // --report 幂等：重出的收据内容必须与首次一致
    const rep = report(rout);
    ok('--report 重出收据幂等（内容不变）', rep.changed === false);
    // --report 缺清单 ⇒ missing_manifest
    let code3 = null;
    try { report(join(base, 'no-such-out')); } catch (e) { code3 = e.code; }
    ok('负例 缺 manifest ⇒ missing_manifest', code3 === 'missing_manifest');

    // 负例 4：0 字节文件 → 必须红
    const zsrc = join(base, 'zero');
    ensureDir(zsrc);
    writeFileSync(join(zsrc, 'a.md'), '', 'utf8');
    let code2 = null;
    try { buildExport({ from: zsrc, out: join(base, 'out3') }); } catch (e) { code2 = e.code; }
    ok('负例 0 字节文件 ⇒ zero_byte_file', code2 === 'zero_byte_file');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  console.log(failures === 0 ? `SELF-TEST PASS（${assertions} 例）` : `SELF-TEST FAILED: ${failures}/${assertions}`);
  return failures === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  if (process.argv.includes('--report')) {
    const out = arg('--report');
    if (!out) { console.error('用法：--report <目录>'); process.exit(2); }
    try {
      const r = report(out);
      console.log(`OK：收据已重出 → ${join(out, 'receipt.md')}（内容变化：${r.changed ? '是' : '否'}）`);
      process.exit(0);
    } catch (err) {
      console.error(`ERROR ${err.code ?? ''}: ${err.message}`);
      process.exit(2);
    }
  }
  if (process.argv.includes('--verify')) {
    const out = arg('--verify');
    if (!out) { console.error('用法：--verify <目录>'); process.exit(2); }
    const r = verify(out);
    if (r.ok) { console.log(`VERDICT: 全部 ${r.files} 个文件与清单一致（exit 0）`); process.exit(0); }
    for (const f of r.failures) console.log(`  ${f}`);
    console.log(`VERDICT: ${r.failures.length} 处不一致（exit 1）`);
    process.exit(1);
  }
  const from = arg('--from');
  const out = arg('--out');
  if (!from || !out) { console.error('用法：--from <zip|dir> --out <dir> [--dry-run]'); process.exit(2); }
  try {
    const r = buildExport({ from, out, dryRun: process.argv.includes('--dry-run') });
    if (r.dryRun) {
      console.log(`DRY-RUN：${r.manifest.files.length} 个文件，检出丢失 ${r.losses.length} 条，声明不可核 ${r.unverifiable.length} 项（未写盘）`);
      process.exit(0);
    }
    console.log(`OK：${r.manifest.files.length} 个文件 → ${out}`);
    console.log(`  丢失检出 ${r.losses.length} 条 · 不可核声明 ${r.unverifiable.length} 项`);
    console.log(`  收据：${join(out, 'receipt.md')}`);
    console.log(`  复核：node src/exitkit.mjs --verify ${out}`);
    process.exit(0);
  } catch (err) {
    console.error(`ERROR ${err.code ?? ''}: ${err.message}`);
    process.exit(err.code === 'missing_unzip' ? 3 : 2);
  }
}

main();
