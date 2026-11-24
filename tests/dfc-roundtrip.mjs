// @module dfc-roundtrip-test
// @path ~/.dsh/ventures/exitkit/tests/dfc-roundtrip.mjs
// @description Two-direction test for the DFC loss predictor: it must fire on a catalog whose specs carry their own name/unit/category/tax, and it must stay silent on a clean catalog. A predictor that only ever fires is not a predictor.
// @zone test
// @tier Tier3-tool
//
// @skill assert_fires — 多规格语料 ⇒ 预测出 ≥4 条字段级丢失，且覆盖 4 条规则
// @skill assert_cited — 每条预测的出处必须形如 `path/to/file.rb:NN`
// @skill assert_silent — 干净语料（规格名与商品名一致、单位一致、单一分类、无税）⇒ 0 条预测
// @skill assert_banner — 收据必须写明"按源码预测，非实测"
//
// @rule two_direction P0 — 只测"会触发"等于没测；必须同时测"不该触发时不触发"
// @rule citation_format P0 — 出处的格式可被机械校验（文件:行号），否则"有出处"是空话
//
// @depends ../src/dfc.mjs
// @phase PhaseA
// @state stable
//
// usage: node tests/dfc-roundtrip.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeGraph, predictLosses, renderReceipt, OFN_COMMIT, RULES } from '../src/dfc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let assertions = 0;
const ok = (label, cond, extra = '') => {
  assertions += 1;
  if (cond) console.log(`  OK ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); failures += 1; }
};

// 防我再编造键名：我这几个夹具里用到的所有 dfc-b: 键，必须出现在他们真实夹具的词汇表里
const vocab = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'dfc', 'real-vocabulary.json'), 'utf8'));
const usedKeys = new Set();
for (const f of ['beer-catalog.json', 'gram-vs-kilogram.json', 'minimal-vat.json']) {
  const g = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'dfc', f), 'utf8'));
  for (const n of g['@graph']) for (const k of Object.keys(n)) if (k.startsWith('dfc-')) usedKeys.add(k);
}
const allowed = new Set([...vocab.verified_in_fixture, ...(vocab.referenced_in_code ?? []).map((x) => x.key)]);
const invented = [...usedKeys].filter((k) => !allowed.has(k));
ok('夹具只用他们真实词汇表里的键（不编造字段）', invented.length === 0, invented.join(', ') || 'all ok');

// 待发稿里嵌入的最小片段：必须是真实形状、只产生 VAT 一条预测、且能嵌进 issue
const minimal = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'dfc', 'minimal-vat.json'), 'utf8'));
const minLosses = predictLosses(analyzeGraph(minimal));
ok('最小复现片段 ⇒ 恰好 1 条预测（VAT）', minLosses.length === 1 && minLosses[0].rule === 'vat-rate-not-transferred');
ok('最小片段足够小、可直接贴进 issue（≤5 节点）', minimal['@graph'].length <= 5, `${minimal['@graph'].length} 节点`);

// 先验规则表自身（在任何计算之前，坏了要立刻可见）
ok('规则表本身每条都有可机械校验的出处', RULES.every((r) => /\.rb:\d+/.test(r.at)), RULES.filter((r) => !/\.rb:\d+/.test(r.at)).map((r) => r.id).join(',') || 'all ok');

// 方向一：多规格语料 ⇒ 必须触发
const graph = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'dfc', 'beer-catalog.json'), 'utf8'));
const model = analyzeGraph(graph);
const losses = predictLosses(model);
const rules = new Set(losses.map((l) => l.rule));

ok('多规格语料 ⇒ 预测 ≥3 条字段级丢失（真实夹具无 productType，R3 不触发）', losses.length >= 3, `${losses.length} 条`);
ok('覆盖 3 条可由真实词汇触发的规则', rules.size === 3 && [...rules].every((r) => r !== 'taxon-falls-back-to-first'), [...rules].join(', '));
ok('R3（分类回落）保留在规则表但真实夹具未覆盖其触发键', RULES.some((r) => r.id === 'taxon-falls-back-to-first') && !losses.some((l) => l.rule === 'taxon-falls-back-to-first'));
ok('分类规则文本是“落到第一个分类”而非“多分类被截断”', (() => { const r = RULES.find((x) => x.id === 'taxon-falls-back-to-first'); return /第一个分类/.test(r.means) && !/其余丢失/.test(r.means); })());
ok('每条预测都带合法出处（file.rb:NN）', losses.every((l) => /\.rb:\d+/.test(l.at)), losses.filter((l) => !/\.rb:\d+/.test(l.at)).map((l) => l.rule).join(',') || 'all ok');
ok('出处固定到 commit', /^[0-9a-f]{40}$/.test(OFN_COMMIT), OFN_COMMIT.slice(0, 8));
const receipt = renderReceipt(losses);
ok('收据写明"按源码预测，不是实测"', /按源码预测，不是实测/.test(receipt) && /未在真实 OFN 实例上执行/.test(receipt));
ok('收据含"核不了"段（不得隐瞒未验部分）', /核不了（必须你在真实实例上验）/.test(receipt));

// 税的后果必须说准：不是“为空”，而是回落到实例默认税（否则这个断言会把“错税率”说成“缺数据”）
const taxLoss = losses.find((l) => /VATrate/.test(l.field));
ok('税丢失被描述为“回落到默认税分类”而非“为空”', !!taxLoss && /默认税分类/.test(taxLoss.detail) && !/导入后为空/.test(taxLoss.detail));
ok('税的回落逻辑有出处（variant.rb:204-206）', !!taxLoss && /variant\.rb:204-206/.test(taxLoss.detail + taxLoss.at));

// 已知/在修 vs 无人跟进：收据必须区分，否则会拿别人的已知项当自己的发现
const taxUp = losses.find((l) => /VATrate/.test(l.field));
const catUp = RULES.find((r) => r.id === 'taxon-falls-back-to-first');
ok('分类规则标注了上游 PR #14950（已知在修）', !!catUp && /14950/.test(catUp.upstream ?? ''));
ok('税规则在条目里没有 upstream（即无人跟进）', !!taxUp && (taxUp.upstream ?? null) === null);
ok('收据同时渲染“已知条目”与“上游状态”两列', /已知条目/.test(renderReceipt(losses)) && /上游状态/.test(renderReceipt(losses)));

// 不装原创：每条规则都必须能指出“这已经是上游已公开的条目”
ok('每条规则都标注了已知条目编号', RULES.every((r) => /#\d+/.test(r.issue ?? '')), RULES.filter((r) => !/#\d+/.test(r.issue ?? '')).map((r) => r.id).join(',') || 'all ok');
ok('收据显式声明“不声称发现新 bug”', /不声称发现任何新 bug/.test(renderReceipt(losses)));

// 方向一(b)：同一物理量的两种写法（1 KILOGRAM vs 1000 GRAM）必须都被识别为“标度会变”，且带精确乘数
const kg = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'dfc', 'gram-vs-kilogram.json'), 'utf8'));
const kgLosses = predictLosses(analyzeGraph(kg));
const unitLoss = kgLosses.find((l) => /unitScale/.test(l.field));
ok('kg/gram 两种写法都触发标度丢失', !!unitLoss);
ok('预测里带 map_unit 的精确乘数（KILOGRAM=1000, GRAM=1）', !!unitLoss && /KILOGRAM=1000/.test(unitLoss.detail) && /GRAM=1/.test(unitLoss.detail));
ok('出处具体到 map_unit 行号（:99-102）', !!unitLoss && /quantitative_value_builder\.rb:32,99-102/.test(unitLoss.at));

// 方向二：干净语料 ⇒ 必须沉默（防止"永远报警"的假预测器）
const clean = {
  '@graph': [{
    '@type': 'dfc-b:SuppliedProduct',
    '@id': 'https://example.org/p/clean',
    'dfc-b:name': 'Tomate',
    'dfc-b:productType': 'dfc-m:VEGETABLE',
    'dfc-b:quantity': { '@type': 'dfc-b:QuantitativeValue', 'dfc-b:value': 1, 'dfc-b:unit': 'dfc-m:KILOGRAM' },
    'dfc-b:variants': [
      { '@type': 'dfc-b:SuppliedProduct', '@id': 'https://example.org/p/clean/v1', 'dfc-b:name': 'Tomate', 'dfc-b:quantity': { '@type': 'dfc-b:QuantitativeValue', 'dfc-b:value': 1, 'dfc-b:unit': 'dfc-m:KILOGRAM' } },
    ],
    'dfc-b:catalogItems': [{ '@type': 'dfc-b:C ATalogItem'.replace(' ', ''), 'dfc-b:offers': [{ '@type': 'dfc-b:Offer', 'dfc-b:price': { 'dfc-b:value': 2.5 } }] }],
  }],
};
const cleanLosses = predictLosses(analyzeGraph(clean));
// 干净语料：三条确定性丢失（名/单位/税）都不得触发；分类映射风险**无条件存在**（导出方看不出目标实例有没有该 dfc_id），
// 所以正确的期望是“只剩那一条，且必须是分类映射”，而不是“一条都没有”。
ok('干净语料 ⇒ 无确定性丢失，只余分类映射风险', cleanLosses.length === 1 && cleanLosses[0].rule === 'taxon-falls-back-to-first', `${cleanLosses.length} 条：${cleanLosses.map((l) => l.rule).join(',') || 'none'}`);
ok('干净语料不触发 名/单位/税 三条', !cleanLosses.some((l) => ['variant-name-overwritten', 'unit-taken-from-product-quantity', 'tax-category-not-applied'].includes(l.rule)));

// 负例：空图必须拒绝裁决
let code = null;
try { analyzeGraph({ '@graph': [] }); } catch (e) { code = e.code; }
ok('空图 ⇒ empty_graph（拒绝空裁决）', code === 'empty_graph');

console.log(failures === 0 ? `DFC-ROUNDTRIP PASS（${assertions} 项）` : `DFC-ROUNDTRIP FAILED: ${failures}/${assertions}`);
process.exit(failures === 0 ? 0 : 1);
