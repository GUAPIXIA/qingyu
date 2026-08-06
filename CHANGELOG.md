# 更新日志

## [0.11.17] - 2026-08-06

### 打包体积优化 + IPC 死代码清理 + 群聊轮询减负

**打包**

- 生产构建不再产出 sourcemap（此前 'hidden' 生成 5MB+ .map 文件）；dist 从约 7MB 降至 1.25MB
- `react-dev-locator` 仅开发模式注入（生产移除源码位置信息）
- 14 个非首屏页面路由懒加载（React.lazy + Suspense），主包从约 2MB 单 bundle 拆为 865KB + 14 个按需 chunk

**IPC 契约**

- 移除无人消费的 `ai:toolCall` / `ai:toolResult` 事件广播（契约漂移清理；工具调用保留日志，UI 展示功能接线时恢复）

**性能**

- 群聊轮询不再每 2s 全量持久化群组文件（`currentSpeakerIndex` 改为纯运行时状态，群组文件仅在创建/编辑时保存）

---

## [0.11.16] - 2026-08-06

### 凭据加密存储 + 渲染/IO 性能优化 + CI 覆盖率门禁

**安全**

- **API Key 不再明文落盘 settings.json**（H1）：保存时提取到 safeStorage 加密凭据库（profile/TTS/生图/识图四组模型），settings.json 只存非敏感字段；读取时回填；备份导出/导入均剥离（旧明文备份导入时自动迁移进 safeStorage）；新增 4 项单元测试
- **服务端弱密码防护**（H2）：db.js 管理员创建时拒绝 14 种常见弱密码（含默认 changeme123 与示例占位符），命中即拒绝启动；server/.env 示例密码改为占位符强制配置强密码

**性能**

- **流式渲染热路径**（P1）：ChatPage 拆分为 10 个选择性订阅（此前全量订阅整 store，50ms flush 每秒 20 次整树协调）；字符统计按消息 id 增量缓存（流式时只重算正在生成的消息）；StatusBar 状态解析改 useMemo
- **listSessions 元数据缓存**（P2）：消息文件 mtime+size 未变时复用统计结果，不再每次全量字节扫描（上限 1000 条自动淘汰）
- **修复 lastMessage 提取 bug**：消息文件以 `\n` 结尾时取到空行导致会话列表最后消息恒为空——改为取倒数第二行

**工程化**

- **CI 覆盖率门禁生效**（E1）：test job 改用 `pnpm test:coverage`（vitest.config.ts 的 thresholds 此前从未在 CI 执行）
- **ipc/chat.ts 核心逻辑补测**（E3）：computeMessageMetaCached 新增 6 项测试（统计/缓存命中/变更失效/删除/会话隔离），全量 852 测试通过

---

## [0.11.15] - 2026-08-06

### 安全与健壮性修复 26 项（项目审查报告全部问题修复）+ 公告列表瘦身

**安全（高危）**

- **IPv4-mapped IPv6 SSRF 绕过**（`pathGuard.ts`）：`::ffff:127.0.0.1` 等映射地址此前不匹配任何黑名单规则，可直达本机/内网/云元数据——提取最后 32 位转 IPv4 后按 IPv4 规则递归校验
- **MCP 任意命令执行桥**（`mcp/manager.ts`）：`mcp:addServer/updateServer` 曾接受任意 `command/args/env` 直接 spawn——新增解释器黑名单（cmd/powershell/bash/node/python 等）、内联执行参数拒绝（`-c`/`/c`/`-e` 等）、含路径必须绝对、危险环境变量（`NODE_OPTIONS`/`LD_PRELOAD` 等）与长度限制
- **公告下载重定向 SSRF + 无大小限制**（`announcement.ts`）：`httpGet` 入口与每次重定向重新 `isSafeUrl` 校验，限制重定向 5 次、响应体 5MB
- **会话删除竞态**（`chat.ts`/`group.ts` 4 处）：单会话删除/清空先取消息文件锁再删（锁序与写入路径一致，消除"删除后文件被重建"竞态）

**安全（中低危）**

- `font:save` 复用 `validatedPaths` 对话框 token（仅接受 `font:select` 登记的路径，防任意文件读取）
- 公告/版本写入口校验：PUT 公告复用长度限制（title≤200/content≤100000）、PUT version 的 changelog≤50000 与 downloadUrl 必须 http/https、PUT null 视为未提供（`COALESCE` 保留原值）
- 登录参数长度限制（username≤64/password≤128）+ JWT 绑定 `issuer/audience`
- `TRUST_PROXY` 环境变量（反代部署时登录限流正确取客户端 IP，默认关闭保持直连行为）
- 公开公告列表不再返回 content 全文（详情按需获取，客户端离线降级提示）
- 分页 page 上限 100000（防 SQLite int64 溢出）、错误中间件按 `err.status` 分级（坏 JSON 返回 400）

**健壮性**

- AI/生图请求超时：toolLoop AI 请求 120s（超时 abort 内部请求）、SD/OpenAI 生图 120s、单聊翻译 30s 空闲超时（超时 cancelChat）
- 竞态修复：向量缓存写路径走 LRU、usage 并发写加锁、MCP startServer 并发去重、封面下载竞速胜出后 abort 输家、`firstMessage` 分支不覆盖用户已发消息、流式失败也执行 pendingCompression、`lorebook:delete` 清理向量索引、deleteCurrentSession 会话存在性校验
- 输入限制：readImageBase64 20MB、importBackup 100MB、Markdown 导出统一转义（含 `![` 图片注入防护）、readJsonAsync 损坏日志
- 修复均附单元测试（pathGuard +1 / manager +10 / announcement +6 / markdown +4，全量 842 通过）

---

## [0.11.14] - 2026-08-05

### 依赖安全修复（漏洞 63 → 29，critical 清零）+ CI 审计门禁 + 路线图校准

**依赖安全**

- **全量依赖审计**（首次，官方 npm registry）：发现 **63 个漏洞（25 high / 3 critical）**，集中在三条链：vitest 2.1.0、electron-builder 24、electron 31
- **升级 vitest 2.1 → 3.2.7**（含 @vitest/coverage-v8）：修复测试框架漏洞链（-20 漏洞）；全量 821 测试在 vitest 3 下全部通过
- **升级 electron 31 → 32.0**：修复 Electron 运行时漏洞（-14）；electron 二进制下载改用 npmmirror 镜像（`electron_mirror`），并修复 `pnpm-workspace.yaml` 中 `allowBuilds` 的占位文本错误（此前 electron 构建脚本被忽略、二进制从未下载）
- **升级 electron-builder 24 → 26.15.3**：构建链漏洞部分修复
- **剩余 29 个**（14 high）均为 electron-builder 构建链的传递依赖（tar / ini / brace-expansion 等），仅影响打包工具不影响运行时，待上游修复

**CI 门禁**

- ci.yml 新增 **依赖审计步骤**（`pnpm audit --audit-level=critical`，官方源）：critical 已清零，回归即红；high 存量在注释中记录原因

**文档校准**

- **优化路线图 v1.1**：现状快照表与总览表此前停留在 v0.11.0（大量已完成项标注 ❌/⬜）——重写为 v0.11.13 真实状态（快捷回复/作者注释/RAG/上下文模板/tiktoken/宏系统等已全部完成），各阶段章节与版本规划表补充状态标注；执行追踪表本就准确，保留为权威依据
- README 版本徽章 0.11.10 → 0.11.14（此前已滞后 4 个版本）

---

## [0.11.13] - 2026-08-05

### 角色卡模块测试补全（95%+ 覆盖）+ 草稿封面降级修复 + act 警告清理

**测试补全（+71 用例，全量 821 通过）**

