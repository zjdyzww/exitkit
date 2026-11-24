#!/usr/bin/env node
// @module verify-citations
// @path ~/.dsh/ventures/exitkit/tools/verify-citations.mjs
// @description Check that every `file.ext:NN` citation in a document points at an existing, non-empty line in the corresponding source file, and optionally that the line contains an expected token. Built after a citation of mine pointed at a blank line in a published document.
// @zone tool
// @tier Tier3-tool
//
// @skill extract_citations — 从文档里抽出 `name.ext:NN[-MM]` 形式的引用（去重）
// @skill resolve_sources — 在 --sources 目录里按 basename 找到对应源文件
// @skill assert_non_empty — 行号必须存在且该行去掉空白后非空
// @skill assert_expected — 若给了 --expect "token"，该行必须包含它（大小写不敏感）
//
// @rule no_blank_citation P0 — 指向空行的引用一律判红：空行证明不了任何事，等于没有引用
// @rule no_missing_source P0 — 找不到源文件时判红（不允许"跳过即通过"）
// @rule offline_only P0 — 只读本地 --sources，不发网络请求
//
// @depends node >= 20
// @phase PhaseA
// @state stable
//
// @error no_doc — 缺 --doc ⇒ exit 2
// @error no_sources — 缺 --sources 或目录不存在 ⇒ exit 2
//
// @metric citations_total [type:counter]
// @metric citations_bad [type:counter]
//
// usage:
//   node tools/verify-citations.mjs --doc docs/dfc-import-losses.md --sources /path/to/ofn/files
//   node tools/verify-citations.mjs --doc docs/dfc-import-losses.md --sources /tmp/ofn --expect taxons.first
//   node tools/verify-citations.mjs --self-test

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const CITE = /([A-Za-z0-9_.-]+\.(?:rb|js|mjs|cjs|ts|py|go|java|php)):(\d+)(?:-(\d+))?/g;

export function extractCitations(text) {
  const out = new Map();
  for (const m of text.matchAll(CITE)) {
    const [, file, line, line2] = m;
    const key = `${file}:${line}${line2 ? `-${line2}` : ''}`;
    if (!out.has(key)) out.set(key, { file, lines: line2 ? [Number(line), Number(line2)] : [Number(line)] });
  }
  return [...out.values()];
}

/** 在 sources 目录里按 basename 建索引（大小写不敏感，只扫一层 + 一层子目录）。 */
export function indexSources(dir) {
  const index = new Map();
  const seen = new Set();
  const walk = (d, depth) => {
    if (seen.has(d) || depth > 2) return;
    seen.add(d);
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try { st = readFileSync(p, 'utf8'); } catch { continue; }
      const b = basename(name).toLowerCase();
      if (!index.has(b)) index.set(b, st);
    }
  };
  walk(dir, 0);
  return index;
}

export function check(docText, index, { expect = null } = {}) {
  const citations = extractCitations(docText);
  const results = [];
  for (const c of citations) {
    const src = index.get(c.file.toLowerCase());
    if (!src) { results.push({ citation: `${c.file}:${c.lines[0]}`, status: 'missing-source', detail: '源文件不在 --sources 里' }); continue; }
    const lines = src.split('\n');
    for (const n of c.lines) {
      const content = n >= 1 && n <= lines.length ? lines[n - 1] : null;
      if (content === null) { results.push({ citation: `${c.file}:${n}`, status: 'out-of-range', detail: `只有 ${lines.length} 行` }); continue; }
      if (content.trim() === '') { results.push({ citation: `${c.file}:${n}`, status: 'blank-line', detail: '空行证明不了任何事' }); continue; }
      if (expect && !content.toLowerCase().includes(expect.toLowerCase())) {
        results.push({ citation: `${c.file}:${n}`, status: 'missing-token', detail: `该行不含 "${expect}"：${content.trim().slice(0, 60)}` }); continue;
      }
      results.push({ citation: `${c.file}:${n}`, status: 'ok', detail: content.trim().slice(0, 60) });
    }
  }
  const bad = results.filter((r) => r.status !== 'ok');
  return { total: results.length, bad: bad.length, results };
}

function selfTest() {
  let failures = 0;
  let assertions = 0;
  const ok = (label, cond, extra = '') => {
    assertions += 1;
    if (cond) console.log(`  OK ${label}${extra ? ` — ${extra}` : ''}`);
    else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); failures += 1; }
  };
  const index = new Map([
    ['good.rb', ['# header', '', 'def fallback', '  Taxons.first || Spawn.first', 'end'].join('\n')],
    ['other.rb', ['line one', 'line two'].join('\n')],
  ]);

  const pass = check('see `good.rb:4` and other.rb:2', index);
  ok('非空且存在的引用通过', pass.bad === 0 && pass.total === 2, `${pass.total} 条`);

  const blank = check('see `good.rb:2`', index);
  ok('负例 指向空行 ⇒ 判红', blank.bad === 1 && blank.results[0].status === 'blank-line');

  const missing = check('see `absent.rb:1`', index);
  ok('负例 源文件缺失 ⇒ 判红（不跳过）', missing.bad === 1 && missing.results[0].status === 'missing-source');

  const range = check('see `other.rb:99`', index);
  ok('负例 行号越界 ⇒ 判红', range.bad === 1 && range.results[0].status === 'out-of-range');

  const token = check('see `good.rb:4`', index, { expect: 'Taxons.first' });
  ok('--expect 命中 ⇒ 通过', token.bad === 0);
  const tokenMiss = check('see `good.rb:4`', index, { expect: 'nonexistent-token' });
  ok('负例 --expect 未命中 ⇒ 判红', tokenMiss.bad === 1 && tokenMiss.results[0].status === 'missing-token');

  console.log(failures === 0 ? `VERIFY-CITATIONS SELF-TEST PASS（${assertions} 例）` : `VERIFY-CITATIONS SELF-TEST FAILED: ${failures}/${assertions}`);
  return failures === 0 ? 0 : 1;
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const doc = arg('--doc');
  const sources = arg('--sources');
  if (!doc || !existsSync(doc)) { console.error('no_doc: --doc <file.md>'); process.exit(2); }
  if (!sources || !existsSync(sources)) { console.error('no_sources: --sources <dir>'); process.exit(2); }
  const r = check(readFileSync(doc, 'utf8'), indexSources(sources), { expect: arg('--expect') });
  for (const x of r.results) if (x.status !== 'ok') console.log(`  ${x.status.toUpperCase()} ${x.citation} — ${x.detail}`);
  console.log(r.bad === 0 ? `CITATIONS OK：${r.total} 条全部指向非空行（exit 0）` : `CITATIONS BAD：${r.bad}/${r.total} 条不合格（exit 1）`);
  process.exit(r.bad === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('verify-citations.mjs')) main();
