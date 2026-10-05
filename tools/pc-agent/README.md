# tools/pc-agent/ — 外部 Agent 调用/测试工具包

> 面向对象：仓库**外部**的 Agent（Codex 等）通过终端命令或外部 MCP 工具调用、测试轻语 PC 现有功能。
> 方案依据：[PC 端外部 Agent 功能测试与调用工具建设方案 v2](../../docs/方案/PC端外部Agent功能测试与调用工具建设方案-2026-10-03.md)。
> 当前状态：**阶段 3A/3B/3C 完成，阶段 4/5 部分完成** — 契约面登记清零、15 条旅程可跑；真实本地向量模型（推理/异步索引/取消）已验证；LLM 生成与原生对话框后端受环境/技术限制未打通。
> 阶段报告：[0](../../docs/报告/PC端外部Agent工具阶段0实施报告-2026-10-03.md) · [1](../../docs/报告/PC端外部Agent工具阶段1实施报告-2026-10-03.md) · [2](../../docs/报告/PC端外部Agent工具阶段2实施报告-2026-10-03.md) · [3A](../../docs/报告/PC端外部Agent工具阶段3A实施报告-2026-10-03.md) · [3B](../../docs/报告/PC端外部Agent工具阶段3B实施报告-2026-10-03.md) · [3C](../../docs/报告/PC端外部Agent工具阶段3C实施报告-2026-10-03.md) · [4](../../docs/报告/PC端外部Agent工具阶段4实施报告-2026-10-03.md)。

## 1. 这个包是什么

外部 Agent 自己不做 UI 自动化，也不阅读产品源码来猜调用顺序。本包提供：

- **动作目录**（`catalog/*.json`）：每个可调用动作的 `id`、API 路径、参数、层级、断言建议等。Agent 先读目录再执行。
- **能力矩阵**（[`docs/pc-agent/能力矩阵.md`](../../docs/pc-agent/能力矩阵.md)）：目录的渲染产物，用于回答“某个模块现在到底能不能被外部调用”。
- **契约漂移门禁**（[`scripts/check-pc-agent.mjs`](../../scripts/check-pc-agent.mjs)）：产品改了 `shared/ipc-api.ts` 而目录没跟上时直接失败。

本包**不参与产品构建与运行**：不进 `electron/`、`src/`、`shared/`，不加产品运行依赖，不改产品行为。

## 2. 当前可用命令

### 2.1 CLI（阶段 1，可用）

```powershell
# 环境与构建身份检查（构建陈旧时退出码 3）
node tools/pc-agent/cli.mjs doctor [--json]

# 动作目录：已登记为可执行的动作
node tools/pc-agent/cli.mjs catalog [--module chat] [--json]

# 会话：启动 / 查看 / 重启 / 关闭（写动作必须显式授权模块）
node tools/pc-agent/cli.mjs session start --profile source-isolated --allow-write character --allow-write chat [--json]
node tools/pc-agent/cli.mjs session list
node tools/pc-agent/cli.mjs session get --session <id> --json
node tools/pc-agent/cli.mjs session restart --session <id>
node tools/pc-agent/cli.mjs session close --session <id>

# 动作调用与断言
node tools/pc-agent/cli.mjs invoke  --session <id> --action chat.renameSession --args-file <绝对路径 JSON> --json
node tools/pc-agent/cli.mjs observe --session <id> --action chat.listSessions --args-file <路径> --json
node tools/pc-agent/cli.mjs assert  --session <id> --spec-file <绝对路径 JSON> --json
node tools/pc-agent/cli.mjs evidence --session <id> --json

# 测试旅程（阶段 1 已交付 chat.basic 单聊纵切闭环）
node tools/pc-agent/cli.mjs suite run --session <id> --suite chat.basic --json

# 宿主管理
node tools/pc-agent/cli.mjs host list
node tools/pc-agent/cli.mjs host stop
```

