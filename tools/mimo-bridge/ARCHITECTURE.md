# DSH ⇄ Xiaomi MiMo 桥接：架构勘察结论

日期：2026-09-24 ｜ 状态：勘察完成，通道选型已定

## 目标

让 DSH（本 Harness 会话）能向本机 Xiaomi MiMo agent 派发编码任务并取回结果。

## 已证实的事实（含证据）

### 1. MiMo 的两个产品形态

| 形态 | 位置 | 说明 |
|------|------|------|
| **MiMo Desktop**（Electron GUI） | `D:\mimo\Xiaomi MiMo\Xiaomi MiMo.exe`（版本 26.923.232338，Electron 41.7.2） | 正在运行，主进程 PID 27580 |
| **MiMoCode CLI**（`mimo`） | npm `@mimo-ai/cli`，bin = `mimo` | 终端原生编码 agent，与 Desktop 同源引擎 |

两者都是 **OpenCode 的 fork**：`@mimo-ai/plugin` / `@mimo-ai/sdk` 的类型签名直接引用 `createOpencodeClient`、`serverUrl`、`sessionID` 等 OpenCode 概念；本机还并存 `~/.local/share/opencode` 与 `ai.opencode.desktop` 数据目录。

### 2. MiMo Desktop 的本地 API（端口 31635）——**不能驱动会话**

- `%APPDATA%\Xiaomi MiMo\desktop-api.json` 写入 `{api:1, port:31635, token:<64位>, pid:27580}`；由主进程 bundle 的 `Nse(e,t,r)` 生成（`out/main/index.mjs` @659479）。
- 该 server 的**路由表**（`Bse` 函数，@660100 附近）只有两项：
  - `/v1/chat/completions`
  - `/p/<provider>/v1/chat/completions`
- 即：它只是**模型推理代理**（让 CLI 复用 Desktop 的凭据，header `X-Mimo-Source: mimocode-cli`），**没有任何会话管理端点**。
- 另注：该 server 只处理 `POST`（源码 `f.method==="POST"?Bse(path):null`），GET 一律 404 —— 这解释了最初带 token 探测 `/`、`/session` 全 404 的现象。

### 3. 会话对话（`talk_to_session`）的真实实现是**进程内 hook**

`out/main/index.mjs` @222335 起：

```js
function DY(e, t = globalThis) { t.__mimoSessionChat = e }   // 注入引擎全局
```

`__mimoSessionChat` 的方法通过 `webContents.executeJavaScript` 在**渲染进程**执行：

```js
const h = window.__mimoSessionChatHook;
h.listDetailed(...) / h.talk({fromSid, role, roleId, message, mode, cwd}) / h.create(...) / h.update(...)
```

主进程侧对象 `BY(e)` 暴露：`list`、`talk`、`create`、`update`、`listSessions`、`readSession`。

官方桌面插件 `app.asar` → `out/main/desktop-tools-plugin.mjs` 注册的工具
（`contacts`、`talk_to_session`、`create_session`、`update_session`、`list_external_sessions`、`read_external_session`、`present_files`、`image_gen`、`tts_speech` 等）**就是读 `globalThis.__mimoSessionChat`**，
若不存在则返回「会话对话接口仅在 MiMo Desktop 应用内可用(当前环境无桥)」。

→ 因此：**只有跑在 Desktop 引擎进程内的插件才能驱动桌面会话**。外部进程无法用 HTTP 做到。

### 4. MiMo 如何把「外部 agent」当联系人调用（可直接复刻的模式）

`out/main/index.mjs` @222335 之后的 external-runner 实现：

```js
QY(e) => ["-p", e.prompt, "--output-format", "json", e.resume ? "--resume" : "--session-id", e.sessionId]
// spawn(bin, args, {cwd, env, stdio:["ignore","pipe","pipe"]})
// 超时 180s；从 stdout 解析 JSON，取 result / session_id / is_error
```

即 MiMo 把 **Claude Code CLI** 当作可调用的队友：`claude -p <prompt> --output-format json`。
外部 agent 目前**硬编码为 Claude Code**（`ext:claude-code`），且只有当二进制存在时才出现在通讯录里（`JY(e)`）——所以 DSH **无法**通过配置把自己注册成 MiMo 的外部 agent。

## 通道选型