- **store action 全链路**（28 例）：AI 扩展成功/失败/取消/思考块剥离/chat 抛异常兜底；单字段帮我写（用户输入/截断/空结果）；备选开场白（主消息/自动扩容/差异化提示）；生图（SD/DALL-E 降级/未配置/失败）；保存（兜底命名/裁剪降级/失败不跳转）；草稿持久化（写入/恢复/损坏数据/reset）
- **页面与组件交互**（42 例）：向导三步切换/回退/草稿恢复弹窗/离开确认；帮我写面板展开/收起/Ctrl+Enter/生成中态/主消息面板；标签与备选开场白增删改；封面 Tab 切换/风格预设/尺寸负面词/生成中 loading/文件上传/拖拽上传/无配置引导；预览保存成功跳转/失败错误条
- **角色卡模块覆盖率**：语句 **95.3%**（工具层 97.5%+，页面容器 98.5%，步骤条 100%），全项目语句 25% → 29.1%

**修复**

- **草稿恢复封面降级**：恢复的草稿封面是 192×256 压缩缩略图，直接保存会把低清图作为正式封面落盘——新增 `coverIsThumb` 标记，保存时拦截并提示回到封面页重新上传/生成；CoverStep 增加缩略图警示条；重新上传/生成后自动清除标记
- **restoreDraft 数组字段兜底**：旧版本/手写草稿缺失 tags/alternateGreetings 等字段时恢复即崩溃——补 `Array.isArray` 兜底
- **CoverStep 错误提示条**：生图失败等错误此前在封面页不可见，补上错误展示与关闭

**测试基建**

- **act 警告清理**：全项目 React act 警告从 100+ 降至 3（仅剩跨测试文件 zustand 串扰，单文件执行为 0）；setup.ts 补 quickReply mock + afterEach 微任务多轮冲刷；ChatInput/SettingsPage/useChatInputState 测试补 render 冲刷；ChatPage 的 Virtuoso mock 改 forwardRef 消除 ref 警告
- **仓库清理**：`lint*.json` 审查临时产物（约 1.5MB）移出版本库并加入 .gitignore

---

## [0.11.12] - 2026-08-05

### 制作角色卡向导（三步流程）+ AI 辅助创作 + 多项修复

**制作角色卡（新页面 `/character-create`）**

- **三步向导**：概念设定 → 封面制作 → 预览保存；步骤指示器支持回退，高级设置（默认记忆 / 作者注释 / 创作者备注）并入 Step 1 底部可选区块
- **AI 一句话扩展**：输入简短概念（如「赛博朋克世界的女黑客」），流式生成完整角色设定（名称/描述/性格/场景/首条消息/对话示例/标签）；生成中可停止；返回文本容错解析（代码块包裹 / 前后杂文 / 截断 JSON 部分恢复）
- **单字段「帮我写」**：每个字段可展开输入面板，填入想法或草稿后 AI 据此生成/修改（Ctrl+Enter 快速生成，留空则自主创作）
- **首条消息 + 备选开场白**：主消息外可添加多条备选开场白，每条可独立编辑/删除/「帮我写」；AI 生成备选时自动携带已有开场白列表，要求风格差异化避免重复（与角色卡编辑器同一 `alternateGreetings` 字段）
- **封面制作**：上传（拖拽/点击）或 AI 生成（提示词自动构建 + 风格预设 + 尺寸选择 + SD 负面词）；DALL-E 1024² 自动前端裁为 3:4；无生图配置时引导去 API 页；保存时从封面裁剪 1:1 头像（上/中/下位置可调）
- **草稿持久化**：防抖 500ms 自动保存草稿（文本字段 + 封面缩略图，完整图片不落 localStorage 防爆配额）；刷新/重进可恢复，离开时有确认
- **输出清理**：AI 回复中的思考块（`<thought>` / `<thinking>` / `<reasoning>`）与元语言引导句（「好的，这是为你生成的内容：」）自动剥离；tags 支持 JSON 数组输出
- **入口**：角色管理页顶部新增「制作角色卡」主按钮

**修复**

- **最大更新深度溢出**：`CoverStep` 的 selector 直接调用 `getActiveImageGen()` 每次返回新对象，违反 useSyncExternalStore 快照稳定性导致无限重渲染——改为订阅稳定字段 + useMemo
- **草稿未随编辑保存**：防抖持久化原只依赖步骤变化，字段编辑不触发——补上 draft/封面/头像位置依赖
- **textarea resize 手柄样式**：原双斜线手柄依赖 `::-webkit-resizer::after` 伪元素绝对定位（无定位上下文导致错乱），重写为纯 background 渐变，颜色跟随主题变量自动适配浅色/深色

**测试**：新增 47 例（AI 输出容错解析与清理、提示词构建、头像裁剪、开场白差异化提示），全量 **750 通过**（58 文件）

---

## [0.11.11] - 2026-08-05

### 安全加固（纵深防御）+ 世界书导入推荐 + 文件原子写入

**安全加固**

- **页面内导航防护**：`will-navigate` 仅允许应用自身 URL（dev: vite 服务；prod: 本地 index.html），AI 消息/角色卡中的 Markdown 链接点击不再能把主窗口导航到外部站点，一律拦截并转系统浏览器打开
- **生产环境 CSP 注入**：本地 file:// 页面无响应头，通过 `webRequest.onHeadersReceived` 注入 CSP（`script-src 'self'` / `object-src 'none'` / `base-uri 'none'` / `frame-ancestors 'none'` 等），HTML 注入即使发生也有脚本执行兜底限制
- **公告 HTML 消毒**：新增服务端纵深防御层 `sanitize.js`（白名单标签 + 黑名单属性/协议，杀伤性过滤），公告接口全量接入
- **链接安全渲染**：新增 `MarkdownLink` 组件——仅 http/https 渲染为可点击链接，`javascript:` / `data:` / `file:` 等危险协议降级为纯文本；消息气泡 / 群聊消息 / 公告页接入
- **防任意文件读取**：`file:readImageBase64` 仅允许 dialog 登记过的路径 + 文件存在二次确认，不再凭扩展名放行
- **公告参数校验**：`page` / `pageSize` / `id` 均做类型与范围校验（防 URL 参数注入与超长请求）
- **会话字段白名单**：`chat:updateSession` 仅允许更新 10 个常规字段（title/memory/memoryEnabled 等），防注入 `id` / `characterId` 等关键字段；标题限长 200 字符
- **日志脱敏**：IPC 异常日志经 `sanitizeApiKey` 过滤，API Key 不再出现在日志中；移除 index.html 内联脚本以配合 CSP

**世界书导入推荐（修复问题 32）**

- **匹配算法重写**（`lorebookMatcher.ts`）：原实现按空格分词对中文完全失效——改为 CJK 感知词提取（英文/数字按边界分词，中文短段整段、长段拆 bigram）；加权计分（角色 name + tags 为高权重精确信号，description 等为宽信号）
- **规模兜底**：世界书超 100 本或单文件超限时跳过匹配，防极端大库导入卡顿
- **显式确认绑定**：导入角色卡后弹出「检测到相关世界书」Modal，按匹配度展示候选，用户确认后才绑定（替代旧的静默自动绑定）；新增 `bindLorebook` IPC 与 `LorebookSuggestion` 类型

**稳定性与其它**

- **配置文件原子写入**：群聊 / 人设 / 正则的配置写入改为 `临时文件 + rename` 原子替换，进程中断不再产生半截 JSON
- **向量兜底修正**：embedding 结果缺失时补零向量沿用批次已知维度（原实现可能产生维度不一致导致下游点积错乱）
- **用量统计兜底**：usage 记录 model 缺失时置为 `unknown`，不再出现空值行
- **类型加固**：各模型适配器 / imageGen / tokenizer / preload 的 tsc 类型修正
- **测试**：新增 lorebookMatcher 11 例 + sanitize 10 例；全量测试 **703 通过**（55 文件）

---

## [0.11.10] - 2026-08-02

### OpenCode Go 订阅接入 + API 协议类型精简 + 角色卡编辑器布局优化

