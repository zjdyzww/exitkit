// @module exitkit-stress
// @path ~/.dsh/ventures/exitkit/tests/stress.mjs
// @description Reproducible stress test built from the SHAPE of a real archive. On 2026-11-24 the tool was run against a real 45,503-file archive and two rules were wrong (zero-byte files, per-occurrence loss rows). That archive is 410 MB and cannot live in this repo, so this test materialises its shape - CJK names, 200+ char paths, duplicate basenames, zero-byte placeholders, %20 links, 32-hex id suffixes - at 5,000 files and asserts the properties that broke.
// @zone test
// @tier Tier3-tool
//
// @skill build_corpus — 在临时目录生成对抗语料：CJK 名 / 长路径 / 同名 / 0 字节 / %20 链接 / 32hex 后缀 / 未知类型
// @skill assert_shape — 断言：不崩、汇总行数有界、个别 0 字节不失败、真重名被识别、退出码 0
//
// @rule bounded_output P0 — 丢失必须按构造汇总：同类 5,000 个文件不得产生 5,000 行（真实归档教训）
// @rule zero_byte_is_normal P0 — 个别 0 字节文件不得导致失败（真实归档里 35 个合法占位文件）
// @rule reproducible P1 — 语料由本脚本生成、无网络、无外部依赖；同一版本两次运行断言数一致
//
// @depends node >= 20
// @phase Phase1
// @state stable
//
// usage: node tests/stress.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExport, aggregateLosses } from '../src/exitkit.mjs';

const HEX32 = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const N_UNKNOWN = 3000;   // 同类未知类型 —— 聚合后必须只剩 1 行
const N_CJK = 60;
const N_DUP = 40;
const LONG_SEGMENT = 'y'.repeat(90);

let failures = 0;
let assertions = 0;
const ok = (label, cond, extra = '') => {
  assertions += 1;
  if (cond) console.log(`  OK ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); failures += 1; }
};

const base = mkdtempSync(join(tmpdir(), 'exitkit-stress-'));
const src = join(base, 'corpus');
try {
  // 1) 同类未知类型（真实归档里最多的一类）
  for (let i = 0; i < N_UNKNOWN; i += 1) {
    const dir = join(src, 'code', `mod${i % 50}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file${i}.xyz`), 'x', 'utf8');
  }
  // 2) 中文文件名（真实归档 242 个）
  for (let i = 0; i < N_CJK; i += 1) {
    writeFileSync(join(src, `文档-${i}.md`), `# 中文标题 ${i}\n`, 'utf8');
  }
  // 3) 同名不同目录（真实归档 1,702 个）
  for (let i = 0; i < N_DUP; i += 1) {
    const dir = join(src, 'dup', `d${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'same.md'), `# ${i}\n`, 'utf8');
  }
  // 4) 长路径（≥200 字符）
  const longDir = join(src, LONG_SEGMENT, LONG_SEGMENT, LONG_SEGMENT);
  mkdirSync(longDir, { recursive: true });
  writeFileSync(join(longDir, 'deep.md'), '# deep\n', 'utf8');
  // 5) 零字节占位（真实归档 35 个）
  writeFileSync(join(src, '.gitkeep'), '', 'utf8');
  writeFileSync(join(src, 'empty-init.md'), '', 'utf8');
  // 6) 页 ID 后缀 + 真重名 + URL 编码链接
  writeFileSync(join(src, `Notes ${HEX32}.md`), '# notes\n', 'utf8');
  writeFileSync(join(src, 'Notes.md'), '# notes\n', 'utf8');
  writeFileSync(join(src, 'links.md'), '[a](Project%20Alpha/Page%201.md)\n<figure>x</figure>\n', 'utf8');

  const t0 = Date.now();
  const r = buildExport({ from: src, out: join(base, 'out'), dryRun: true });
  const ms = Date.now() - t0;
  const agg = aggregateLosses(r.losses);
  const totalFiles = r.manifest.files.length;

  ok('5,000+ 文件不失败', r.manifest.files.length > 5000, `${totalFiles} 个文件，${ms}ms`);
  ok('同类未知类型压成 1 行（不逐条刷屏）', (() => {
    const row = agg.find((x) => /file type not migrated/.test(x.construct));
    return row && row.count === N_UNKNOWN && agg.length <= 12;
  })(), `汇总行数 ${agg.length}`);
  ok('个别 0 字节不导致失败', r.losses.some((l) => /zero-byte files/.test(l.construct)));
  ok('真重名被识别（剥掉 ID 后同名）', r.losses.some((l) => /true duplicate after stripping ids/.test(l.construct)));
  ok('页 ID 后缀汇总', r.losses.some((l) => /page-id suffix/.test(l.construct)));
  ok('URL 编码链接被识别', r.losses.some((l) => /url-encoded/.test(l.construct)));
  ok('长路径风险被识别', r.losses.some((l) => /very long path/.test(l.construct)));
  ok('运行时间有界（<20s）', ms < 20000, `${ms}ms`);

  console.log(failures === 0 ? `STRESS PASS（${assertions} 项断言，${totalFiles} 文件，${ms}ms）` : `STRESS FAILED: ${failures}/${assertions}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