| 方案 | 可行性 | 结论 |
|------|--------|------|
| A. 直接用 Desktop HTTP API（31635）派发任务 | ❌ | 只有推理端点，无会话端点 |
| B. MiMo 侧插件 + `__mimoSessionChat` 驱动桌面会话 | ✅ 但需改引擎配置并重启 Desktop | 备选：可驱动**用户可见的桌面会话** |
| C. MiMo 侧插件注册反向工具（MiMo → DSH） | ✅ 同类机制 | 未来可加，实现双向 |
| D. **DSH → MiMoCode CLI（无头 MiMo agent）** | ✅ 无需改动 Desktop、无需重启 | **首选**，与 MiMo 调用 Claude Code 的模式对称 |
| E. CDP 驱动 Desktop UI | ⚠️ | 需 `--remote-debugging-port` 重启，脆弱，不采 |

**选定 D**：`npm i -g @mimo-ai/cli` 得到 `mimo`，DSH 以非交互方式派发任务包并解析 JSON 回执。
若之后需要操作**桌面里的具体会话**，再上方案 B。

## 安全提示

- `~/.config/mimocode/mimocode.jsonc` 中以**明文**保存 Xiaomi API key（`provider.xiaomi.options.apiKey`）。
- `%APPDATA%\Xiaomi MiMo\desktop-api.json` 以 0600 权限保存 desktop-api token。二者均属敏感，勿提交到版本库或粘贴到外部。

## 落地结果（已验证 2026-09-24）

1. 安装 `@mimo-ai/cli`（`npm i -g`，bin `mimo`，v0.1.15）。npm 拦截了它的 postinstall，但 CLI 仍可正常运行。
2. **必须显式指定模型**：默认的 `mimo/mimo-auto` 免费通道已结束，会报
   `MiMo free API service has ended. Sign in or configure a third-party API.`
   （`~/.local/share/mimocode/auth.json` 为 `{}`，未登录；Desktop 自己持有账号态）。
   改用 `-m xiaomi/mimo-v2.6-pro` 即正常 —— 凭据来自 `~/.config/mimocode/mimocode.jsonc`。
3. 派发器 `dispatch.mjs`：组装任务包 → `mimo run --format json`（cwd = workspace）→ 解析事件流 → 输出回执。
   - 事件流形如 `step_start` / `text{part.text}` / `step_finish`，并携带 `ses_*`。
   - 用 node 直跑 CLI launcher（`bin/mimo`）传 argv 数组，避免 Windows shell 破坏任务包换行与引号。
   - 实测**无需** `--yolo` 即可读写文件。
4. **端到端验证**：任务 `ATB-20260924-001`（在工作区创建 `hello.txt`）→ 41.9s、8 次工具调用、退出码 0；
   DSH 独立复核字节 `48 45 4C 4C 4F 5F 46 52 4F 4D 5F 4D 49 4D 4F 0A` = `HELLO_FROM_MIMO\n`，
   与 MiMo 回执所述（含末尾换行）逐字节一致。
5. **会话可续接**：在 `ses_ffe5f2d32d702ffeo2Zx2nmFfS` 中追问前文，正确答出 `BRIDGE_OK`。
6. **会话存储与 Desktop 共用**（`~/.local/share/mimocode/mimocode.db`）：`mimo session list` 能看到
   Desktop 里的真实工作会话。→ 理论上 `--session <桌面会话 id>` 或可续接桌面会话，但**未测试**
   （不该拿用户真实工作会话做试验）。
7. DSH 技能 `mimo-dispatch` 已注册（`~/.dsh/skills/mimo-dispatch/SKILL.md`）。
8. 副作用：CLI 会在目标工作区创建 `.mimocode/`（内含自带的 `.gitignore` 与 `.cron-lock`）。

### 仍未做

- **驱动桌面会话**（方案 B）：需 MiMo 侧插件复用 `globalThis.__mimoSessionChat` + 重启 Desktop。
- **MiMo → DSH 反向**（方案 C）：MiMo 的「外部 agent」目前硬编码为 Claude Code，需插件注册工具才能反向呼叫 DSH。

## 本地文件

- `asar.mjs` — 极简 Electron asar 读取器（list / extract）。asar 头布局：`[u32 4][u32 headerSize][u32 payloadSize][u32 jsonLen][json @16]`，数据区起点 `8 + headerSize`。
- `extracted/` — 从 `app.asar` 提取的 `out/main/index.mjs`、`desktop-tools-plugin.mjs`、`engine-entry.mjs`（仅供勘察，勿改）。