退出码（方案 §5.4）：`0` 成功 · `1` 动作/断言失败 · `2` 参数或协议错误（含未知动作） · `3` 环境阻塞/未授权/构建陈旧 · `4` 需要用户交互。

### 2.2 MCP 入口（阶段 2，可用）

外部 Agent 通过 MCP 注册本 server（**不配置到轻语自己的 MCP 页面**）：

```powershell
node tools/pc-agent/cli.mjs mcp-config                 # 通用 .mcp.json 片段
node tools/pc-agent/cli.mjs mcp-config --client codex  # ~/.codex/config.toml 片段
node tools/pc-agent/cli.mjs mcp-config --client claude # claude_desktop_config.json 片段
```

生成的配置形如：

```json
{ "mcpServers": { "qingyu-pc-agent": { "command": "node", "args": ["<仓库绝对路径>/tools/pc-agent/mcp-server.mjs"] } } }
```

工具清单（少量入口 + 可发现目录，不把 254 个底层方法塞给 Agent）：

| 工具 | 用途 |
|---|---|
| `qingyu_doctor` | 平台、构建产物、构建陈旧、活跃宿主与会话 |
| `qingyu_capabilities` | 已登记为可执行的动作及其参数/层级/读写分类 |
| `qingyu_session` | `start` / `list` / `get` / `restart` / `close` |
| `qingyu_call` | 调用已登记动作（写动作需会话授权对应模块） |
| `qingyu_observe` | 只读读取状态 |
| `qingyu_operation` | 按 `operationId` 查询动作记录（阶段 2 只覆盖同步 IPC 动作） |
| `qingyu_assert` | 有限断言，返回 expected/actual |
| `qingyu_run_suite` | 运行测试旅程（当前 `chat.basic`） |
| `qingyu_evidence` | run 目录、动作与断言记录 |

**与 CLI 的关系**：MCP server 不实现第二套执行逻辑——它与 CLI 共用 `client.mjs`、同一个 Session Host 与同一份动作目录；日志走 stderr，stdout 只输出 MCP 协议消息。

### 2.3 双入口等价验证（阶段 2 退出条件）

```powershell
pnpm pc-agent:verify:dual
```

真实拉起 CLI 与 MCP 两个进程，对同一动作逐项比较 `status/action/layer/invoked/verified/result`（忽略 `operationId`/`sessionId`/耗时），并审计 MCP stdout 纯净性与令牌泄漏。结果写入 `output/pc-agent/dual-entry-<时间戳>/`。

### 2.4 目录维护与门禁

```powershell
pnpm pc-agent:catalog                              # 契约变更后刷新目录与能力矩阵
pnpm check:pc-agent                                # 门禁：目录 ↔ 契约漂移
node scripts/check-pc-agent.mjs --require-covered  # 阶段 5 收紧模式
node scripts/check-pc-agent.mjs --json             # 机器可读
node tools/pc-agent/catalog.generate.mjs --dry-run # 只报告不写盘
node tools/pc-agent/catalog.generate.mjs --prune   # 删除契约中已消失的登记
```

### 2.5 双入口全量矩阵回归（阶段 5 收尾）

```powershell
node tools/pc-agent/verify/matrix.mjs      # 全部旅程各跑 CLI 与 MCP 两遍，逐条对照
```

分别在 CLI 与 MCP 两个真实入口各起一个隔离会话，把全部旅程各跑一遍，输出逐旅程对照表（`output/pc-agent/matrix-<时间戳>/report.md`），用于回答“同一套旅程在两个入口是否都能跑通且结论一致”。

### 2.6 测试旅程一览

```powershell
node tools/pc-agent/cli.mjs suite run --session <id> --suite <id>
```

