# 待发（未发布）：OFN issue 复现贴

> 状态：**草稿，未发布。** 等你确认"可以用 `zjdyzww` 这个 GitHub 身份对外发言"。

## 定位（这一条先想清楚，否则整篇都是错的姿态）

**我不是去报新 bug。** 这四条全部已经是上游公开的 issue（#14861/#14862/#14863/#14864/#14865）。我能提供的是**别人没提供的那一部分**：把这些 issue 背后的映射**固定到行号**，并给出一个**可以离线重算的模型**，让他们不必靠贴图对账。

所以整篇的姿态是：「这是我对你们代码的读法，错了请纠正」，而不是「我发现你们有 bug」。

## 发帖前自检（顺序不能反）

1. [ ] 我的 4 条规则，**每条都能在他们的 HEAD 上指到行号**（已做：`e13ef4d7`）
2. [ ] 没有把"预测"写成"实测"（措辞必须含 "from reading the source"，不含 "I tested"）
3. [ ] 没有说"你们错了"，只说"这段代码在 X 输入下会产生 Y"
4. [ ] 附最小语料（可直接粘的 JSON），让他们能一分钟复现
5. [ ] 不承诺 PR、不要 star、不问报酬

## 发帖前必须声明的前情（否则会像没做功课）

**PR #14950（open，2026-10-26，Closes #14864）已经修了"分类查不到映射就落到第一个分类"**，并且它的描述与我从源码读到的机制完全一致。

所以我的帖子**不能再把分类回落当发现**，只能收敛到 #14950 没有覆盖的两处：**税分类的静默回落** 与 **单位乘数导致的标度变化**。帖子里必须先写一句"我看到 #14950 覆盖了分类，下面是我在它范围之外看到的"。

## 草稿（英文，贴 #14865）

> **Tax category is silently replaced, not omitted**
>
> While reading `engines/dfc_provider/app/services/supplied_product_importer.rb` at `e13ef4d7` for an unrelated data-portability question, I noticed `apply/2` writes `price` and `stockLimitation` from the offer but never the offer's `taxCategory` (`offer_builder.rb:30`).
>
> That on its own would just mean "missing", but `app/models/spree/variant.rb:204-206` reads:
>
> ```ruby
> def tax_category
>   super || TaxCategory.find_by(is_default: true)
> end
> ```
>
> so a variant imported from a DFC catalog does not end up with an empty tax category — it ends up with the **instance default**, which for a catalog spanning several tax rates is a silently wrong rate rather than a visible gap. That seems worse than the issue title suggests, so I wanted to check whether this is intended.
>
> Minimal reproduction input (DFC v1, one product, one offer carrying a tax category):
>
> ```json
> { "@graph": [ {
>   "@type": "dfc-b:SuppliedProduct",
>   "@id": "https://example.org/p/biere",
>   "dfc-b:name": "Bière blanche",
>   "dfc-b:productType": "dfc-m:BEVERAGE",
>   "dfc-b:quantity": { "@type": "dfc-b:QuantitativeValue", "dfc-b:value": 1, "dfc-b:unit": "dfc-m:KILOGRAM" },
>   "dfc-b:catalogItems": [ { "@type": "dfc-b:CatalogItem",
>     "dfc-b:offers": [ { "@type": "dfc-b:Offer", "dfc-b:price": { "dfc-b:value": 3.8 }, "dfc-b:taxCategory": "fr:tax-5.5" } ] } ]
> } ] }
> ```
>
> Expected: imported variant's tax category == `fr:tax-5.5`. Observed by reading: no assignment on the import path, so `tax_category` resolves to the default. I have not run this against an instance — if a downstream step (fee applicator? `ProductGroupBuilder`?) does assign it, ignore me.
>
> I saw #14950 already fixes the category fallback ("can't be mapped" -> keep existing), so I am not reporting that. What it does not cover, as far as I can read:
>
> `variant.display_name = supplied_product.name` (`:117`), `QuantitativeValueBuilder.apply(supplied_product.quantity, variant)` using the **product-level** quantity (`:119`, multipliers at `quantitative_value_builder.rb:99-102`), and the taxon lookup: `ProductTypeImporter.taxon` ends with `taxons.first || Spree::Taxon.first` (`product_type_importer.rb:19`) — their own comment says "If we don't find any matching taxon, we return a random one". So a catalog whose product type has no `dfc_id` in the target instance is filed under the **first** category rather than left unclassified. Those look like the same family as #14861/#14862/#14864.

## 若被回应"有用/可复现"

- Phase C：提一个**只含夹具 + 回归测试**的 PR（不带营销文案）。
- 先读 `CONTRIBUTING.md` 确认 CLA/DCO 要求（**当前 UNVERIFIED**），满足后再提。

## 若被判定 off-scope 或 30 天零回应

- **停。** 把复现留在仓库里作为回归夹具，不追人、不重复发帖。
