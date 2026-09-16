# 阶段 1 契约 fixtures

| 目录 | 说明 |
|---|---|
| `canonical/` | TS/Kotlin 字节级一致 golden |
| `valid/` | 通过 schema 的最小/完整样例 |
| `invalid/` | 应被拒绝的样例 |

生成与校验：`node scripts/check-contracts.mjs`、`pnpm test shared/contracts`。