| suite | 覆盖 |
|---|---|
| `chat.basic` | 单聊纵切闭环（阶段 1 退出条件） |
| `chat.lifecycle` | 单聊完整旅程（含 UI 标题核对、失败路径、重启） |
| `character.lifecycle` | 角色 CRUD/绑定/失败路径/重启 |
| `settings.lifecycle` | 设置读写、凭据脱敏、本地 token 与诊断 |
| `group.lifecycle` | 群聊/会话/消息归属/记忆/导出 + UI 核对 |
| `lorebook.lifecycle` | 世界书 CRUD、revision CAS、映射模板 |
| `preset.lifecycle` | 预设（内置副本语义）与人设 CRUD |
| `usage.lifecycle` | 用量记录/过滤/聚合/汇总/清空/持久化 |
| `log.lifecycle` | 日志写入/读回/持久化 |
| `system.lifecycle` | 本地状态读取 + 无环境时准确阻塞（`needs_interaction` / `blocked`） |
| `regex.lifecycle` | 正则规则 CRUD、启停与作用域、重启 |
| `quickreply.lifecycle` | 快捷回复整体读写、按角色隔离、清空、重启 |
| `spatial.lifecycle` | 画板世界绑定、编辑批次 CAS/幂等、上下文归属、**iframe 加载与重启重建** |
| `embedding.lifecycle` | **真实本地向量模型**：推理、异步索引、语义检索与**取消索引** |
| `env.probe` | 外部依赖能力探测（LLM/生图/MCP/桥接/同步对端/外网），输出“能做什么、缺什么” |

无环境时的返回约定（方案 §6.3）：`requires` 含 `native-dialog` → `needs_interaction`（CLI 退出码 **4**）；模型/网络等 → `blocked`（退出码 **3**）并给出环境原因。二者都不实际调用产品接口。

### 2.7 阶段 0 探针（需真实启动 Electron，不进 CI）

```powershell
pnpm pc-agent:probe:source      # 源码模式：两种隔离方式驱动现有应用
pnpm pc-agent:probe:packaged    # 打包/安装版：--user-data-dir + CDP 连接
```

工具自测随 `pnpm test` 运行（`tools/pc-agent/tests/`，71 条用例，含 MCP stdio 握手，不启动 Electron、不调用模型）。

## 3. 目录与状态口径

| 文件 | 作用 |
|---|---|
| `catalog/<模块>.json` | 一个 `window.api` 命名空间一个文件，含该模块全部契约成员的登记 |
| `catalog/_tools.json` | **工具来源动作**（`origin: tool`）：不对应 `window.api`，由适配器执行，当前为 UI 层操作 |
| `catalog.exclusions.json` | **豁免清单**：明确不属于动作面的成员（事件订阅、凭据接口）及其原因 |
| `docs/pc-agent/能力矩阵.md` | 由目录渲染，**请勿手改**；门禁会校验它与目录一致 |

动作状态：

- `unregistered`：骨架已生成，尚未处理（阶段 3 按批次补全）。
- `pending`：已确认登记，但需要模型 / 网络 / 原生对话框等环境才能验证，**必须写 `pendingReason`**。
- `mapped`：已完整登记并验证过，必须填 `description` 与 `layer`（`mock` / `service` / `ipc` / `ui`）。

动作字段：

| 字段 | 含义 |
|---|---|
| `origin` | `contract`（映射 `window.api`）或 `tool`（工具自定义，需 `adapter`） |
| `layer` | 执行层级：`ipc` 走正式 preload；`ui` 操作真实界面控件。两者结论不可互相替代 |
| `write` | 写动作，需要会话 `--allow-write <模块>` 授权 |
| `requires` | 环境要求：`model` / `network` / `native-dialog` |
| `redactKeys` | 返回前从结果中剔除的敏感键（如 `settings.get` 的 `apiKey`），剔除记录写入证据 |

**豁免不是默认值**：新增豁免必须写清原因；门禁会拒绝没有原因、或指向已不存在成员的豁免。

## 4. 契约变更时怎么做

1. 产品改动 `shared/ipc-api.ts` 后，运行 `pnpm pc-agent:catalog`。
2. 生成器保留所有人工登记字段，只补新增成员的骨架；发现“契约中已消失的登记”时**默认报错退出**，确认后加 `--prune` 删除。
3. 运行 `pnpm check:pc-agent` 确认绿。签名漂移、成员遗漏、矩阵陈旧都会在这里暴露。
4. 若某成员确实不作为动作暴露，在 `catalog.exclusions.json` 中登记原因，而不是删除目录条目。

