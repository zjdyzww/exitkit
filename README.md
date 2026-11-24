# exitkit — turn a platform export into a receipt you can check

Platforms let you export. What they do not tell you is **what you will lose** when you leave. This tool takes the *official* export (a zip or a folder), and writes three things:

1. `canonical/` — your files, kept at their original paths, each one hashed;
2. `manifest.json` — per-file `sha256` + bytes, plus a fingerprint of the whole source archive;
3. `receipt.md` — **what you can take / what you will lose / what the export cannot tell you**.

Anyone can re-check the first two without trusting me:

```bash
node src/exitkit.mjs --from export.zip --out ./out   # or --from ./exported-folder
node src/exitkit.mjs --verify ./out                  # recomputes every hash; exits 1 on any mismatch
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

## 预注册的止损判据（30 天）

被真实使用，需满足**任一**：

1. ≥3 个外部 GitHub 账号提交含**真实账号产物**的 issue（schema 崩、异常时间戳、媒体 404）；
2. ≥1 个无关的开源替代项目合并 PR 或在 onboarding 里链接；
3. ≥1 份公开收据。

**星标、克隆、下载量不计入。** 三项全 0 ⇒ 写复盘，**不做 v2**。

## 状态（如实）

- `--from` 目录 / zip、`canonical/`、`manifest.json`、`losses.json`、`receipt.md`、`--verify`、`--dry-run`、`--self-test`：**已实现且自检通过**。
- **尚未**在真实平台导出包上验证过（等一份真实导出；这是唯一挡住 Phase 1.1 的东西）。在跑过真包之前，本 README 里任何"能还原"的暗示都应视为**未验证**。
- 目标垂直的选择与理由见 `PHASE0-selection.md`。

## 许可

MIT。拿去用、拿去改、拿去批评。
