// @module dfc
// @path ~/.dsh/ventures/exitkit/src/dfc.mjs
// @description Predict what Open Food Network's DFC product import will LOSE, from its source, without running Ruby. Each loss rule cites file:line at a pinned commit so a maintainer can check the claim in under a minute.
// @zone action
// @tier Tier3-tool
//
// @skill analyze_graph — 读取 DFC v1 图（SuppliedProduct/variants/offers/catalogItems），归一化为产品与规格
// @skill predict_losses — 按 OFN 导入源码的**可引用映射规则**判定会丢什么：规格名被商品名覆盖、单位取自商品级数量、只保留单一分类、税分类不赋值
// @skill cite — 每条预测必须带 `file:line @ <sha>`；无出处即视为缺陷，不得输出
// @skill render_receipt — 产出人读段落：可带走 / 会丢（含出处）/ 核不了（需在真实实例上验）
//
// @rule citation_required P0 — 每条丢失去向必须带出处（文件+行号+commit sha）；缺出处不得输出该条
// @rule prediction_not_execution P0 — 本模块输出的是「按源码预测」，不是「已实测」；收据必须写明 "predicted from source @ sha，未在实例上执行"
// @rule no_guess_fields P0 — 字段名一律取自 DFC v1（`DataFoodConsortium::ConnectorV1`）与 OFN 的 builder，不按记忆命名
// @rule multi_variant_fixture P1 — 判定必须能区分两个 spec 不同的 variant；单 variant 夹具无法证明"规格级信息被覆盖"
//
// @depends node >= 20；无网络、无 Ruby、无 OFN 实例
// @phase PhaseA
// @state partial
//
// @error empty_graph — 图中没有 SuppliedProduct ⇒ exit 2，不产出空裁决
// @error missing_citation — 某条规则缺出处 ⇒ 抛错（不允许无出处断言）
//
// @metric losses_predicted [type:counter]
// @metric rules_cited [type:counter]
//
// @memory 2026-11-24 依据 OFN HEAD e13ef4d7fdc85d6f165638f574cec1492437750d 的 supplied_product_importer.rb / quantitative_value_builder.rb / offer_builder.rb 读出的映射
//
// usage: node src/dfc.mjs --graph <file.json> [--json]

export const OFN_COMMIT = 'e13ef4d7fdc85d6f165638f574cec1492437750d';

import { readFileSync } from 'node:fs';

export const RULES = [
  {
    id: 'variant-name-overwritten',
    issue: '#14861 / #14863（open，无 PR）',
    at: 'engines/dfc_provider/app/services/supplied_product_importer.rb:117',
    does: 'variant.display_name = supplied_product.name',
    means: '每个 spec 自己的名字会被**商品名**覆盖；spec 名（如“Bouteille / 500g 装”）在导入后消失',
  },
  {
    id: 'unit-taken-from-product-quantity',
    issue: '#14862 / #14861（open，无 PR）',
    at: 'engines/dfc_provider/app/services/supplied_product_importer.rb:119',
    also: 'engines/dfc_provider/app/services/quantitative_value_builder.rb:32,99-102',
    does: 'QuantitativeValueBuilder.apply(supplied_product.quantity, variant); value = quantity.value * unit_scale；map_unit: KILOGRAM→1000, GRAM→1, LITRE→1, MILLILITRE→0.001',
    means: '规格单位取自**商品级 quantity** 再乘 map_unit 的乘数 ⇒ 同一个物理量写成 `1 KILOGRAM` 与 `1000 GRAM`，导入后 variant_unit_scale 会是 1000 与 1（#14862 的“标度被改变”）',
  },
  {
    id: 'taxon-falls-back-to-first',
    at: 'engines/dfc_provider/app/services/product_type_importer.rb:19',
    does: 'taxons.first || Spree::Taxon.first   // 源码注释自述：“If we don’t find any matching taxon, we return a random one”',
    issue: '#14864（open，有 PR）',
    upstream: 'PR #14950（open，2026-10-26，Closes #14864）已修：无映射时保留 variant 现有分类，再回落到产品分类，最后才第一个 taxon',
    means: '分类只按单个 productType 查 dfc_id 映射；**查不到就落到该实例的第一个分类**。是否能对上取决于目标实例的 dfc_id 表，导出方无法预知',
  },
  {
    id: 'vat-rate-not-transferred',
    issue: '#14865（open，无 PR）',
    at: 'engines/dfc_provider/app/services/offer_builder.rb:30',
    also: 'app/models/spree/variant.rb:204-206',
    does: 'variant.price = price(offer)   // apply() 只写 price.value 与 stockLimitation；Price 上的 dfc-b:VATrate 未被读取。读侧 tax_category = super || TaxCategory.find_by(is_default: true)',
    means: 'DFC 用 **Price 上的 VATrate（税率字符串，如 "0"/"5.5"）** 表达税，OFN 用 tax category 表达税且导入不读 VATrate ⇒ 回落到该实例的默认税分类。后果不是缺数据，而是**静默套用错误税率**',
  },
];