## 5. 依赖归属（为什么自持）

- 本包是 `pnpm-workspace.yaml` 成员，依赖写在自身 `package.json`，**不进根 `dependencies`/`devDependencies`**。
- 现状依赖：`typescript`（解析契约 AST）、`playwright-core@^1.63.0`（驱动 Electron 与 CDP）、`@modelcontextprotocol/sdk@^1.31.0`（阶段 2 MCP 入口，用底层 `Server` API + 纯 JSON Schema，不引 zod）。
- 选 `playwright-core` 而不是 `playwright`：只驱动仓库内的 Electron 与 CDP，不需要下载浏览器二进制。
- 加入依赖时按仓库既有 `allowBuilds` 机制显式登记构建脚本，**不隐式依赖** `spatial-board` 的 Playwright 安装（阶段 0 探针的临时复用已随阶段 1 结束）。

## 6. 阶段边界（尚未实现的部分）

按方案 v2 §9，本包后续交付：

| 阶段 | 内容 | 当前 |
|---|---|---|
| 0 | 动作目录骨架、门禁、依赖定案、启动可行性实测 | ✅ 完成 |
| 1 | Session Host、隔离启动、CLI（doctor/session/invoke/observe/assert/evidence/suite）、构建陈旧检测、单写者队列 | ✅ 完成（`chat.basic` 纵切闭环通过） |
| 2 | `mcp-server.mjs`（`qingyu_*` 工具），与 CLI 结果等价 | ✅ 完成（9 个工具；双入口 23 项检查通过） |
| 3A：高频核心 | 单聊、角色、设置/模型 | ✅ 完成（三条旅程，含 UI 层标题核对） |
| 3B：内容与上下文 | 群聊、世界书、预设/人设 | ✅ 完成（三条旅程 + 事件型异步等待） |
| 3C：交互与画板 | 正则/快捷回复、消息辅助/记忆、空间画板 | ✅ 完成（三条旅程 + iframe 加载/重建 + CAS/幂等） |
| 3D / 阶段 4 | 图片/TTS、用量/公告/日志、字体/备份/更新、同步/设备/MCP | 🟡 部分完成（登记 + 准确阻塞 + 三条旅程；原生交互后端与专项 suite 包装未做） |
| 5 | 全量验证与文档 | 🟡 部分完成（真实模型/取消 ✅、环境探测 ✅；矩阵全量回归与安装版边界未做） |

**阶段 3A 已实现**：结果脱敏（`lib/redaction.mjs`）、UI 层适配器（`lib/ui-adapter.mjs`，声明式步骤 + 定位失败候选提示）、渲染层错误采集（`logs/renderer.log`）、`pending` 状态与工具来源动作（catalog 扩展）、三条旅程（`suites/{chat,character,settings}-lifecycle.mjs`）。
**尚未实现**：事件型异步等待（生成/翻译/索引类仍为 `pending`）、原生对话框后端、群聊/世界书/预设等模块。

## 6.1 使用示例（单聊纵切闭环）

```powershell
$start = node tools/pc-agent/cli.mjs session start --profile source-isolated `
  --allow-write character --allow-write chat --json | ConvertFrom-Json
$sid = $start.session.sessionId

node tools/pc-agent/cli.mjs suite run --session $sid --suite chat.basic
#  → 新建测试角色 → 新建会话 → 改名 → IPC 读回 → 重启 → 重启后读回 → 证据