- **角色卡编辑器布局优化**：编辑弹窗从 `max-w-2xl` 加宽至 `max-w-5xl`；内容改为双栏布局（左：头像/名字/标签/描述/性格；右：场景与提示/对话开场/扩展与示例），滚动距离减半
- **字段卡片化**：15 个字段块（含备选开场白/作者注释/长记忆等）全部改为独立圆角面板（`.field-card`），字段间边界清晰；分组标题升级为 accent 标签样式
- **双栏内容重排**：短字段（场景设定/预设世界书绑定/创作者/聊天背景）移入左栏「场景与绑定 / 其他」分组；「扩展与示例」5 个块（对话后指令/作者注释/长记忆/群聊开场白/对话示例）并入左栏「其他」分组；右栏聚焦核心内容（角色描述/系统提示词/首条消息/备选开场白），两栏高度更均衡
- **去除“高级选项”折叠**：所有字段直接平铺展示，减少一次点击、信息一目了然

- **协议类型精简**：协议按钮从 11 个减为 4 个真协议（OpenAI 兼容 / Anthropic / Gemini / Ollama）。DeepSeek、Groq、硅基流动、OpenRouter、OpenCode Go 等服务商本就是 OpenAI 兼容协议，归入「快速填入」由 Base URL 区分，不再重复占用协议按钮
- **本地服务归并**：vLLM / LM Studio / TabbyAPI 统一走 OpenAI 兼容协议，本地地址（localhost / 127.0.0.1 / 0.0.0.0 / ::1）自动免 API Key（新增 `isLocalUrl` 判定，覆盖全部连接检查点）；旧配置自动兼容，无需迁移
- **OpenAI 兼容说明**：选中该协议时提示覆盖的服务商与本地服务，选完用快速填入一键配置
- **新增 OpenCode Go 快速填入预设**：API 设置 → 快速填入一键填入 Base URL `https://opencode.ai/zen/go/v1` + 推荐模型 `glm-5.2`（低价订阅，OpenAI 兼容协议）
- **DeepSeek 地址修正**：按官方文档将快速填入/默认配置的 Base URL 从 `https://api.deepseek.com/v1` 改为官方标准写法 `https://api.deepseek.com`（两者均可用，已验证）
- **协议兼容全量实测**：OpenCode Go 共 24 个模型逐一实测（模拟项目完整请求参数），**18 个完全兼容**（含官方标注 Anthropic 端点的 MiniMax M3 / Qwen3.7 Max 等）；`kimi-k3` 采样参数受限（temperature 仅 1、top_p 仅 0.95），已在适配器自动修正；`gpt-5.6-luna`（仅 /responses）、`mimo-v2-pro`/`mimo-v2-omni`（已弃用）、`grok-4.5`/`hy3-preview`（上游未就绪）不可用，已在模型列表置灰并标注原因
- **快速填入增强**：预设支持可选推荐模型字段，模型为空时自动填入（OpenCode Go → glm-5.2）
- **翻译不再覆盖原卡信息**：整卡/单字段翻译首条消息时不再直接覆盖 `firstMessage` 原文，与其余字段一致统一存入 `translatedContent`（原文永保，双语对照）；新增 `translatedContent.alternateGreetings` 存备选开场白译文（索引对齐，未翻译项回退原文）
- **译文优先链路打通**：对话注入（新建会话首条消息）、开场白选择面板、角色详情、卡片预览均优先展示译文，未翻译回退原文
- **编辑器译文对照**：首条消息/备选开场白新增译文对照块与清除按钮；删除备选开场白时同步清理对应译文保持索引对齐

---

## [0.11.9] - 2026-08-01

### TTS 扩展（3.2-B）：Edge TTS

- **Edge TTS 引擎**：微软免费在线语音（`node-edge-tts` 纯 JS WebSocket 协议，无原生依赖、无需 API Key），合成 mp3 返回渲染进程播放
- **14 种常用音色**：中文 8（晓晓/晓伊/云希/云健/云扬/云夏 + 东北晓北/陕西晓妮）+ 台湾/香港/美音/日语/韩语
- TTS 配置 UI 新增 Edge TTS 提供商与音色下拉；Edge 与 OpenAI 同走 mp3 base64 播放（暂停/恢复/停止/自动结束）
- 长文本截断 3000 字符、30s 超时、临时文件自动清理
- 新增 2 个引擎测试，全量测试 383 → 385 通过

---

## [0.11.8] - 2026-08-01

### TTS 扩展（3.2-A）：OpenAI 兼容 TTS

- **新增 OpenAI TTS 引擎**：复用现有连接配置，`POST {baseUrl}/audio/speech` 生成 mp3，渲染进程播放——音质显著优于系统语音
- **provider 重构**：`system`（Windows 系统语音，原引擎）/ `openai`（新引擎）；存量 `edge` 值自动迁移为 `system`（旧字段名实为系统语音，现已正名）
- **TTS 模型配置 UI**：OpenAI 音色预设下拉（alloy / nova / onyx / echo / fable 等 10 种）、默认模型 tts-1、Base URL / API Key 配置、测试连接
- **播放控制**：OpenAI 引擎支持暂停/恢复/停止，播放结束自动复位；长文本截断 4000 字符、请求超时 60s
- 新增 6 个引擎测试（请求构造/斜杠兼容/无 key/截断/错误），全量测试 377 → 383 通过

---

## [0.11.7] - 2026-08-01

### 预设管理优化（第三批：智能与测试）

- **AI 生成预设**：描述需求（如“冷傲女王系，回复简短带刺”）→ AI 流式生成 System Prompt / Jailbreak / 参数建议，一键填入表单（结构化解析 `parsePresetGeneration`）
- **预设测试器**：编辑器中用当前预设参数（System Prompt + Jailbreak + 温度/TopP/最大 Token）对样例输入跑真实流式生成，显示参数与输出，可停止/复制，不保存到对话
- 新增 7 个解析器测试，全量测试 370 → 377 通过

---

## [0.11.6] - 2026-08-01

### 预设管理优化（第二批：参数增强）

- **预设级示例对话模式**：预设可覆盖全局的 `exampleDialogMode`（跟随全局 / 每轮 / 仅首轮 / 关闭），优先级：预设 > 全局
- **采样参数快捷模板**：创意 / 平衡 / 稳定 一键应用（温度 + TopP + 频率/存在惩罚组合）
- **Token 预算预览**：编辑预设时实时显示 System Prompt / Jailbreak / 合计的 token 估算
- 新增 4 个预设级 exampleDialogMode 集成测试，全量测试 366 → 370 通过

---

## [0.11.5] - 2026-08-01

### 预设管理优化（第一批：数据闭环）

- **导出 JSON**：预设卡片新增导出按钮（`preset:exportJson`，内置/自定义均可导出，保存对话框）
- **一键复制**：基于任意预设（含内置）创建可编辑副本，无需手抄字段
- **分组管理**：预设新增 `group` 字段，列表按组折叠展示（组名/数量/折叠），编辑器分组输入带已有组名补全；未分组归入「未分组」

---

## [0.11.4] - 2026-08-01

### 对话优化 P1

- **上下文上限预警**：buildContext 记录实际用量，聊天页显示预警条（≥85% 琥珀 / ≥100% 红色），提供「立即总结」「清理历史」直达操作
- **会话标题自动生成**：新会话第 4 条用户消息后 AI 生成 2-8 字标题并持久化（`titleGenerated` 防重复，`Settings.autoTitle` 可关）
- **单聊引用回复**：消息 hover 引用按钮 → 输入框引用条 → 发送携带 `replyToId`；气泡内显示被引用消息摘要（可点击再引用），与群聊交互一致

---

## [0.11.3] - 2026-08-01

### 对话优化 P0-1：上下文溢出压缩

