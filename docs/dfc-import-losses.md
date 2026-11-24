# What Open Food Network's DFC import drops, pinned to file:line

**Status: a reading of their source, not a measurement.** Everything below cites a line at a fixed commit (`e13ef4d7fdc85d6f165638f574cec1492437750d`). Nothing here was executed against an OFN instance.

**This is not a bug report.** All four behaviours are already tracked upstream — the issue numbers are in the table. What this document adds is the *mechanism*: which line does it, and what the input looks like.

## The real DFC v1 shape

Read from their own import fixture, `spec/fixtures/files/fdc-catalog.json` (57 nodes, 8 products). It is a **reference graph**, not inline JSON:

```
SuppliedProduct --dfc-b:hasQuantity--> QuantitativeValue ({"@id": "_:b1095"}, dfc-b:hasUnit, dfc-b:value)
SuppliedProduct --dfc-b:referencedBy--> CatalogItem (dfc-b:offeredThrough, dfc-b:sku, dfc-b:stockLimitation)
CatalogItem     --dfc-b:offeredThrough--> Offer
Offer           --dfc-b:hasPrice--> Price (dfc-b:VATrate, dfc-b:hasUnit, dfc-b:value)
```

Two things worth knowing before touching this format:

- **Tax is a VAT rate on the price** (`dfc-b:VATrate`, a string like `"0"` or `"5.5"`). There is no `taxCategory` field in the vocabulary — that is an OFN concept, not a DFC one.
- References are often `{ "@id": "_:b1096" }` objects rather than bare strings, so any parser must resolve both forms.

## Four mappings, four losses

| field | their code | what happens | tracked upstream |
|---|---|---|---|
| `spec.name` | `variant.display_name = supplied_product.name` — `supplied_product_importer.rb:117` | each variant's own name is overwritten by the product name. `display_name` is rendered (`shared_helper.rb`), so a five-variant product shows the same string five times | #14861, #14863 |
| `spec.unit` / `spec.unitScale` | `QuantitativeValueBuilder.apply(supplied_product.quantity, variant)` — `:119`; `value = quantity.value * unit_scale` — `quantitative_value_builder.rb:32`; multipliers at `:99-102` | the **product-level** quantity is used, not the variant's. `KILOGRAM → 1000`, `GRAM → 1`, `LITRE → 1`, `MILLILITRE → 0.001`, so the same physical quantity written as `1 KILOGRAM` and as `1000 GRAM` lands as scale 1000 and scale 1 | #14862, #14861 |
| `product.categories[]` | `taxons.first \|\| Spree::Taxon.first` — `product_type_importer.rb:17` (their comment: *"If we don't find any matching taxon, we return a random one"*) | if the target instance has no taxon for that `dfc_id`, the item is filed under an arbitrary first category | #14864 — **open PR #14950 fixes this**, so this repo no longer claims it |
| `price.VATrate` | `apply()` writes `price` and `stockLimitation` only — `offer_builder.rb:30`; read side is `super \|\| TaxCategory.find_by(is_default: true)` — `variant.rb:204-206` | the source VAT rate is never read. The variant does not end up blank: it inherits the **instance default tax category**, i.e. a silently wrong rate rather than a visible gap | #14865 |

The last one is the case where "wrong" is worse than "missing": a blank field gets noticed during onboarding, a wrong rate gets invoiced to customers for months.

## Reproduce the prediction

```bash
node src/dfc.mjs --graph fixtures/dfc/minimal-vat.json    # 5-node catalog, one predicted loss
node tests/dfc-roundtrip.mjs                              # 25 assertions, offline
```

The model resolves the reference graph, applies the four mappings above, and prints a table with a citation per row and an "upstream status" column so that *known and in flight* stays visually separate from *nobody is on it*.

## What this cannot tell you

- Whether a downstream step re-applies a tax category (a fee applicator, `ProductGroupBuilder`) — unverified.
- Whether `productType` is present in practice: the import fixture carries none, so the category rule is implemented but **not exercised** against real vocabulary.
- Anything about an actual import run. If you want that, run it on a staging instance; this document only claims what the source says.

## Why publish it this way

Because the alternative is a comment in someone else's tracker that says "I found a bug" about four things they already filed. The useful contribution is not discovery, it is the map: line numbers, a runnable model, and an explicit list of what the map does not cover.