node tools/pc-agent/cli.mjs session close --session $sid
```

产物在 `$start.runDir`：`session.json`（公开信息，含构建身份与允许写模块）、`actions.jsonl`（每条动作的状态/目标/耗时）、`assertions.jsonl`（expected/actual）、`suite-result.json`、`report.md`、`screenshots/`、`runtime/`（`token`、`user-data` 隔离档案）。

## 6.2 会话与令牌模型

- **宿主**：`host.mjs` 常驻进程持有 Playwright/Electron 句柄，CLI 退出后会话仍存活；零会话且空闲 60s 后自行退出，并删除自己的令牌文件。
- **令牌**：宿主令牌 `output/pc-agent/hosts/<hostId>.token` 用于宿主级请求；会话令牌 `<runDir>/runtime/token` 用于该会话的请求。两者均为 0600，不进公开 manifest、不入 Git（`output/` 已 gitignore）。已死宿主的令牌文件在下次 `ensureHost` 时清理。
- **注册表**：`output/pc-agent/registry.json` 记录活跃宿主与会话；宿主 pid 已死的条目在读取时被剔除（陈旧资源不静默复用）。
- **单写者**：同一会话内的动作与生命周期操作（含 `restart`）走同一队列串行执行，避免重启与调用交叉。
- **授权**：写动作按 `--allow-write <模块>` 在宿主侧强制，未授权返回 `blocked`（退出码 3），不依赖调用方自觉。

## 6.3 实测得到的硬约束

1. **清除 `ELECTRON_RUN_AS_NODE`**：本机（DSH 宿主跑在 Electron 上）该变量为 `1`；不清除时 `electron.exe` 退化为纯 Node，Playwright 报 `Process failed to launch!`。探针的 `electronEnv()` 负责清理，`scripts/lib/electronHarness.mjs` 亦然。
2. **源码模式不含发布产物**：`electron/main.ts` 以 `isDev = !app.isPackaged` 分流，源码启动必然加载 `http://localhost:5173`。验证发布产物须走 `packaged-isolated`（打包/安装版 + `--user-data-dir` + CDP）。
3. **构建身份不能取 `app.getVersion()`**：注入 launcher 时它返回 Electron 版本、`getAppPath()` 落在 run 目录；`doctor` 从产物采集（git commit、dist / dist-electron mtime 与源码 mtime 对比）。
4. **窗口识别**：dev 模式额外有 `devtools://` 窗口（无 `window.api`）；按 URL + `window.api` 可用性判定，不依赖窗口顺序。
5. **契约陈旧要单独检**：实测 `release-v2` 打包产物缺少 `spatial` 命名空间，若只启动不比对，会把旧版本行为当成当前版本结果。
6. **“空档案”不等于全空**：新隔离档案自带种子角色「艾莉娅」与 10 个内置预设（`data/presets` 为 0 文件），断言基线不能假设全空。

## 7. 安全与数据边界

已实现（阶段 1）：

- 默认只启动隔离实例；会话启动前校验 `userData` 必须位于本次 run 目录之下，否则拒绝启动（`UNSAFE_USER_DATA`）。
- 写动作按 `--allow-write <模块>` 在**执行器**校验，未授权返回 `blocked`；不靠调用方自觉。
- **凭据写入默认关闭**：`settings.saveAPICredential` 只有在会话显式声明 `--allow-credential-write` 时才放行（`requires: ['credential-write']`），否则返回 `blocked / CREDENTIAL_WRITE_NOT_ALLOWED`；密钥作为参数传入并在证据中脱敏。仅用于**已授权**的真实模型验证（见 §8.4）。
- **读凭据接口始终豁免**：`settings.getAPICredential` 不登记、不可调用，外部 Agent 无法读出密钥明文。
- 打包模式先确认隔离目录已被写入（安全闸门），未生效立即终止，避免触碰正式数据。
- `runtime/` 下的令牌为 0600，不入公开 manifest、不入 Git（`output/` 已被 gitignore）。
- 动作参数落盘前按 key/token/secret/password/credential 脱敏。
- 首版 **Windows-only**（命名管道、Electron 可执行文件），其他平台返回 `UNSUPPORTED_PLATFORM`。

待实现（阶段 3–4）：