- 历史被裁剪（超上下文预算）时，不再直接丢弃：本轮结束后异步用 AI 将早期内容压缩为 3-5 句摘要，存会话（`compressedSummary` + `compressedRange` 防重复压缩）
- 后续构建上下文时，摘要注入历史段最前（【早期对话压缩摘要】，keepSeparate），保留人物/地点/目标/事件/约定
- 触发阈值：被裁剪历史 ≥ 2000 token（`Settings.contextCompression` 可调/可关）
- 编辑/删除/清空消息时压缩缓存自动失效
- 单聊/群聊一致

### 对话优化 P0-2：记忆事实向量检索注入

- 记忆总结保存关键事实后，异步向量化（复用嵌入服务）存会话 `factsVectors`
- 生成前对最近 20 条消息嵌入，与会话事实余弦比对 topK（≤3，阈值可配），**仅注入与当前对话相关的事实**
- 回退：未启用嵌入 / 无向量 / 检索失败时全量注入（行为不变）
- IPC 新增 `embedding:embedFacts` / `embedding:searchFacts`
- 单聊/群聊一致

### 测试

- 新增 8 个集成测试（压缩注入/范围/开关 4 + 事实语义注入/回退 4），全量测试 358 → 366 通过

---

## [0.11.2] - 2026-07-31

### 快捷回复（Quick Reply）

- **全局 + 角色级**：快捷回复支持全局（所有角色可用）与角色专属（绑定角色）两级配置
- **三种动作**：发送文本（宏展开）/ 切换预设 / 触发斜杠命令
- **sendWithAI 开关**：发送后触发 AI 回复，或仅插入消息不触发
- **键盘快捷键**：Ctrl+1..9 触发对应快捷回复（配置面板设置）
- **聊天输入区按钮栏**：输入框上方横向展示（含快捷键角标），点击即发
- **配置页**（快捷回复）：分组管理 + 编辑 Modal + 导入/导出 JSON（合并式导入）

### 宏系统

- **内置宏 10 个**：{{time}} / {{date}} / {{datetime}} / {{random:A|B}} / {{newline}} / {{group}} / {{lastMessage}} / {{lastUserMessage}} / {{char}} / {{user}} / {{original}} / {{id}}
- **宏注册表**（`registerMacro` / `unregisterMacro` / `listMacros`）：各功能模块可注册自定义宏（为扩展系统铺路）
- **全链路展开**：快捷回复、预设（systemPrompt/jailbreak）、世界书条目、用户人设、作者注释在上下文构建时统一展开；未注册宏原样保留
- **编辑器宏插入提示**：快捷回复配置页提供宏 chips 一键插入（含示例说明）
- 新增 27 个测试（宏展开 19 + 快捷回复合并/快捷键 8），全量测试 331 → 358 通过

---

## [0.11.0] - 2026-07-31

### API 提供商扩展

- **新增 4 个提供商**：
  - OpenRouter：路由聚合，一个 key 访问全模型（默认 `https://openrouter.ai/api/v1`，API 页提供快速预设）
  - vLLM：本地推理服务（默认 `http://localhost:8000/v1`）
  - LM Studio：本地推理（默认 `http://localhost:1234/v1`）
  - TabbyAPI：exllamav2 本地推理（默认 `http://localhost:5000/v1`）
  - 均为 OpenAI 兼容协议，复用 openai 适配器（请求构造/流式/工具调用/模型列表全部生效），未来需要特化（如 vLLM extra_body）时替换为独立实现即可
- **适配器注册表**（`registerAdapter` / `unregisterAdapter` / `getAdapter`）：自定义 provider 优先于内置，未知 provider 回退 OpenAI 兼容——为阶段 4 扩展系统铺路
- **本地提供商统一判断**（`isLocalProvider`）：ollama / vllm / lmstudio / tabby 视为无需 API Key 即可连接，12 处连接判断（isConnected / 发送前校验 / 角色卡翻译等）统一收敛
- **UI**：API 页提供商选择列表 + PROVIDER_INFO 描述 + OpenRouter 快速预设；默认 providers 配置补全
- 新增 5 个注册表/请求构造测试，全量测试 326 → 331 通过

### 版本号对齐

- package.json / README badge 从 0.8.9 **对齐至 0.11.0**：0.9.0~0.11.0 的功能版本此前均已在 CHANGELOG 记录但 package.json 未同步递增，现统一对齐（应用内版本显示经 `app.getVersion()` 自动跟随）

---

## [0.10.2] - 2026-07-31

### 作者视角 / 用户视角增强

- **用户人设注入规则可配置**（`personaInjection`）：
  - 开关：关闭后不注入人设（仅保留 {{user}} 变量替换）
  - 位置：system = 拼入系统提示词（默认）/ separate = 独立 system 消息（keepSeparate，避免被合并）
  - 字段：描述 / 性格可分别开关（用户名始终注入）
  - 单聊/群聊上下文构建统一应用；人设文本支持 {{char}} 变量替换
  - 设置页新增「用户人设注入」配置卡片
- **群聊自由发言视角切换**：free 模式下输入区新增发言人选择器（用户 / 群成员），选择成员后发送的内容以该角色身份插入消息（不触发 AI 回复），便于推动剧情与模拟角色发言
- 新增 7 个 buildContext 人设注入集成测试（开关/位置/字段/空字段），全量测试 319 → 326 通过

---

## [0.9.5] - 2026-07-31

### 正则系统增强

- **触发器（triggerPattern）**：规则可配置触发条件正则，文本匹配才执行（如仅对含粗体标记的消息生效）；支持独立触发标志（默认 i）
- **停止字符串（stopStrings）**：output 规则可配置停止字符串，流式生成中命中立即截断并提前终止请求（省 token）；同时作为输出后处理兜底（覆盖非流式场景）。单聊/群聊流式链路统一接入
- **处理阶段（stage）**：text = 直接作用于输入/输出文本（默认）；markdown = 仅输出、在 text 规则之后链式应用（渲染层修复，如星号转义）
- **分组管理（group）**：规则按用途分组（翻译修复 / 格式清理 / 越狱清理…），RegexPage 按组折叠展示、组名自动补全
- **预览测试增强**：支持「全规则运行」（按 scope + 两阶段链路应用所有启用规则，显示应用/命中统计）与「仅当前规则」两种模式
- **引擎抽取**（`src/utils/regex.ts`）：safeRegExp（ReDoS 防护）/ ruleMatchesScope / ruleMatchesStage / ruleTriggers / applyRuleOnce / applyRegexRules / findStopIndex / truncateAtStop / collectStopStrings 全部纯函数，单聊/群聊输入输出路径统一复用
- 新增 29 个引擎测试，全量测试 290 → 319 通过

---

## [0.9.4] - 2026-07-31

### 语义触发（向量 RAG）

- **嵌入服务适配器**（`electron/services/embedding.ts`）：Ollama `/api/embed` + OpenAI 兼容 `/embeddings` 两种后端，自动分批（32 条/批）/超长截断/超时，零原生依赖
- **向量索引持久化**（`electron/services/vectorStore.ts`）：每世界书一个 JSON 索引（`data/vectors/`），L2 归一化存储（余弦 = 点积），带内存缓存与删除清理
- **余弦检索**（`src/utils/vector.ts`）：cosineSimilarity / l2Normalize / topKSimilar（阈值过滤 + 降序截取）纯函数
- **条目匹配模式 `matchMode`**：keyword（仅关键词/正则）/ semantic（仅语义）/ both（默认，兼容旧数据）；纯语义条目自动跳过关键词匹配
- **语义命中与关键词合并**（`mergeSemanticHits`）：关键词命中的条目优先保留，语义命中按 order 升序填充剩余预算；相同内容自动去重
- **单聊/群聊统一接入**：发送/重新生成/续写前异步预取语义命中（`_semanticLoreHits` 缓存），任何失败静默降级为纯关键词触发；会话切换时清理缓存
- **UI**：设置页新增「语义触发」配置区（提供商/Base URL/模型/API Key/相似度阈值/最大注入数 + 测试连接）；世界书页新增「生成语义索引」按钮、索引状态展示与条目匹配模式选择
- **验收场景**：世界书条目内容向量化后，“猫娘”可语义触发含“猫咪”的条目（无需关键词命中）