/** 取 JSON-LD 键的值：按“后缀”匹配（`dfc-b:name` / `name` 都能命中），因为我没有一份已验证的真实 DFC v1 样本。 */
function pick(obj, suffix) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of Object.keys(obj)) {
    const tail = k.includes(':') ? k.split(':').pop() : k;
    if (tail === suffix) return obj[k];
  }
  return undefined;
}

function asArray(v) { return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]; }

/** 取节点上 catalogItems[0].offers（DFC v1 的报价挂在 catalogItem 上）。 */
function offersOf(node) {
  const item = asArray(pick(node, 'catalogItems'))[0];
  return asArray(pick(item, 'offers'));
}

function typeOf(node) {
  const t = pick(node, 'type') ?? node?.['@type'] ?? node?.semanticType;
  return typeof t === 'string' ? t : asArray(t).join(',');
}

/** 从 DFC 图里取商品与其 specs。返回 { products } —— 只认有 @type 含 SuppliedProduct 的节点。 */
export function analyzeGraph(graph) {
  const nodes = asArray(graph?.['@graph'] ?? graph?.graph ?? graph);
  if (nodes.length === 0) {
    throw Object.assign(new Error('图中没有节点（拒绝空裁决）'), { code: 'empty_graph' });
  }
  // 真实 DFC 是引用图：节点之间用 @id 字符串互相指。先建索引再解析。
  const byId = new Map();
  for (const n of nodes) if (n?.['@id']) byId.set(n['@id'], n);
  const deref = (v) => {
    if (typeof v === 'string' && byId.has(v)) return byId.get(v);
    // 真实 DFC 常把引用写成 {"@id": "_:b1096"} 对象，而不是裸字符串
    if (v && typeof v === 'object' && !Array.isArray(v) && v['@id'] && Object.keys(v).length === 1 && byId.has(v['@id'])) {
      return byId.get(v['@id']);
    }
    if (Array.isArray(v)) return v.map(deref).filter(Boolean);
    return v;
  };
  const qtyOf = (node) => {
    const q = deref(pick(node, 'hasQuantity') ?? pick(node, 'quantity'));
    if (!q || typeof q !== 'object') return null;
    return { value: pick(q, 'value') ?? null, unit: pick(q, 'hasUnit') ?? pick(q, 'unit') ?? null };
  };

  const supplied = nodes.filter((n) => /SuppliedProduct/i.test(typeOf(n)));
  if (supplied.length === 0) {
    throw Object.assign(new Error('图中没有 SuppliedProduct（拒绝空裁决）'), { code: 'empty_graph' });
  }

  // 报价路径：SuppliedProduct.referencedBy -> CatalogItem.offeredThrough -> Offer.hasPrice -> Price
  const priceOf = (node) => {
    const refs = asArray(deref(pick(node, 'referencedBy')));
    for (const ci of refs) {
      const offers = asArray(deref(pick(ci, 'offeredThrough')));
      for (const off of offers) {
        const price = deref(pick(off, 'hasPrice'));
        if (price) return { value: pick(price, 'value') ?? null, vatRate: pick(price, 'VATrate') ?? null, unit: pick(price, 'hasUnit') ?? null };
      }
    }
    return null;
  };

  const products = supplied.map((n) => ({
    id: pick(n, 'id') ?? n?.['@id'] ?? null,
    name: pick(n, 'name') ?? null,
    productType: deref(pick(n, 'productType')) ?? null,
    quantity: qtyOf(n),
    price: priceOf(n),
    variants: [
      ...asArray(deref(pick(n, 'variants'))),
      // 真实 DFC：子项通过 dfc-b:isVariantOf 指向父商品
      ...supplied.filter((c) => asArray(deref(pick(c, 'isVariantOf'))).some((par) => (pick(par, 'id') ?? par?.['@id']) === (n?.['@id']))),
    ].map((v) => ({
      id: pick(v, 'id') ?? v?.['@id'] ?? null,
      name: pick(v, 'name') ?? null,
      quantity: qtyOf(v),
      price: priceOf(v),
    })),
  }));
  return { products, nodeCount: nodes.length };
}

