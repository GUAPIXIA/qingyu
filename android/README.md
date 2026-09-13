# 轻语安卓伴侣端（qingyu-companion）

PC 端「轻语」的安卓伴侣端：**只做远程连接与对话消费，不做本地 AI 对话**。

过程与阶段记录见归档文档 [安卓端优化实施进展报告](../docs/已移除/安卓端优化实施进展报告-2026-08-29.md)；能力以本 README 与 [CHANGELOG.md](CHANGELOG.md) 为准。

## 版本

当前版本 **0.3.0**（build 9，Android **独立版本线**，自 0.2.0 起不再跟随 PC 版本号）。

- 权威来源：`gradle/libs.versions.toml` 中 `appVersionName` / `appVersionCode`
- 发版时同步更新 [CHANGELOG.md](CHANGELOG.md)

## 构建

前置：JDK 17+、Android SDK（compileSdk 34 / build-tools 34）。

```bash
# 在 android/ 目录
./gradlew assembleDebug        # Windows: .\gradlew.bat assembleDebug
./gradlew testDebugUnitTest    # 运行 JVM 单测
```

`local.properties` 需指向本机 SDK（gitignore 已忽略）：

```
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

## 能力概览（对齐 0.3.0）

### 连接与配对

- **双通道连接卡**：局域网直连 + Relay 服务器中转（二维码 / 8 位连接码 / PC 审批等待）
- 扫码配对（ZXing v2 二维码：一次性配对码 + 有效期）+ 手动主机/端口 + 已配对设备管理
- mDNS 自动发现 `_qingyu._tcp`；多端点自动回退；连接协调器（断线退避、候选并发探测）
- 可操作的连接错误提示（断网 / 超时 / 端口 / DNS / TLS / 配对码失效 / 审批超时等）
- 设置同步 v2（逐行「保存中/已同步/失败重试/与 PC 冲突」）
- Relay：HTTPS/WSS URL 统一策略、Access/Refresh Token 分键加密、单飞刷新
- 401 令牌失效横幅；已配对冷启动直达会话区；通知点击直达

### 对话消费

- 单聊：流式接收、停止生成、历史分页、发送中/失败重试、断线自动重发（幂等 requestId）
- 长按操作：复制 / 编辑 / 删除 / 翻译 / 重新生成 / 朗读 / 引用回复
- swipe 候选、快捷回复条、聊天时间线与用量展示
- 图片消息（Coil）、TTS 音频流（ExoPlayer / Media3）
- `<thought>` 心理描写折叠；供应商推理标签丢弃（对齐 PC）
- Markdown 渲染；`contentRenderMode='blocks'` 消费 PC 语义分块契约（`RoleplayBlocks.kt` 等价移植）；旧消息安全回退 Markdown
- 收尾状态消费（`generationNotice` / `generationError`，Room 缓存 v7）；方向卡片点选回填
- 群聊消费与 PC 桥接协议对齐（点名 / 轮询 / 自由发言结构）

### 其它

- 用量统计、公告同步、检查更新（公告服务器版本字段）
- 离线只读：Room 缓存最近会话
- 主题 / 字号 / 间距本地设置

### 暂未支持

- 生图指令：`/imagine` 仍由 PC 渲染层解析；图片结果展示能力已就绪
- 媒体通道走公网 Relay：当前 Relay 媒体通道保持关闭

## 目录

```
app/src/main/java/com/qingyu/companion/
├── model/      # DTO（对齐 shared/types.ts）+ WS 事件 + 消息合并
├── network/    # Retrofit/OkHttp + WebSocket + 连接协调器 + mDNS
├── data/       # Room 缓存、DataStore、仓库、DI
└── ui/         # Compose 页面（连接 / 会话 / 设置 / 公告 / 用量）
```

## 协议要点

- API 版本协商：`/api/v1/server/info` → `apiVersion`（当前 `API_VERSION = 1`）
- 媒体 / 头像：桥接层 `/static/...` 白名单静态路由
- TTS：`GET /sessions/{sid}/messages/{mid}/tts`（支持 Range）
- 完整路由以 PC 侧 `electron/bridge/` 与 `docs/方案/局域网与服务器双通道连接实施文档.md` 为准

## 相关文档

- 变更：[CHANGELOG.md](CHANGELOG.md)
- 双通道：[局域网与服务器双通道连接方案](../docs/方案/局域网与服务器双通道连接方案.md)
- 文档索引：[docs/README.md](../docs/README.md)
