# exitkit — turn a platform export into a receipt you can check

Platforms let you export. What they do not tell you is **what you will lose** when you leave. This tool takes the *official* export (a zip or a folder), and writes three things:

1. `canonical/` — your files, kept at their original paths, each one hashed;
2. `manifest.json` — per-file `sha256` + bytes, plus a fingerprint of the whole source archive;
3. `receipt.md` — **what you can take / what you will lose / what the export cannot tell you**.

Anyone can re-check the first two without trusting me:

```bash
node src/exitkit.mjs --from export.zip --out ./out   # or --from ./exported-folder
node src/exitkit.mjs --verify ./out                  # recomputes every hash; exits 1 on any mismatch
node src/exitkit.mjs --report ./out                  # re-render the receipt from manifest.json (no source needed)
```

Real output from a sample export (2026-11-24):

```
OK：4 个文件 → ./out
  丢失检出 3 条 · 不可核声明 6 项
  收据：./out/receipt.md
  复核：node src/exitkit.mjs --verify ./out
```

## What the receipt actually says

| 段 | 内容 | 为什么必须有 |
|---|---|---|
| 能带走什么 | N 个文件，按 kind 分类，逐个 sha256 | 让你能独立复核，而不是相信"已迁移" |
| 会丢什么 | **从导出包里检出**的丢失：指向包外页面的关系链接、无 Markdown 等价物的内嵌 HTML、未映射的文件类型 —— 每条带证据路径与计数 | 这些是有字节证据的 |
| 我核不了什么 | 视图/筛选、公式与 rollup 的定义、权限与共享、评论、版本历史、模板与自动化 | **导出包物理上不含**这些；写成"已迁移"就是撒谎 |
| 风险（不是丢失） | 路径 ≥200 字符、不同目录同名、**32 位页 ID 后缀**、剥掉 ID 后的真重名、**链接里的 `%XX` 编码路径** | 迁移后才会咬人：Windows 260 字符上限（平台 FAQ 明写）、扁平化导入互相覆盖、**改名不重写链接就全断**、链接指向转义名 |

> 一份诚实的收据必须写出它核不了的东西。只写"已迁移 N 个文件"的收据，是把风险留给用户。

## 它不做什么

- **不抓取**：只吃平台官方导出包。绕开 ToS 与 schema 追捕。
- **不联网**：零请求、零遥测、零账号。
- **不导入**：本工具只负责"能带走什么"，导入是替代品的事（下一步才是可携带信誉）。
- **不承诺还原度**：不同替代品对同一份 Markdown 的还原度不同，这必须实测，不能写死。

## 自检：规则必须能红

```bash
node src/exitkit.mjs --self-test     # 10 例，全部离线
```

三条关键负例，都实测红过（不是"写了没生效"）：

| 注入的缺陷 | 结果 |
|---|---|
| 等长篡改一个字节（大小不变） | `--verify` 红并点名 —— 只有哈希能抓到，字节数抓不到 |
| 让 `other` 类型不进 losses | 自检红（"未把未知类型静默丢弃"失败） |
| 把空扩展名塞进 asset 白名单 | 自检红 ×2（无扩展名文件会被误判成 asset，等于静默丢失） |
| 关掉超长路径的 risk 检出 | 自检红（"风险"被静默吞掉） |
| 让 `--report` 每次附加时间戳 | 自检红（破坏幂等：同一份清单重出的收据必须逐字节相同） |
| 跳过"生成式重名后缀"检测 | 自检红（文件名不相等，只查完全相同会漏） |
| 关掉 URL 编码检测 | 自检红（迁移后链接指向转义名） |

这几条不是我猜的。先是读了一个 MIT 许可的成熟迁移工具的解析实现（它会 `decodeURIComponent` 链接路径、显式清理 `-\d+` 后缀），再查了三处独立来源确认：**页 ID 后缀不是重名专用，而是几乎每个导出的页文件/目录都带 `<Title> <32hex>`**，且正文链接**指向这些带 ID 的名字**——所以"改名"和"修链接"必须原子完成，单独做任一半都会断链。

（来源：formatarc 的导出怪癖整理、xerj 的实测记录、flowproductivity 的实操复盘；**我尚未在自己的真实导出上复核这一点**，标为 UNVERIFIED at first hand。）

我最初把它实现成"重名才加后缀"，那会在真实导出里对**每个文件**报警——噪音，而且掩盖了真正要紧的事（链接重写）。改成"汇总计数 + 真重名单独判定"后才对。

## 预注册的止损判据（30 天）

被真实使用，需满足**任一**：

1. ≥3 个外部 GitHub 账号提交含**真实账号产物**的 issue（schema 崩、异常时间戳、媒体 404）；
2. ≥1 个无关的开源替代项目合并 PR 或在 onboarding 里链接；
3. ≥1 份公开收据。

