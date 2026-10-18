# tools/ 登记

> 用途：登记本目录探索脚本与外部集成工具的生命周期，避免把“一次性材料”误认为生产入口，也避免把仍有证据价值的材料直接删除。
> 最后核对：2026-10-18（跨端同步加密排障遗留脚本整体清理）；上次核对 2026-10-03（MiMoCode CLI 卸载后的登记订正）。

## 1. 保留（有契约／生成职责）

| 路径 | 用途 | 运行方式 | 说明 |
|---|---|---|---|
| `pc-agent/` | **长期维护入口**：外部 Agent（终端 CLI 与外部 MCP）调用/测试 PC 功能的工具包。阶段 0–3C 完成、阶段 4/5 部分完成：动作目录与契约门禁、Session Host + CLI、MCP 双入口与等价验证、15 条测试旅程（含 UI/iframe、真实本地向量模型与取消路径） | `node tools/pc-agent/cli.mjs <doctor\|catalog\|session\|invoke\|observe\|assert\|evidence\|suite\|mcp-config\|host>`、`pnpm pc-agent:mcp`、`pnpm pc-agent:verify:dual`、`node tools/pc-agent/verify/matrix.mjs`、`pnpm pc-agent:catalog`、`pnpm check:pc-agent`、`pnpm pc-agent:probe:source\|packaged` | 独立工作区包（`pnpm-workspace.yaml` 成员），依赖自持，不参与产品构建与运行；门禁在 CI 的 Structure gates 作业中作为独立步骤运行；见 [pc-agent/README.md](./pc-agent/README.md)、[能力矩阵](../docs/pc-agent/能力矩阵.md)、[阶段 5 实施报告](../docs/报告/PC端外部Agent工具阶段5实施报告-2026-10-03.md) |
| `gen-sync-crypto-fixtures.ts` | 生成跨端 E2EE 互操作 fixture（固定测试密钥，生产禁用） | `pnpm exec tsx tools/gen-sync-crypto-fixtures.ts` | 输出写入受保护的 `shared/fixtures/cross-platform/sync-crypto/e2ee-interop.json`，由 **shared 独立仓**的 `shared/__tests__/syncCrypto.test.ts` 消费。**PC 仓自 2026-10-14「移除安卓端兼容」第二批起已无 E2EE 消费方**；保留是因为 shared 是独立仓、其跨端契约测试仍以该生成器产物为准。若 shared 侧同步能力退场，本文件可随之删除。 |

## 2. 处置结论（2026-10-18 订正）

- `pc-agent/` 是**长期维护的公共入口**，与“一次性探索材料”处置不同：有契约（动作目录对照 `shared/ipc-api.ts`）、有门禁（`pnpm check:pc-agent`）、有自测（`tools/pc-agent/tests/`，随 `pnpm test` 运行）。清理时不适用“无消费者即删除”的判断。
- **一次性排障脚本已删除（11 个文件）**：`debug-aad.ts`、`debug-b64.ts`、`debug-cross.ts`、`debug-cross2.ts`、`debug-entity.ts`、`debug-gcm.ts`、`debug-gcm2.ts`、`debug-gcm3.ts`、`debug-gcm4.ts`、`debug-gcm-tag.ts` 与数据文件 `gcm-vector.json`，于 2026-10-18 从工作区移除。
  - 理由：它们是 2026-09 跨端同步加密（AES-256-GCM／ECDH／AAD／Base64 差异）排障的一次性材料，只打印诊断信息、无测试与构建消费者；其排障对象（E2EE 同步链路）已随 2026-10-14「移除安卓端兼容」第二批整体从 main 退场，其在 main 上已无任何可复现前提。
  - 处置依据：《项目冗余结构与代码清理方案》（已归档）C03 与《项目冗余清理阶段2工具与产物整理报告》登记的路径是「登记用途 → 验证消费者和可复现性 → 归档或清理」，本次按「清理」执行（前置两项均已核验：用途已登记、消费者为 0）。
  - 回看方式：从 Git 历史取回即可，例如 `git show <删除前提交>:tools/debug-gcm.ts`；跨端契约样本仍在 shared 仓（`fixtures/cross-platform/sync-crypto/`）。
- `tools/mimo-bridge/`（`ARCHITECTURE.md`、`asar.mjs`、`dispatch.mjs`、`inspect-events.mjs`、`state.json`）及其归档副本 `.tmp-archive/mimo-bridge-rebuildable-20261002/`（`extracted/`、`logs/`、`scratch/`）已于 2026-10-03 随 MiMoCode CLI（npm 全局包 `@mimo-ai/cli`）卸载一并删除，原因是该桥接的唯一通道 `mimo` 命令已不存在。桥接勘察结论保留在 `docs/报告/` 与 `docs/方案/归档/` 的历史报告中；如需恢复该通道，先 `npm i -g @mimo-ai/cli`，再按勘察结论重建派发器。**注意**：归档副本 `.tmp-archive/mimo-bridge-rebuildable-20261002/` 未入库且已随同一批清理删除，原文件只能从 Git 历史取回（工作区文件在 `ee4e1f5` 才从版本库移除，可用 `git show ee4e1f5^:tools/mimo-bridge/<文件>`）。
- 本目录不含 `tests/` 下的自动化测试与 `output/` 下的联验证据（各自有独立登记）。