- 截图、日志、导出文件的统一脱敏流水线（当前只保存截图，未做内容脱敏）。
- 原生对话框：**已改为产品侧「显式路径」参数**——导出/导入类动作传 `targetPath`/`sourcePath` 时不弹对话框，工具据此真实执行；不传路径仍返回 `needs_interaction`。`file.selectImage`/`font.select` 故意保留对话框（白名单闸门，防任意文件读取）。详见 [阶段 5 报告](../../docs/报告/PC端外部Agent工具阶段5实施报告-2026-10-03.md) §12。
- 接管用户**已打开**的正式实例：需用户显式授权，且只按授权范围读写。

## 8. 安装与接入

### 8.1 安装

本包是 pnpm 工作区成员，**根目录安装即包含**，不需要单独装：

```powershell
pnpm install          # 安装根依赖 + 本包依赖（typescript / playwright-core / @modelcontextprotocol/sdk）
pnpm check:pc-agent   # 自检：目录 ↔ 契约门禁
node tools/pc-agent/cli.mjs doctor   # 环境自检：平台、构建产物、构建陈旧、活跃宿主
```

说明：

- 依赖自持（见 §5），**不写进根 `dependencies`**；只驱动仓库内的 Electron 与 CDP，**不需要下载浏览器二进制**。
- 平台要求 **Windows**（命名管道 + Electron 可执行文件）；其他平台返回 `UNSUPPORTED_PLATFORM`。
- 源码模式需要能起 `http://localhost:5173`（工具会自己拉起 Vite，已有则复用）；发布产物验证走 `packaged-isolated`（需 `release-v2/win-unpacked` 打包产物）。

### 8.2 外部 Agent 接入（MCP）

```powershell
node tools/pc-agent/cli.mjs mcp-config --client codex    # ~/.codex/config.toml 片段
node tools/pc-agent/cli.mjs mcp-config --client claude   # claude_desktop_config.json 片段
node tools/pc-agent/cli.mjs mcp-config                   # 通用 .mcp.json 片段
```

把输出片段加入**外部 Agent 的**配置即可；**不需要在轻语产品里启用任何功能**。接入后先用 `qingyu_doctor` 自检，再用 `qingyu_capabilities` 查看当前可执行动作。

### 8.3 真实模型 / 真实生图验证（需用户授权与本地环境）

```powershell
# 1) 取出本机活跃连接档案的密钥（写到 gitignore 的 output/ 下，不打印明文）
$env:ELECTRON_RUN_AS_NODE=$null
node_modules/electron/dist/electron.exe scripts/decrypt-api-key.cjs <profileId|active> output\pc-agent\secrets\key.txt

# 2) 一条命令完成：起隔离会话 → 写入连接档案与生图模型 → 经产品 IPC 写凭据 → 跑 llm.lifecycle 与 comfyui.lifecycle
node tools/pc-agent/verify/real-model-run.mjs `
  --key-file output\pc-agent\secrets\key.txt `
  --profile-name 小米 --model mimo-v2.6-pro --llm-base-url https://api.xiaomimimo.com/v1 `
  --image-base-url http://127.0.0.1:8188 --image-model image_z_image_turbo
