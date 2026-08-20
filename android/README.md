# 轻语安卓伴侣端（qingyu-companion）

PC 端「轻语」的安卓伴侣端：只做远程连接与对话消费，不做本地 AI 对话。完整方案见 `docs/安卓伴侣端方案.md`。

## 版本

当前版本 **0.1.5**（build 6，配合 PC 0.11.28/0.12.0）。更新日志见 [CHANGELOG.md](CHANGELOG.md)。

- 版本号集中管理：`gradle/libs.versions.toml` `[versions]` 中的 `appVersionName` / `appVersionCode` 为唯一权威来源，`app/build.gradle.kts` 引用；发布新版本时仅需在该处递增，并同步更新 CHANGELOG.md。

## 构建

前置：JDK 17+、Android SDK（compileSdk 34 / build-tools 34）。

```bash
# 在 android/ 目录
./gradlew assembleDebug        # Windows: .\gradlew.bat assembleDebug
./gradlew testDebugUnitTest    # 运行 JVM 单测（Markdown/thought/消息合并/图片源等）
```

`local.properties` 需指向本机 SDK（gitignore 已忽略）：

```
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

## 已实现（阶段一 MVP + 阶段二单聊增强）

- 配对：**扫码配对（ZXing，二维码自动填入）** + 手动输主机/端口/配对码 + 已配对设备管理（切换/移除），版本协商（`/api/v1/server/info`）+ **mDNS 自动发现 `_qingyu._tcp`（点击填入主机/端口，方案 §5.1 锦上添花）**
- 会话列表：REST 拉取 + WS `session:updated` 增量刷新 + 离线只读回退（Room）+ 二次确认删除 + **长按重命名** + **401 令牌失效横幅（PC 吊销/过期时提示重新配对，方案 §6.2）**
- 单聊：发消息（`requestId` 幂等、**引用回复 replyToId**）、流式接收（`ai:chunk`/`ai:done`/`ai:error`）、停止生成、历史分页（`beforeId` 游标）、**chunk 节流批量渲染（方案 §8 弱网对策）**、**发送中/失败气泡 + 手动重试 + 连接恢复自动重发（断线队列，复用幂等键）**、**聊天时间线（今天/昨天/MM-dd 日期分隔）**、**消息时间戳与 token 用量展示（ai:usage 事件）**
- **阶段二单聊增强**：长按消息操作（复制/编辑/删除/翻译/**重新生成**/**朗读**/**引用回复**）、swipe 候选切换、快捷回复条（text/preset/command 全类型，点击走 execute 端点，text 降级直发）
- **图片消息**（方案 §3.3 生图结果回传消费侧）：URL（桥接层静态路由）走 Coil、base64/data URI 兜底解码，多图两列平铺，点击全屏大图查看（左右滑动）
- **TTS**（方案 §3.3 独立音频通道）：长按「朗读」→ ExoPlayer 拉取 PC 合成音频流边下边播（`Media3`，`TtsPlayer` 接口 + `ExoPlayerTtsPlayer` 实现）
- **心理描写折叠**：`<thought>`/`<thinking>` 块提取（对齐 PC 端 `messagePostProcess.ts` 规范）+ 默认折叠展开
- Markdown 本地渲染、连接状态栏、断线指数退避重连
- 角色浏览（Coil 封面）+ **「设为当前角色」**（协议假设端点，PC 落地前失败仅提示）
- **设置页**：「退出时清除全部数据」（方案 §6.9，二次确认）、「清除本地缓存」（保留连接）、连接管理入口、**内网穿透指引**（方案 §5.2 三路线，完整文档见 `docs/内网穿透指引.md`）、关于/版本

## 目录

```
app/src/main/java/com/qingyu/companion/
├── model/      # DTO（对齐 shared/types.ts）+ WS 事件领域模型 + 消息合并纯函数
├── network/    # Retrofit/OkHttp + WebSocket + 连接管理 + mDNS 发现
├── data/       # Room 缓存、DataStore 连接存储、仓库、DI 容器
└── ui/         # Compose 页面与组件（含图片/thought/Markdown/TTS）
```

## 待办（阶段二剩余 / 阶段三）

- 群聊（PC 桥接层已实现 58 路由 `electron/bridge/routes.ts:1191-1630`，含建群/加人/会话/消息/TTS，安卓端待联调）
- 生图指令触发即已透传（任何文本按用户消息发送，PC 侧解析 `/imagine`）；图片结果展示已就绪
- **阶段三已落地**：用量统计只读页（`/api/v1/usage/summary`）、公告同步页（`/api/v1/announcements`）、内网穿透指引（`docs/内网穿透指引.md`）；消息推送与自建中继方案见 `docs/阶段三方案.md`（设计稿，待评审）

> 已归档：早期 `docs/安卓端功能缺失分析.md` 中快捷设置/长记忆/AI续写/润色/清空对话等“缺失”项已在 `v0.1.2-v0.1.5` 落地，详见 CHANGELOG 0.1.2/0.1.3/0.1.5。

## 协议对接状态（PC 桥接层阶段一已落地）

| 协议假设 | 状态 | PC 侧实现 |
|------|------|---------|
| 二维码 fingerprint = 配对码（一次性 5 分钟） | ✅ | `electron/bridge/auth.ts` + `bridge:pairingInfo` |
| 配对需 PC 端人工确认 | ✅ | `onPairRequest` → 渲染层弹窗 → approve/reject |
| WS 停止生成 `ai:stop` | ✅ | `ws.ts`（requestId → AbortController） |
| `ai:chunk`/`ai:done`/`ai:error`/`ai:usage` | ✅ | `chatService.sendMessage` 全链路 |
| `session:updated` 推送 | ✅ | `session:changed` → 主进程广播 + WS 转发 |
| swipe `direction=0` = 重新生成 | ✅ | `chatService.swipe`（regen 追加候选） |
| `PATCH /sessions/{id}` 重命名 | ✅ | routes |
| `quickReplies/:id/execute` | ✅（text 类型） | routes；preset/command 返回 501（安卓端已降级提示） |
| `characters/:id/activate` | ✅ | routes（更新 activeCharacterId + 新建会话） |
| TTS 端点 | ✅ | `GET /sessions/{sid}/messages/{mid}/tts`（Edge/OpenAI 合成，剥离 thought，支持 Range） |
| 正则管线（input/output） | ✅ | `chatService` 对齐渲染层 sendMessage |
| mDNS 广播 `_qingyu._tcp` | ✅ | bonjour-service（`electron/bridge/mdns.ts`） |
| `images` 静态路由 URL | ✅ | `/static/avatars|covers|messages/...` 白名单路由 |
| `serverInfo.apiVersion` 版本协商 | ✅ | `API_VERSION = 1` |
| 401 令牌失效 | ✅ | JWT 校验 → 401 → 安卓端重新配对横幅 |