### 长记忆升级（摘要 + 关键事实）

- **结构化抽取**：总结提示词升级为输出「【摘要】+【事实】」双段格式，`parseMemoryResult` 解析（去编号/剥离 thought 标签/格式兜底），事实上限 30 条
- **跨轮合并更新**：每次总结传入之前的事实，模型保留仍有效的、更新已变化的、删除被推翻的、补充新事实；事实按会话持久化（`memoryFacts`，单聊/群聊同步）
- **注入预算裁剪**（`fitMemoryBudget`）：摘要占预算 60%（超限尾部截断），事实按顺序填满剩余预算；记忆总预算 = min(800, 上下文预算 × 10%)
- **角色级默认开启**：角色卡新增 defaultMemoryEnabled / defaultMemoryMode / defaultMemoryInterval，新建会话自动继承（会话内可单独覆盖）
- **UI**：MemoryPanel 新增关键事实预览；角色编辑器新增长记忆默认配置区

### 测试与质量

- 新增 55 个测试：向量工具 16 + 语义合并/触发 9 + 嵌入适配器 15 + 记忆解析/预算 15
- 全量测试 235 → 290 通过；tsc 类型检查 + electron esbuild 编译通过

---

## [0.9.3] - 2026-07-31

### 上下文模板（Context Templates）

- **内置模板补全**：ChatML / Qwen / DeepSeek（统一 ChatML 格式）、Alpaca、Gemma、Llama 2/3、Mistral、Phi-3、Command R
- **模板真实生效**：修复模板系统半成品问题——此前 instructTemplate 传给 ChatParams 后无任何 adapter 消费（仅 appendAssistantPrefix 生效）。现 Ollama 适配器在模板模式下改用 /api/generate 纯文本接口 + 模板包装 + options.stop 停止序列
- **预设级模板选择**：预设新增 contextTemplate 字段，编辑 UI 提供内置模板下拉；优先级：预设指定 > profile 自动推断 > 不启用
- **单聊/群聊统一**：buildContext / sendMessage / 群聊上下文 均使用 resolveEffectiveTemplate 解析
- **applyInstructTemplate 纯函数**：消息数组 → 模板包装文本 + 停止序列
- 新增 15 个测试（模板解析 12 + Ollama generate 路径 3），全量 235 通过

---

## [0.9.2] - 2026-07-31

### 作者注释（Author's Note）

- **两级配置**：全局级（设置页）+ 角色级（角色编辑器覆盖全局）
- **三档注入位置**：top（系统提示后）/ middle（历史消息中按深度）/ bottom（最新消息前）
- **深度语义对齐 ST**：depth 0 = 最新消息之前，depth 1 = 倒数第二条之前（查证 ST populationInjectionPrompts 源码确认：倒序数组 splice(i)）
- **keepSeparate 机制**：修复 mergeConsecutiveMessages 把注入的 system 消息合并进相邻消息的问题（同时修复 at_depth 世界书深度注入被合并的潜在 bug）
- **预算纳入**：AN token 计入上下文预算（历史裁剪前预留）
- **变量替换**：支持 {{char}} / {{user}}
- 新增 8 个 buildContext 集成测试（位置/覆盖/关闭/变量替换）

---

## [0.9.1] - 2026-07-31

### 世界书深度对齐（at_depth + 统一触发引擎）

- **插入位置补全 4 档**：before_char / after_char / at_depth / at_end，at_depth 支持按深度在历史消息段内注入独立 system 消息（ST depth 语义：0 = 对话末尾）
- **抽取 `triggerLorebooks()` 共享纯函数**（`src/utils/lorebook.ts`），消除单聊/群聊 150+ 行重复触发代码
- **递归扫描、概率骰子、预算裁剪、位置分发** 全部纳入统一入口，单聊/群聊复用
- **导入兼容**：角色卡内嵌世界书 + ST 世界书 JSON 均支持 at_depth / position 数字映射（0-3）
- **LorebookPage UI** 新增 at_depth 位置选项 + depth 输入框（position='at_depth' 时显示）
- **新增 8 个 triggerLorebooks 纯函数测试**：关键词触发 + 分发、深度保留、递归、概率跳过、禁用过滤、变量替换、预算裁剪、正则

---

## [0.9.0] - 2026-07-31

### 新功能

- **功能状态表（docs/功能状态.md）**：
  - 建立功能宣称与代码实现的一致性审计文档，全部功能按 已实现/部分实现/未实现 三态标注
  - 修正 README 5 处失实宣称：世界书匹配模式（无向量/LLM）、TTS 提供商（实为 Windows 系统语音）、ComfyUI（未实现）、斜杠命令数（14 非 16+）、主题色（6 非 9 种）
  - 修正 TTS 模型配置 UI 误导标签（"Edge TTS" → "系统语音"，实为 System.Speech）

- **CI 流水线（.github/workflows/ci.yml）**：
  - test job：pnpm 安装 → tsc 类型检查 → vitest 全量测试 → esbuild 主进程编译验证
  - lint job：存量 152 个历史错误暂允许失败（continue-on-error），修复后收紧
  - build-windows job：main 分支推送自动构建 NSIS 安装包并上传 artifact

- **核心路径测试（AI 适配层）**：
  - OpenAI / Claude / Gemini / Ollama 四适配器 19 个测试：请求构造、非流式/流式响应解析、SSE 跨 chunk 边界、reasoning 标签包装、tool_calls delta 收集、推理模型参数剔除、非 2xx 错误传播
  - 群聊 mention 提取 4 个测试：@点名记录、无点名不记录、部分名不误匹配、多成员点名
  - IPC safeHandle 4 个测试：正常透传、错误 rethrow、非 Error 值处理
  - 全量测试 167 → 193 个

### Token 精确计数（tiktoken 接入）

- 接入 tiktoken 1.0.22 真实分词器，支持 o200k_base / cl100k_base / p50k_base / r50k_base / gpt2 五种编码
- gpt-4o / gpt-4.1 / o1 / o3 / o4 / gpt-5 等 OpenAI 模型走 tiktoken 官方模型表精确匹配
- Claude / Gemini / DeepSeek / Qwen / Llama / Mistral 等非 OpenAI 模型使用 token 效率相近的编码近似（cl100k_base / o200k_base）
- 编码实例缓存：避免每次计数都创建/释放分词器实例
- 未知模型自动回退启发式估算，不抛错
- 加载失败时自动降级启发式并写入日志
- 对比启发式估算：中文 RP 段落误差从 21% 降至 0，英文长文本从 30% 降至 0
- 打包产物已包含 wasm + 全部 BPE 编码文件，离线可用

---

## [0.8.9] - 2026-07-29

### 新功能

- **字体自定义功能**：
  - 新增对话字体选择功能，支持 6 种内置字体（系统默认、Arial、微软雅黑、宋体、黑体、楷体），每种字体均带预览效果
  - 支持用户上传自定义字体文件（TTF/OTF 格式），字体文件存储在本地用户数据目录，上传时校验文件格式（magic number）和大小限制（10MB）
  - 字体变更通过 CSS `font-display: swap` 异步加载，避免页面卡顿；切换后所有对话历史记录实时生效
  - 设置页新增字体管理区域：上传、预览、应用、删除自定义字体
- **群聊引用回复**：
  - 群聊消息支持引用回复，hover 消息显示回复按钮，点击后输入框显示引用预览条
  - 发送消息时引用块显示在气泡顶部，含被引用消息的角色名和内容预览
- **群聊 @提及高亮**：
  - 用户消息中 @角色名 自动检测并以高亮样式显示（accent 色背景 + 圆角）
  - 基于群成员名动态匹配，避免误匹配邮箱/URL 中的 @ 符号