```

要点（都是实测踩出来的）：

- **工具本身不持有密钥**：凭据经产品自己的 `settings.saveAPICredential` IPC 写入**隔离档案**；该动作默认关闭，需 `--allow-credential-write`（见 §7）。
- **跨进程注入不可行**：Electron safeStorage 的密钥绑定在启动进程的 `userData` 上，外部进程写入的密文产品侧解不开（实测 `Error while decrypting the ciphertext`），因此必须走产品 IPC。
- **生图模型必须带 `workflow` 且 `enabled: true`**：脚本从正式档案复制一份去掉 `apiKey` 的模板到隔离档案；否则报“未配置启用的生图模型”或“未配置工作流”。
- **写入设置与凭据后需重启应用**：让主进程从磁盘重新读取，避免使用启动时的旧快照（实测不重启会 401）。
- 密钥文件位于 `output/pc-agent/secrets/`（`.gitignore` 已覆盖）；不再需要时直接删除该目录。

### 8.4 停用与卸载

1. 从外部 Agent 配置里移除 `qingyu-pc-agent` 条目；
2. `node tools/pc-agent/cli.mjs host stop`（或等宿主空闲 60s 自行退出）；
3. 删除 `output/pc-agent/`（证据与隔离档案）与 `tools/pc-agent/node_modules`（如需彻底清理）。

轻语产品不依赖本工具，停用后无需改动产品。

## 9. 证据与支持范围

### 9.1 证据目录（`output/pc-agent/<run-id>/`，已 gitignore）

| 文件 | 内容 |
|---|---|
| `session.json` | 公开会话信息：实例、profile、构建身份、允许写模块、窗口识别结果 |
| `actions.jsonl` | 每条动作：状态、层级、实际目标、耗时、脱敏记录、UI 步骤、异步任务终态 |
| `assertions.jsonl` | 每条断言：expected / actual / 结论 |
| `suite-result-<suite>.json` | 各旅程的结构化结果（含跳过项与原因） |
| `report.md` | 人类可读汇总（追加写入） |
| `screenshots/` `exports/` `logs/` | 截图、导出产物、宿主与渲染层日志（`renderer.log` 含 `pageerror`） |
| `runtime/` | 私有：令牌（0600）、隔离 `userData`、launcher |

### 9.2 支持范围

| 维度 | 支持 |
|---|---|
| 平台 | Windows（首版） |
| profile | `source-isolated`（源码 + Vite + 隔离 userData）、`packaged-isolated`（打包产物 + `--user-data-dir` + CDP） |
| 层级 | `ipc`（正式 preload 调用）、`ui`（真实界面控件，含 iframe） |
| 动作 | 254 个契约成员全部有归属：`mapped` 已登记并验证、`pending` 已登记并写明所需环境、`exempt` 显式豁免 |
| 无环境时 | `needs_interaction`（退出码 4）或 `blocked`（退出码 3），均带原因且不实际调用产品接口 |

### 9.3 已知限制

- **LLM 生成/事件/取消**未验证：本机无可用 LLM（无 Ollama/ComfyUI，隔离档案无外部 provider 凭据）。`awaitTask` 与取消动作已就绪，接上 provider 即可跑。
- **原生对话框**不代为完成（后端实测不可靠），返回 `needs_interaction`。
- **单写者队列**意味着 `observe` 也会排在被执行的写动作之后；观察长任务进度要用控制类动作或固定延迟（见 `embedding.lifecycle` 的取消步骤注释）。
- **真实生图（ComfyUI）与真实 LLM（小米 MiMo）已验证通过**（见 §8.3）；**真实 TTS 已验证**（edge provider 返回真实 mp3）。
- **小米 MiMo TTS 产品当前不兼容**：产品 openai 兼容路径走 `/audio/speech`，小米走 `/chat/completions` + `audio` 字段（实测 404）。要在轻语里用小米 TTS 需产品侧增加适配器，接口对照见 [阶段 5 报告](../../docs/报告/PC端外部Agent工具阶段5实施报告-2026-10-03.md) §10.2。
- 同步对端设备需要对应环境，当前准确阻塞并登记原因。
- **产品内 MCP 外部服务**：已用真实 uTools MCP 网关实测——服务侧可用（initialize/tools/list/tools/call 全通，需 x-mcp-key），但**产品当前连不上**：	ransport 只有 stdio/sse、sse 未实现（实测报错）、且无 headers 字段。详见 [阶段 5 报告](../../docs/报告/PC端外部Agent工具阶段5实施报告-2026-10-03.md) §13。
- **免对话框导出/导入**：15 个动作已支持显式路径（见 §6 与 [阶段 5 报告](../../docs/报告/PC端外部Agent工具阶段5实施报告-2026-10-03.md) §12）；io.lifecycle 覆盖真实往返。