**星标、克隆、下载量不计入。** 三项全 0 ⇒ 写复盘，**不做 v2**。

## 状态（如实）

- `--from` 目录 / zip、`canonical/`、`manifest.json`、`losses.json`、`receipt.md`、`--verify`、`--report`、`--dry-run`、`--self-test`（17 例）：**已实现且自检通过**。
- **尚未**在真实平台导出包上验证过（等一份真实导出；这是唯一挡住 Phase 1.1 的东西）。在跑过真包之前，本 README 里任何"能还原"的暗示都应视为**未验证**。
- 目标垂直的选择与理由见 `PHASE0-selection.md`。

## 许可

MIT。拿去用、拿去改、拿去批评。

## Real data changed two rules (2026-11-24)

I could not get a real platform export, so I ran the tool against a **real archive I do have**: a 45,503-file git archive (410 MB) with 242 Chinese filenames and 1,702 duplicate basenames.

| 我原来的规则 | 真实数据怎么说 | 现在 |
|---|---|---|
| 任何 0 字节文件 ⇒ 判"导出未完成"、直接失败 | 真实归档里有 35 个合法的 0 字节文件：`.gitkeep`、`.nojekyll`、空的 `__init__.py`、空 fixture | 只有**全部**文件为 0 字节才算坏导出；个别 0 字节降级为风险汇总 |
| 每条丢失各占一行 | 41,623 个文件产生 **37,899** 条逐条记录 —— 这是噪音，不是信息 | **按构造汇总**（count + 少量样例），收据里是表格 |

两次都是真实数据先打我的脸，然后才改对。自检 17 → 19 例，两条新断言都注入验证过会红。

**这仍然不等于"验证过真实平台导出"**：它验证的是机制在真实规模与真实脏数据下的行为。平台特有的怪癖（页 ID 后缀、`%XX` 链接）仍是外部来源描述，标 UNVERIFIED。

## DFC / Open Food Network: predicting the import's losses from its source

The second target is not a note-taking app. It is an **open-source, community-owned food commerce platform** — Open Food Network (AGPL-3.0, 1,303 stars, active) — which imports product catalogs in the **DFC** interchange format. Five of its open issues are the same family of failure: the import loses fields.

Rather than guess, `src/dfc.mjs` reads the import mapping out of their source and predicts the losses, each rule citing `file:line` at a pinned commit:

| rule | what their code does | predicted loss |
|---|---|---|
| `variant-name-overwritten` | `variant.display_name = supplied_product.name` (`supplied_product_importer.rb:117`) | each spec's own name is replaced by the product name |
| `unit-taken-from-product-quantity` | `QuantitativeValueBuilder.apply(supplied_product.quantity, variant)`, `value = quantity.value * unit_scale` (`:119` + `quantitative_value_builder.rb:32`) | spec-level unit/scale is not used; kg↔g style scale changes |
| `taxon-falls-back-to-first` | `taxons.first \|\| Spree::Taxon.first` (`product_type_importer.rb:19`, their own comment: "we return a random one") | if the target instance has no taxon for this `dfc_id`, the product lands in an arbitrary first category |
| `tax-category-not-applied` | `apply()` writes price and stock only (`offer_builder.rb:30`); read side is `super \|\| TaxCategory.find_by(is_default: true)` (`variant.rb:204-206`) | the source tax category is ignored and the **instance default** silently applies — a wrong rate, not a blank field |

```bash
node src/dfc.mjs --graph fixtures/dfc/beer-catalog.json   # 4 predicted losses, each with a citation
node tests/dfc-roundtrip.mjs                              # 9 assertions, both directions
```

**This is a prediction read from source, not a measurement.** The receipt says so in its first line, and it lists what it cannot check (runtime transforms, downstream tax defaults). Pinned commit: `e13ef4d7fdc85d6f165638f574cec1492437750d`.

Both directions are tested, because a predictor that only ever fires is not a predictor:

| injection | result |
|---|---|
| make it never report anything | 3 assertions FAIL (exit 1) |
| make it always report one loss | "clean catalog ⇒ 0" FAILs (exit 1) |
| strip a rule's citation | the rule-table assertion FAILs first (exit 1) |

## Licence landscape (measured, not assumed)

"Open source" does not mean "commercially usable". Read the LICENSE:

| project | stars | licence | commercial use |
|---|---|---|---|
| Open Food Network | 1,303 | AGPL-3.0 | allowed (copyleft + network clause) |
| Medusa | 37,388 | MIT except Enterprise | allowed |
| Saleor | 23,600 | BSD-3 | allowed, cleanest |
| Vendure | 8,614 | GPLv3 or commercial | copyleft |
| CoopCycle | 605 | custom "Coopyleft": commercial use reserved to qualifying entities | **restricted** |