- **群聊用户消息发送状态**：
  - 用户消息发送时显示「发送中」旋转图标，AI 回复完成后变为「已发送」勾选图标
- **群聊消息气泡不透明度调节**：
  - 群聊设置面板新增「气泡不透明度」滑块（0%-100%），支持拖动实时预览、松手保存
  - 角色气泡通过 `color-mix` 动态混合背景色与透明度，配合聊天背景使用效果更佳
  - 用户气泡保持固定样式不受影响
- **单元测试框架**：
  - 引入 Vitest + @testing-library/react + jsdom 测试框架
  - 编写 128 个单元测试，覆盖核心工具函数（对话解析器、消息后处理、默认值）、设置 Store、群聊 Store 和群聊消息组件

### 改进功能

- **群聊消息 UI 全面对齐单聊**：
  - 布局重构：新增 `mx-auto` 居中容器，使用 `settings.messageWidth` 限制最大宽度，消息不再紧贴左边缘
  - 头像升级：添加渐变背景（`bg-gradient-to-br`）和环形光效（`ring-2`），与单聊 MessageBubble 风格统一
  - 名称行升级：字号从 `text-[10px]` 提升至 `text-xs`，名称使用 `font-medium text-tavern-text-soft`，时间和发送状态移至头部行
  - 气泡升级：内边距从 `px-4 py-2.5` 增大为 `px-5 py-3.5`，添加阴影，支持 `settings.bubbleStyle` 圆角设置
  - 用户气泡使用与单聊相同的暖色渐变（`from-amber-100 to-orange-50`），角色气泡保留彩色左边框 + `shadow-sm`
  - 消息间距改用 `settings.messageSpacing` 内联样式
  - 新增 `.mention-highlight` 和 `.reply-quote` CSS 样式类
- **群聊背景层 z-index 修复**：
  - 背景层添加 `z-0`，顶栏/消息区/输入区/成员栏添加 `relative z-10`，修复聊天背景遮盖菜单栏的问题
- **角色卡页面性能优化**：
  - `CharacterCard` 包裹 `React.memo`，配合 `useCallback` 稳定回调引用，避免父组件重渲染时所有卡片跟着重渲染
  - 搜索输入使用 `useDeferredValue` 防抖，输入时不再逐字符触发全量过滤
  - 封面图片添加 `loading="lazy"` 懒加载，视口外图片延迟加载减少初始解码压力
  - `CharacterCard` 的 store 订阅从全量解构改为 4 个独立选择器，避免导入进度等无关状态变更触发卡片重渲染
  - 尺寸配置对象 `SIZE_CONFIG` 从组件内部提取为模块级常量，减少每次渲染的对象创建
- **群聊默认预设**：
  - 新建群聊默认应用「默认通用」内置预设，无需手动在设置面板中选择
- **群聊上下文与世界书引用优化**：
  - 世界书扫描文本加入角色名前缀（`【角色名】内容`），以角色名为关键词的世界书条目现在可被正确触发
  - 后历史指令（`postHistoryInstructions`）纳入 token 预算裁剪计算，避免裁剪后注入导致实际上下文超出 `maxContext`

### 已知问题

- 自定义字体仅当前设备可用，不随角色卡导出（与现有纯本地存储策略一致）
- 内置字体（SimSun/SimHei/KaiTi）依赖系统已安装，若用户系统未安装则浏览器自动 fallback

---

## [0.8.8] - 2026-07-28

### 改进功能

- **预设上下文长度跟随模型**：所有内置预设的 `maxContext` 改为 0（跟随模型默认），不再硬编码 8192/16384 限制模型实际能力。用户选 GPT-4o 即可用 128K 上下文，选 Claude 即可用 200K，预设不再拖模型后腿
- **越狱预设输出长度提升**：越狱-温和/标准/强力的 `maxTokens` 从 1024 提升到 2048，修复 Claude 思考模型（thinking budget = max(1024, maxTokens/3)）下思考预算吃满全部输出额度导致实际回复为空的问题
- **快捷设置自定义 Token 输入**：快捷设置面板的最大 Token 除 4 个固定档位按钮外，新增自定义数字输入框，支持输入任意值
- **快捷设置字体放大**：快捷设置面板内所有文字字号统一调大（原 9px/10px/11px 提升至 11px/12px），改善可读性
- **角色卡页面全面优化**：
  - **卡片尺寸可调**：搜索栏新增小/中/大三档尺寸切换，小卡 1:1 方形紧凑排列（一屏 ~20 张），中卡 3:4 竖卡（一屏 ~12 张），大卡 2:3 宽卡展示更多信息；尺寸偏好自动记忆
  - **卡片信息增强**：新增性格特征碎片标签（柔和圆角色彩）、场景设定预览（斜体一行）、创作者名称（@作者名）；卡片信息密度翻倍，所有字段随尺寸自适应显示
  - **角色详情面板**：点击卡片任意位置打开右侧滑出只读详情面板，分区展示角色全部设定（基本信息/标签/角色设定/对话设定/高级设定/绑定设置），无需进入编辑模式即可浏览
  - **首条消息预览**：卡片信息区展示首条消息原文/翻译（替代原先难以辨认的角色描述），中/大卡显示 2 行，悬浮封面也可预览
  - **排序功能**：搜索栏新增排序下拉，支持按最近更新/创建时间/名称排序
  - **首条消息一键翻译**：卡片左下角新增翻译按钮，无需打开编辑器即可翻译首条消息；支持多张卡片同时翻译，互不阻塞

### Bug 修复

- **继续续写功能无效**：修复"继续续写"按钮未向 AI 传达续写意图的问题。原先仅创建新气泡走普通生成流程，AI 无法感知续写需求导致内容不连贯。现新增续写指令注入上下文末尾，并将原消息内容作为 `preContent` 传入流式输出，新气泡完整显示"原内容 + 续写内容"
- **预设 maxContext 被强制覆盖**：修复 `getActiveProfile()` 中 `profile.maxContext || 8192` 导致预设的 maxContext 永远不生效的问题（profile 始终返回 >= 8192 覆盖了预设值），现已改为 `|| 0` 让 0 表示"跟随模型"
- **Token 用量显示不准确**：修复 ChatHeader 和 ChatInput 中 maxContext 为 0 时显示硬编码 8192 的问题，改为根据当前模型动态推断默认上下文长度
- **侧边栏无法滚动**：修复字体设置过大时侧边栏导航项溢出但无法滚动的问题，导航区域添加 `overflow-y-auto`
- **对话解析器正则全面重构 (B-07/B-08)**：
  - **粗体文本误渲染为黑点**：修复 AI 输出 `**粗体**` 时解析器误将 `*粗体*` 匹配为动作、残留外层两个 `*`在 CJK 字体下显示为黑色实心点的问题。新增 `**...**`、`***...***`、`__...__`、`___...___`、`~~...~~` markdown 语法保护
  - **反引号破坏行内代码**：移除反引号`\`...\``→双引号的强制转换，该转换会将 markdown 行内代码误转为"对话"样式；改为直接保护行内代码
  - **动作内容支持内含 `*`**：动作正则从 `[^*]+` 改为 `[\s\S]+?` 非贪婪匹配，`*does *this* too*`可正确整体解析为动作
  - **说话人名 Unicode 扩展**：支持带重音拉丁字母（José）、西里尔字母（俄语）、数字（Player1）、连字符（AI-chan）等角色名
  - **新增单引号对话支持**：`Speaker: 'text'`和`Speaker：'text'`可正确识别为对话
  - **英文缩写保护**：`don't`、`can't`、`it's` 等不再被单引号对话正则误匹配
  - **中文引号全面覆盖**：新增 CJK 双引号`〝〞`(U+301D/E)、直角引号变体`﹁﹃﹂﹄`(U+FE41-44)归一化；修复中文弯引号`""`(U+201C/D)此前未生效的问题
  - **多 thought 块提取**：GroupChatMessage 改用 `while+exec` 循环提取全部思考块，与 MessageBubble 行为一致
  - **冗余 thought 剥离**：MessageBubble 非翻译场景不再对已剥离文本重复执行 thought 标签处理
  - **占位符健壮性**：占位符标记从空字节`\x00`改为 Unicode 私用区字符，避免渲染管道破坏；restore 改为循环替换以处理嵌套保护
  - **快速预检优化**：新增预检正则，不含任何对话/动作标记字符时直接返回纯文本，跳过后续 10+ 步保护与解析