/** 按源码规则预测导入会丢什么；每条带出处，缺出处直接抛错。 */
export function predictLosses({ products }) {
  const losses = [];
  const cite = (ruleId) => {
    const r = RULES.find((x) => x.id === ruleId);
    if (!r?.at) throw Object.assign(new Error(`规则缺出处：${ruleId}`), { code: 'missing_citation' });
    return r;
  };
  for (const p of products) {
    // R1：spec 名被商品名覆盖
    const named = p.variants.filter((v) => v.name && v.name !== p.name);
    if (named.length > 0) {
      const r = cite('variant-name-overwritten');
      losses.push({
        field: 'spec.name', scope: `product:${p.name}`, rule: r.id, at: r.at, issue: r.issue ?? null,
        detail: `${named.length} 个 spec 有自己的名字（${named.map((v) => v.name).join(' / ')}），导入后会变成商品名「${p.name}」`,
      });
    }
    // R2：spec 级单位不参与
    const specUnits = p.variants.map((v) => pick(v.quantity, 'unit')).filter(Boolean);
    const prodUnit = pick(p.quantity, 'unit');
    const distinct = [...new Set(specUnits)];
    if (distinct.length > 1 || (distinct.length === 1 && prodUnit && distinct[0] !== prodUnit)) {
      const r = cite('unit-taken-from-product-quantity');
      losses.push({
        field: 'spec.unit / spec.unitScale', scope: `product:${p.name}`, rule: r.id, at: `${r.at} + ${r.also}`, issue: r.issue ?? null,
        detail: `spec 单位 ${distinct.join(' / ')}，商品级单位 ${prodUnit ?? '(空)'}；导入 value = quantity.value × map_unit(乘数)（KILOGRAM=1000, GRAM=1, LITRE=1, MILLILITRE=0.001），spec 自带标度不参与`,
      });
    }
    // R3：分类映射失败会落到“第一个分类”（不是“多分类被截断”）
    const types = asArray(p.productType).filter(Boolean).map(String);
    if (types.length > 0) {
      const r = cite('taxon-falls-back-to-first');
      losses.push({
        field: 'product.categories[]', scope: `product:${p.name}`, rule: r.id, at: r.at,
        detail: `源 productType=${types.join(' / ')}；只按单个类型查 dfc_id 映射，**查不到就落到目标实例的第一个分类**（源码注释自述 random）。映射是否存在我无法从仓库判断`,
        issue: r.issue ?? null,
        upstream: r.upstream ?? null,
      });
    }
    // R4：税分类不赋值
    const anyTax = [p.price?.vatRate, ...p.variants.map((v) => v.price?.vatRate)].filter((v) => v !== null && v !== undefined && v !== '');
    if (anyTax.length > 0) {
      const r = cite('vat-rate-not-transferred');
      losses.push({
        field: 'price.VATrate', scope: `product:${p.name}`, rule: r.id, at: r.at, issue: r.issue ?? null,
        detail: `源 Price 带 VATrate=${[...new Set(anyTax)].join(' / ')}；导入不读它 ⇒ 回落到实例的默认税分类（app/models/spree/variant.rb:204-206），**用错税率而不是留空**；该实例的默认值我无法从仓库得知`,
      });
    }
  }
  return losses;
}

export function renderReceipt(losses, { commit = OFN_COMMIT } = {}) {
  const lines = [];
  lines.push('## 目标侧预测：导入 Open Food Network 会丢什么');
  lines.push('');
  lines.push(`> **这是按源码预测，不是实测。** 出处固定到 commit \`${commit}\`；未在真实 OFN 实例上执行。`);
  lines.push('');
  if (losses.length === 0) {
    lines.push('未预测到字段级丢失（不代表真的不丢：本模型只覆盖 4 条已读源码的规则）。');
    return lines.join('\n');
  }
  lines.push('| 字段 | 会丢什么 | 出处 | 已知条目 | 上游状态 |');
  lines.push('|---|---|---|---|---|');
  for (const l of losses) lines.push(`| \`${l.field}\` | ${l.detail} | \`${l.at}\` | ${l.issue ?? '**无**'} | ${l.upstream ?? '—'} |`);
  lines.push('');
  lines.push('> **本工具不声称发现任何新 bug。** 上述条目都是上游已公开的 issue；这里提供的是**可引用的机制与行号**，以及一个能离线重算的模型。');
  lines.push('');
  lines.push('## 核不了（必须你在真实实例上验）');
  lines.push('');
  lines.push('- 上述四条是静态阅读的预测；运行时是否另有转换（如 ProductGroupBuilder）未验。');
  lines.push('- 税分类是否被下游默认值补上，未验。');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--graph');
  if (i < 0) { console.error('用法：--graph <file.json> [--json]'); process.exit(2); }
  try {
    const graph = JSON.parse(readFileSync(args[i + 1], 'utf8'));
    const model = analyzeGraph(graph);
    const losses = predictLosses(model);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ commit: OFN_COMMIT, products: model.products.length, losses }, null, 2));
    } else {
      console.log(renderReceipt(losses));
      console.log(`\n预测 ${losses.length} 条 · 引用 ${new Set(losses.map((l) => l.rule)).size} 条规则 · commit ${OFN_COMMIT.slice(0, 8)}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`ERROR ${err.code ?? ''}: ${err.message}`);
    process.exit(2);
  }
}

// 只有直接执行才跑 CLI；被 import 时不执行（便于测试）
if (process.argv[1] && process.argv[1].endsWith('dfc.mjs')) main();
