# tools/ 登记

> 用途：登记本目录探索脚本与外部集成工具的生命周期，避免把“一次性材料”误认为生产入口，也避免把仍有证据价值的材料直接删除。
> 最后核对：2026-10-03（MiMoCode CLI 卸载后的登记订正）；上次核对 2026-10-02（阶段 2 工具整理）。

## 1. 保留（有契约／生成职责）

| 路径 | 用途 | 运行方式 | 说明 |
|---|---|---|---|
| `pc-agent/` | **长期维护入口**：外部 Agent（终端 CLI 与外部 MCP）调用/测试 PC 功能的工具包。阶段 0–3C 完成、阶段 4/5 部分完成：动作目录与契约门禁、Session Host + CLI、MCP 双入口与等价验证、15 条测试旅程（含 UI/iframe、真实本地向量模型与取消路径） | `node tools/pc-agent/cli.mjs <doctor\|catalog\|session\|invoke\|observe\|assert\|evidence\|suite\|mcp-config\|host>`、`pnpm pc-agent:mcp`、`pnpm pc-agent:verify:dual`、`node tools/pc-agent/verify/matrix.mjs`、`pnpm pc-agent:catalog`、`pnpm check:pc-agent`、`pnpm pc-agent:probe:source\|packaged` | 独立工作区包（`pnpm-workspace.yaml` 成员），依赖自持，不参与产品构建与运行；门禁在 CI 的 Structure gates 作业中作为独立步骤运行；见 [pc-agent/README.md](./pc-agent/README.md)、[能力矩阵](../docs/pc-agent/能力矩阵.md)、[阶段 5 实施报告](../docs/报告/PC端外部Agent工具阶段5实施报告-2026-10-03.md) |
| `gen-sync-crypto-fixtures.ts` | 生成跨端 E2EE 互操作 fixture（固定测试密钥，生产禁用） | `pnpm exec tsx tools/gen-sync-crypto-fixtures.ts` | 被 `shared/__tests__/syncCrypto.test.ts`、`android/shared/__tests__/syncCrypto.test.ts` 的契约验证间接依赖；**不得删除** |
| `gcm-vector.json` | 跨端 GCM 测试向量 | 数据文件 | 与 `debug-cross2.ts` 配合的一次性验证材料 |

## 2. 探索脚本（一次性材料，保留但不再维护）

| 路径 | 用途 | 说明 |
|---|---|---|
| `debug-aad.ts` | 打印 E2EE AAD／子密钥／密文标签 | 2026-09 同步加密排障遗留 |
| `debug-b64.ts` | Base64 编解码差异对比 | 同上 |
| `debug-cross.ts`、`debug-cross2.ts` | TS ⇄ Java 跨端解密对照 | 同上；`debug-cross2` 读取 `gcm-vector.json` |
| `debug-entity.ts` | 实体加密往返检查 | 同上 |
| `debug-gcm*.ts`（5 个） | AES-256-GCM 参数与标签行为核对（含 NIST 向量） | 同上 |

这些脚本只打印诊断信息、无测试或构建消费者。如需清理，先确认排障记录已归档到报告；默认保留，不进入删除名单。

## 3. 处置结论（阶段 2/3，2026-10-03 订正）

- `pc-agent/` 是**长期维护的公共入口**，与下方“一次性探索材料”处置不同：有契约（动作目录对照 `shared/ipc-api.ts`）、有门禁（`pnpm check:pc-agent`）、有自测（`tools/pc-agent/tests/`，随 `pnpm test` 运行）。清理时不适用“无消费者即删除”的判断。
- `gen-sync-crypto-fixtures.ts` 属跨端契约生成器，列出保留；输出写入受保护的 `shared/fixtures/cross-platform/sync-crypto/e2ee-interop.json`。
- `debug-*.ts`、`gcm-vector.json` 为一次性探索材料：保留现状，不新增消费者；若后续确认排障记录完整，可整体归档。
- `tools/mimo-bridge/`（`ARCHITECTURE.md`、`asar.mjs`、`dispatch.mjs`、`inspect-events.mjs`、`state.json`）及其归档副本 `.tmp-archive/mimo-bridge-rebuildable-20261002/`（`extracted/`、`logs/`、`scratch/`）已于 2026-10-03 随 MiMoCode CLI（npm 全局包 `@mimo-ai/cli`）卸载一并删除，原因是该桥接的唯一通道 `mimo` 命令已不存在。桥接勘察结论保留在 `docs/报告/` 与 `docs/方案/归档/` 的历史报告中；如需恢复该通道，先 `npm i -g @mimo-ai/cli`，再按勘察结论重建派发器。**注意**：归档副本 `.tmp-archive/mimo-bridge-rebuildable-20261002/` 未入库且已随同一批清理删除，原文件只能从 Git 历史（2026-10-03 前的提交）取回。
- 本目录不含 `tests/` 下的自动化测试与 `output/` 下的联验证据（各自有独立登记）。