---

## [0.8.7] - 2026-07-27

### 新增功能

- **快捷设置模型列表**：对话快捷设置的模型选项不再需要手动输入，自动从当前 API Profile 的 `/models` 端点拉取可用模型列表；支持搜索过滤、刷新列表，获取失败时自动降级为文本输入框

### Bug 修复

- **文字大小调整无效**：修复设置中的字体大小档位（小/中/大/自定义）对所有使用 Tailwind `text-*` 类的文字完全无效的问题。根因是 `--font-size-base` CSS 变量只设到了 `body`，但 `rem` 单位读取的是 `<html>` 的 `font-size`，现已同步设置
- **新建 API 保存不正确**：修复已有 API Profile 后新建保存时的多个问题 — 新建表单填写中误触已有 Profile 卡片会静默覆盖表单数据；上下文长度输入未触发 blur 直接保存时使用旧值；`resetForm()` 不重置 `editingId` 导致状态耦合脆弱；`addProfile` 两步 `set()` 冗余简化为单步

---

## [0.8.6] - 2026-07-23

### Bug 修复

- **世界书 SillyTavern 格式导入**：修复 SillyTavern 世界书 JSON 导入失败问题。`entries` 字段为对象时自动转为数组，`position` 字段支持数字值 `0/1/2` 映射
- **翻译/总结/生图 `\<thought\>` 标签残留**：单聊翻译、群聊翻译、长记忆总结、图片提示词翻译、世界书翻译（流式）、AI 续写/润色 共 6 处均添加 `\<thought\>` 标签清理，思考模型不再将内部推理混入输出

### 改进功能

- **续写用户视角保障**：AI 续写功能强化 prompt 指令（明确用户名/角色名/严格约束），新增后处理 `ensureUserPerspective` 自动剥离角色视角内容
- **自动滚动修复**：修复流式输出时自动滚动中断问题，`userScrolledUpRef` 状态追踪逻辑重写，用户向上滚动暂停、回到底部自动恢复
- **用量统计增强**：分组显示优化（按角色显示角色名、按对话显示角色名）；汇总卡片新增总费用和平均费用；表格新增费用列；按天分组时显示日趋势柱状图；API 调用后自动刷新数据

---

## [0.8.5] - 2026-07-22

### 新增功能

- **多套越狱预设**：内置预设从 3 个扩展到 10 个，含温和/标准/强力三级越狱、NSFW 成人向、剧情驱动、纯爱甜宠等风格，用户可按模型灵活选择
- **预设与世界书绑定角色**：每个角色可绑定专属预设和世界书，切换角色时自动激活；修改设置时自动保存回角色绑定；角色编辑器中可直接配置
- **封面毛玻璃效果**：角色卡片封面悬停显示隐藏按钮，点击切换毛玻璃模糊；模糊强度可在设置中调节（0-30px）
- **编辑器 textarea 高度记忆**：角色编辑器中所有可拖拽调整大小的输入框记住高度，关闭后重新打开自动恢复
- **纯图片消息居中布局**：系统生图消息取消头像和气泡，图片居中显示，简洁直观
- **内心想法默认展开**：设置新增选项，可让消息中的心理描写区域默认展开
- **打开对话自动滚到底部**：加载大量历史消息时自动滚动到最新位置

### Bug 修复

- **`<thinking>` 标签兼容**：DeepSeek-R1 等模型原生的 `<thinking>` 标签现在正确识别为思考内容，不再直接显示或导致空消息
- **Unicode 引号匹配**：对话解析器支持弯引号 `""`、直角引号 `「」` 等变体，角色扮演中的对话不再因引号类型而丢失特殊样式
- **深色模式文字适配**：侧边栏品牌名、版本号从硬编码黑色改为主题色变量
- **角色切换预设/世界书泄漏**：切换角色时完全替换为新角色的绑定设置，不再混入旧角色残留
- **字符卡片按钮对比度**：编辑/导出按钮在深色封面上改为白色背景，清晰可见
- **CSS @import 顺序修复**：字体导入移到 `@tailwind` 之前，消除终端警告
- **入场动画只播一次**：消息气泡的淡入动画不再因虚拟滚动重新播放

### 界面优化

- **Token 用量简化**：顶栏只显示已用 token 数，hover 查看详情
- **用户气泡深色模式**：背景不透明度从 20% 提升到 70%，实体感明显
- **生图历史移至顶栏**：从输入框旁移到页面顶部快捷设置旁，输入区更干净
- **空消息兜底**：模型误把全部内容放入 `<thought>` 标签时，自动回退显示思考内容而非「空消息」

---

## [0.8.4] - 2026-07-21

### Bug 修复
- **命令别名冲突**：修复 `/plan` 和 `/preset` 共用别名 `p` 导致的冲突，preset 改用 `ps`
- **角色切换竞态**：修复 `selectCharacter` 快速切换角色时的竞态条件（版本号防竞态 + `.catch()`）
- **TTS 命令队列**：引入 Promise 队列串行化 TTS 命令，消除 stdout 监听器并发竞态
- **TTS 监听器泄漏**：`ensureProcess()` 中 init 监听器 resolve/超时后立即移除，防止累积
- **LorebookPage 监听器泄漏**：添加 `activeRequestIdsRef` + useEffect cleanup，组件卸载时自动取消 AI 请求
- **MCP 客户端监听器泄漏**：`cleanup()` 中 kill 前调用 `removeAllListeners()` 清理所有监听器
- **toolLoop 死代码复活**：重写工具调用循环，OpenAI 适配器解析 `tool_calls` 并附加 `[TOOL_CALL:json]` 标记，IPC handler 集成 `chatWithTools`
- **Promise rejection 处理**：useChatStore 6 处、useSettingsStore 21 处 fire-and-forget 调用统一加 `.catch(() => {})`
- **webContents.send 防御**：新建 `safeSend()` 工具函数，ai.ts 9 处 + character.ts 8 处统一替换
- **推理模型误判**：`includes('o1')` 改为词边界正则 `/\bo[134](?:-mini)?\b/`，不再误匹配 `gpt-3.5-turbo-1106`
- **currentSpeakerIndex 负数**：删除唯一成员时 `Math.max(0, ...)` 确保不为负
- **系统主题实时监听**：system 模式下 `matchMedia.addEventListener('change')` 实时跟随系统深浅色
- **before-quit 超时保护**：`Promise.race` 包裹 MCP shutdownAll + 3 秒超时，防止应用卡死
- **数据写入原子性**：`writeJson` 改用 temp 文件 + `renameSync`，防止崩溃时数据损坏
- **消息保存重复读取**：`updateMessage` 返回 isNew 布尔值，消除 saveMessage 中的重复 readMessages

### 性能优化
- **消息列表加速**：`listSessions` 改用行数统计获取 messageCount，不再全量解析 JSON
- **翻译节流**：`translateMessage` onChunk 添加 50ms 节流定时器，避免高频 re-render
- **设置保存防抖**：`updateSettings` 改用 300ms debounce 定时器，消除 IPC 洪水
- **背景滑块防抖**：滑块拖动时仅更新本地状态，mouseup 时才持久化
- **Thought 解析缓存**：MessageBubble 的 thought 解析改用 `useMemo`，依赖 `message.content`
- **tokenizer 缓存**：tiktoken 实例模块级缓存，避免每次调用都 require
- **日志文件大小缓存**：`cachedLogSize` 写入时累加，仅超阈值时 statSync 校准
- **数据库索引**：announcements 表添加复合索引 `idx_ann_pub_pin_created` 加速列表查询
- **textarea 高度计算**：ChatInput 和 GroupChatInput 用 `requestAnimationFrame` 避免同步 reflow

### 服务端
- **数据库索引**：添加 `CREATE INDEX idx_ann_pub_pin_created ON announcements(published, pinned DESC, created_at DESC)`
- **版本号更新**：默认版本号更新为 0.8.4

---

## [0.8.3] - 2026-07-21

### 新增功能
- **在线版本检测**：服务端新增 `/api/version` 端点，管理员可在后台设置最新版本号和更新日志；客户端启动时自动检测，侧边栏版本号旁红点提示新版本
- **版本管理后台**：管理员可在公告管理页面配置最新版本号、更新日志内容和下载地址
- **HelpPage 动态版本号**：帮助页面版本号改为动态获取，不再硬编码

### 优化
- **公告服务器加固**：`app_config` 表存储全局配置，版本 API 公开可读、管理员可写

---

## [0.8.2] - 2026-07-21

### 安全加固（阶段 1）
- **服务端安全**：移除 JWT 弱密钥硬编码，要求 `JWT_SECRET` 环境变量（≥32 字符）；移除 admin/admin123 默认密码，要求 `ADMIN_PASSWORD` 环境变量
- **防暴力破解**：登录接口增加 IP 级别速率限制（每分钟 5 次，锁定 15 分钟）
- **HTTP 安全头**：集成 Helmet 中间件，配置 CORS 白名单（`ALLOWED_ORIGINS`）
- **容器安全**：Dockerfile 改用 `node` 非 root 用户运行；新增 `.dockerignore` 排除敏感文件
- **IPC 安全强化**：
  - 封装 `safeId()` 校验所有 IPC handler 的 ID 参数（防止路径穿越）
  - `file:readImageBase64` 限制文件扩展名为图片格式
  - MCP 客户端禁用 `shell: true`（防止命令注入）
  - `shell.openExternal` 限制 URL 为 `http(s)://`
  - 启用 Electron `sandbox: true`
- **API Key 安全**：Gemini API Key 从 URL query 迁移到 `x-goog-api-key` header；错误消息脱敏
- **SSRF 防护**：下载封面/头像时禁止访问内网 IP、localhost、云元数据端点
- **SafeStorage**：不支持加密时拒绝保存 API Key（不再明文回退）

### Bug 修复（阶段 2）
- **群聊停止流式**：修复 `stopStreaming` 无法取消实际 AI 请求（先保存 `requestId` 再 cleanup）
- **群聊错误恢复**：修复 `unbindError` 丢失累积流式内容（先保存 `accumulated` 再 cleanup）
- **群聊轮询持久化**：`currentSpeakerIndex` 现在正确保存到 store 和磁盘
- **群聊轮询定时器**：轮询 `setTimeout` handle 保存为 `pollingTimer`，切换/删除群聊时自动清理
- **群聊流式更新**：`flushStream` 现在同步更新 `messages` 数组中的占位消息，用户可实时看到流式进度
- **世界书导入**：修复 SillyTavern 世界书 `enabled` 字段语义反转（`disable: true` 现在正确映射为 `enabled: false`）
- **流式重试**：流式请求失败不再重试（防止已发送 chunks 重复拼接）
- **群聊翻译安全**：`translateMessage` 改用 IPC 通道 `window.api.ai.chat()` 替代直接 `fetch()`，不再暴露 API Key
- **草稿公告**：管理后台新增 `/api/announcements/admin` 接口，草稿公告现在可见可编辑

### 优化
- **封面加载失败**：角色卡封面图加载失败时显示破碎图标 + 角色名首字母 + 点击进入编辑替换
- **背景图加载失败**：聊天背景图加载失败时静默降级，不影响页面渲染

### 性能优化与重构（阶段 3）
- **React.memo 优化**：`MessageBubble` 和 `GroupChatMessage` 组件使用 `React.memo` 包裹，避免无关状态变化导致的重渲染
- **共享组件抽取**：提取 `MarkdownImage` 公共组件，消除 `MessageBubble` 和 `GroupChatMessage` 中的图片错误处理重复代码
- **Reader 资源泄漏修复**：OpenAI / Claude / Gemini / Ollama 适配器的流式响应 `ReadableStream` reader 增加 `try/finally` 确保 `releaseLock()` 释放
- **IPC 监听器泄漏修复**：`ChatInput` 和 `CharacterEditor` 组件增加活跃请求追踪，卸载时自动取消未完成的 AI 请求并解绑 IPC 监听器

---

## [0.8.1] - 2026-07-21

### 新增功能
- **群聊系统**：支持三种对话模式（点名 @mention、轮询 polling、自由发言 free），多角色群聊消息渲染，成员栏实时状态
- **图片生成**：SD WebUI / ComfyUI 集成，AI 对话中 `/imagine` 命令生图，自动提取提示词，支持多种图像尺寸
- **角色卡翻译（无破坏）**：新增 `translatedContent` 字段存储译文，UI 显示翻译内容，AI 上下文保持原文，不影响对话质量
- **封面作为聊天背景**：支持将角色封面设为半透明聊天背景（40% 不透明度、4px 模糊），功能开关在设置中
- **群聊开场白选择器**：重构为模态弹窗，按角色分组展示多角色多开场白，支持自定义主题色
- **图片加载重试**：消息中的在线图片（附件和 Markdown 内嵌）加载失败时显示重试按钮，点击重新加载
- **输入框滚动条优化**：改为 overlay 渐显模式，hover/focus 时从透明淡入

### 问题修复
- **群聊删除按钮**：修复删除按钮不可见的问题，始终显示删除入口
- **群聊删除确认弹窗**：修复 `onCancel` → `onClose` prop 名称错误，修复确认弹窗无法取消的问题
- **React Hooks 规则**：修复 `useMemo` 在条件返回之后定义导致 "Rendered more hooks" 崩溃的问题

### 优化
- **UI 简化**：移除侧边栏顶部"轻语 AI 角色扮演"Logo 和图标，保留侧边栏高度不变
- **帮助页面**："关于"信息移至使用指南顶部，方便查看版本和应用信息
- **SD WebUI 生图**：自动检测中文提示词并通过 AI 翻译为英文，提升生图质量

---

## [0.1.0] - 2026-07-18 (初始版本)

### 核心功能
- **多 AI 后端支持**：OpenAI 兼容 / Claude / Gemini / Ollama，自定义 Base URL
- **角色卡管理**：V1/V2/V3 角色卡导入（PNG/JSON）、创建、编辑、导出，批量导入
- **对话系统**：多会话管理、对话分支（从任意消息创建新分支）、消息编辑与删除、消息回退
- **长记忆**：手动/自动 AI 总结对话历史，基于 token 预算自动注入上下文
- **世界书（Lorebook）**：关键词触发动态注入角色设定，常量/向量索引/LLM 三种匹配模式
- **预设管理**：对话预设、正则预设可切换
- **TTS 语音合成**：多 TTS 后端配置（Edge TTS、Fish Audio 等），每条消息独立播报
- **图片显示**：AI 生图集成、放大预览、消息附件图片
- **主题系统**：深色/浅色/跟随系统，琥珀金/翡翠绿/深海蓝/玫瑰粉等 8+ 主题色
- **对话翻译**：消息级中英互译，Markdown 格式保留
- **心理描写展示**：`<thought>` 标签内容折叠显示
- **数据管理**：完整备份/恢复（含角色、对话、设置、世界书），角色卡导入/导出
- **API 用量统计**：Token 消耗记录与可视化
- **MCP 工具集成**：Maven 版本查询、Everything 文件搜索等
