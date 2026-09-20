# 安卓独立客户端与主动同步：阶段执行索引

> 状态：⚠️ 待处理  
> 总纲：[安卓独立客户端与主动同步重构总方案](../安卓独立客户端与主动同步重构总方案-2026-09-16.md)

## 1. 执行顺序

| 阶段 | 文档 | 状态 | 可并行关系 |
|---|---|---|---|
| 0 | [基线冻结与决策门](./阶段0-基线冻结与决策门实施方案.md) | 已完成 — [实施报告](../../报告/Android独立客户端重构阶段0实施报告.md)；API35 spike 通过，API26–31 真机待补 | 无 |
| 1 | [规范契约与仓储边界](./阶段1-规范契约与仓储边界实施方案.md) | 已完成 — [实施报告](../../报告/Android独立客户端重构阶段1实施报告.md) | 阶段 0 后 |
| 2 | [PC 写路径收口与变更日志](./阶段2-PC写路径收口与变更日志实施方案.md) | 待验收 — [报告](../../报告/Android独立客户端重构阶段2实施报告.md)；S2-01～S2-07 与原门禁已完成（20/20 同步域收口、崩溃恢复和回滚通过）。**新增 PCE-01 待补：PC 无感升级、无后台扫描/联网、核心旅程 smoke、同步关闭/空闲 A/B 性能、`needsFullRescan` 降级恢复。阶段 2/3/4/5 交织的工作区改动已随 **`047e093`**（2026-09-20）整体入库，**该提交尚未推送**。** | 可与阶段 3 并行 |
| 3 | [Android 独立数据与模型连接](./阶段3-Android独立数据与模型连接实施方案.md) | 待验收 — 收尾复核（2026-09-17）：**X25519 遗留已闭合**（软件 X25519 改为优先自带 BouncyCastle provider 实例，API 26/31/34 **无过滤全量 21/21**；门禁不再需要 class 过滤；ADR-010 已同步修订）。**剩余主要为真机环境项**：`app/schemas/...QingyuLocalDatabase/{1,2,3,4}.json` 已随 **`047e093`**（2026-09-20）入库（该提交同时收走阶段 2/3/4/5 交织的工作区改动，**尚未推送**）；Android 8/12/14 物理真机矩阵未跑（已无系统 provider 依赖风险）。原记录： [报告](../../报告/Android独立客户端重构阶段3实施报告.md)；S3-01～S3-07 全部实施（本地权威库 22 表、旧缓存只读快照迁移三选一、设置分区与 Keystore SecretRef、四类模型 MockWebServer 流式/取消/错误分类与 base URL 加固、连接档案 UI、本地优先启动向导、跨语言 repository 契约套件 0 差异、payload 2 MiB 上限）。门禁：JVM 单测 **588/588**、**API 26/31/34 三档 instrumentation 21/21**、`lintDebug` 0 Error、`assembleDebug`、`pnpm check`/`relay-server check` 全通过；本轮修复 API 26/27 通知渠道组启动崩溃（P0）。**遗留：旧连接/远程会话链路按阶段 9 清单整体删除，本中间状态不得发布；X25519 需在 API 26 实机复核并自带实现（见报告 §0.3）；工作区未提交** | 可与阶段 2 并行 |
| 4 | [Android 单聊生成闭环](./阶段4-Android单聊生成闭环实施方案.md) | 进行中 — [报告](../../报告/Android独立客户端重构阶段4实施报告.md)；**实机端到端走查完成**（关闭 PC 与 Relay 后建会话→两轮→重生成→编辑，全部有 mock 记录与 uiautomator 取证）；**S4-05 记忆事实核心已跨语言对齐**（解析/规范化/变更与提案/归档/去重上限/最近性/评分/预算/分层，30 组 fixture、Kotlin 侧 25 个模块，一致性用例 18/18）；实机累计修复 2 个单测抓不到的真 bug。门禁：真机 API 26/31/34 各 15 tests 全绿、Android 单测 696、lint 0、`pnpm test` 3006。**未完成：S4-05 余项（触发决策 + CAS 落盘 + 独立用量 + 记忆失效）、S4-06 快捷设置与 Compose 重组验证、S4-04 余项、`contextBuilder` 主装配**。前提：角色管理属阶段 5，阶段 4 验收以「已存在角色」为前提 | 阶段 1、3、5；使用阶段 0/1 冻结 fixture |
| 5 | [内容管理功能对齐](./阶段5-内容管理功能对齐实施方案.md) | 进行中 — [报告](../../报告/Android独立客户端重构阶段5实施报告.md)；完成提交 **`047e093`**（2026-09-20，阶段 5 收尾 + 阶段 2–5 工作区整体入库，**尚未推送**）。**已完成（下半程）**：Room v4（补 `lorebook_mapping_template`、`usage_clear_marker` 两张缺失同步实体表 + 角色卡/预设/人设/正则/快捷回复/用量字段）、规范 payload 层、`content/` 编解码（角色卡 V1/V2/V3 与 PNG chunk、预设 normalize、世界书 canonical v2 + 7 格式适配器 + 映射模板受限 DSL、正则兼容性与回溯预算、Backup V3 格式与安全边界、媒体先验后写）、S5-01 角色编辑竖切（VM+页面+路由+入口）、跨端 golden `shared/fixtures/cross-platform/content-io/`（TS 生成器 8/8）。**修两个 P0 跨端漂移**：Android journal 曾把 Room 列名写进信封（被 `character-payload.schema.json` 判非法、与 PC 哈希永不相等）；`settings_public`/`quick_reply_set` 记账粒度与 PC 不同（首次同步必产生伪冲突、角色级删除静默丢失）。另按 §11.3 单独立项修了 PC 缺陷：`charCard.ts` 导出基底 PNG 的 `IDAT` 长度字段写错，导致 PC 自己导出的 PNG 角色卡 PC 自己导不进去（`charCardPngBase.test.ts` 7/7 + 相关 PC 回归 61/61）。**门禁**：`:app:testDebugUnitTest` **1078 / 0 失败 / 0 跳过**、`lintDebug` **0 Error**、`assembleDebug` **通过**、`pnpm check` **通过**、`pnpm test` **3045 通过 / 4 跳过**（本轮 +2 条三跳链生成用例：预设 §2.13、角色卡 §2.14）、`relay-server check`+`test` **通过**；`pnpm lint` **失败 7 error**（逐条归属见报告 §3.1：`.qa-poc` 草稿、别的阶段未提交的 `electron/ipc/embedding.ts`、阶段 1/4 已提交文件，**本阶段改过的 PC 文件 0 错**）。**instrumentation 已跑**（Gradle Managed Devices，aosp x86_64）：API 26 **35/35**、API 34 **35/35**（其中一次全量跑遇到阶段 4 用例非确定性失败，报告 §5-F-1），**API 31 因 `adb install-multiple` 超时未跑成**（环境阻断，需更强宿主）。B-3 已闭合（`usage_clear_marker` 打包/恢复两侧此前**都没实现**，现补齐并有 3 例往返测试）。**八个内容能力入口已全部接通**（新增 `Routes.LOREBOOKS`/`QUICK_REPLIES`/`USAGE_INSIGHTS`/`BACKUP` 与 `BackupScreen`）。**§3 测试矩阵的 D-5①② 已闭合**：世界书的跨语言 golden 此前是「死 fixture」（只有生成它的 TS 自己读，Kotlin 侧一条断言都没落上），现已接活并新增阶段 0 的 28 份样本 golden，四道比对（检测/导入/报告/导出）两端各跑；备份的恢复回滚与单条目体积上限改成设备上真跑（API 26/34 各 4 条，含 64 MiB+1 解压实测不 OOM）。接活与真跑当场抓到 3 处缺陷并修复：原生 v1 导出丢书级未知字段、Risu 拒绝文案与 PC 不一致（PC 侧自相矛盾另立 D-7）、媒体落位失败发生在事务提交之后却把结果报成「已回滚」（现如实上报已应用的内容）。D-5② 的口径要读准：走的是**写边界失败**等价路径，真 ENOSPC 仍未模拟。D-5③ 压力矩阵也已跑（500 角色 / 100 世界书 / 1k 预设，API 26+34 各 4 条全绿），但方案原文的「每书 5k 条」与同步契约的 2 MiB 单条 payload 上限互斥——实测 5k 条 = 2,467,984 字节 > 2,097,152，`putLorebook` 直接被拒；三端常量同值（PC 与 Android 都有），属契约级冲突，已立案 D-8 待决策，实际验证档为每书 3,500 条。**§2 草稿区已补齐**（此前「自动保存写草稿区」这半句根本没做：草稿只活在 ViewModel 里，进程被回收就整篇丢失）。新增 `ContentDraftStore`（DataStore，键 `kind#entityId`）+ `ContentDraftCodec`（六个实体的**全列**快照；不用同步 payload，否则会静默丢掉只有本机才有的列）+ 300 ms 防抖写入器，六个编辑器全部接线；离开确认收成一份 `rememberEditorExitGuard`（返回箭头 / 系统返回键 / 取消三条出口共用一份判定）。设备用例 `ContentDraftAreaInstrumentedTest` **首跑 7 条全红**，从那次红里读出并修好 3 个真实缺陷：`startCreate` 的异步草稿恢复会盖掉用户正在写的内容；恢复出来的新建草稿 `dirty` 恒为假，于是**界面显示「已保存」而库里没有这一行**；`PresetEditorViewModel.startCreate` 用空名调 `PresetCodec.normalize`（后者对空名抛异常）——**「新建预设」一点就崩**。修完 API 34 / API 26 各 **7 tests / 0 失败**，角色走查那 3 条同步复跑仍全绿（中途它红过一次，原因是用例之间共享同一把 `new` 草稿键，属测试隔离问题不是产品缺陷，见报告 §2.12 末段）。**§3 三跳链补上预设一档**：新增 `preset-roundtrip.json`（PC 导入 → payload → 导出文件 → PC 再导入，4 例），Kotlin 侧 `PresetCodecGoldenTest#presetChainPcImportAndroidExportPcReimport` 读同一份 fixture 断言「Android 导入 == PC」「**Android 用生产代码 `EntityPayloads.presetPayload` 导出的 payload == PC 的 payload**」「Android 自己往返不变且 == PC 二次导入」——只测第一跳的话，导出写歪或再导入变味都能绿过去。实测 PC 自身往返 4 例全无损。同时量明剩下两档**不是没写而是没接口**：人设与正则在 PC 根本没有 import/export handler（只有 `list/save/delete`），矩阵那句对它们不适用；快捷回复的导入纯函数 `normalizeQuickReply` 未 `export`，且 Android 有意保留 PC 会丢的条目未知键，所以链子能接但**断言口径是决策**——连同 PC 正则 payload 的开放键差异一起记为 U-12，不假装关掉。**角色卡三跳链也已接上**（`character-card-roundtrip.json` + `CharacterCardChainGoldenTest` 4 条：语义档、**逐字节档**、反向不漂移档、以及「三张阶段 0 卡必须全部可导入且 PC 自身往返幂等」的防空跑档）。逐字节档红出来的真实差异是 Android 的 `org.json` 把 `/` 转义成 `\/` 而 `JSON.stringify` 不转义——同一张卡两端各导出一次会得到两份语义相同、字节不同的文件；已按「修写法不放宽断言」处理（JSON 与 PNG 的 `chara`/`ccv3` 段载荷同一口径）。**API 31（Android 12）这一档也跑通了**（`ContentDraftAreaInstrumentedTest` 7/0）：此前两次 `adb install-multiple` 超时是宿主空闲度问题，单独重跑即可。Compose 走查类同样在 API 31 通过（3/0，见报告 §3），所以「Android 8 / 12 / 14」这条矩阵行的 12 一格已填上；**但 12 那一格的全量套件跑出 2 个红，其中一个读出来是本轮自己带进去的回归**：§2.12 为「草稿恢复后保存」加的 `force`，配上角色编辑器「保存后不关页面」的状态，让连点两次保存产生两条 journal、版本向量推到 2（`CharacterEditorSaveIdempotenceInstrumentedTest` 在 API 34 上稳定复现，修法是保存成功后把 `characterId` 升到已落库的行 id）。**升级之后又带出第二个 bug**：成功回调里再算草稿键拿到的已是行 id，于是 `character#new` 槽没被清，下次进来会把已保存内容当未保存草稿恢复出来——是「幂等 + 走查 + 草稿区 11 条同跑」在 API 26 上抓到的（只跑同名用例漏掉），修完两档各 11/0；见报告 §2.16）。顺带一条此前没意识到的事实：走查用例里那个「一次」`OnClick` 语义动作，在该宿主下其实把 `save()` 调了两次——§2.11 那条「恰好一次变更」的绿，当时是靠 dirty 判定侥幸成立的，现在改由状态机加专门的幂等用例守。另补 §3「删除有引用资产的所有分支均有测试」的 7 条契约用例（按 grep 实测发现这些删除路径从来没被任何用例调用过，见报告 §2.15）。阶段 3/4 的迁移、备份与压力三类仍未在 API 31 跑过。**§2 草稿区的容量上限也补上了（U-11 关闭）**：单条取同步契约那个 2 MiB（`MigrationIdentity.MAX_PAYLOAD_BYTES`，不另发明一个数）、总量 4 条满额、**拒绝但不淘汰**（淘汰等于丢用户没保存的东西）、拒绝原因经 `onSkipped` 进六个编辑器已有的 error 文案、同值自动保存跳过整档重写；`put` 现在返回 `DraftWrite` 三态，判定放在 DataStore 写互斥内。**另外本轮有一次自我推翻要记**：先前把走查/探针读到的「版本向量 = 2」解释成「宿主把一次 `OnClick` 发了两次」，加上「这一行在 journal 里被记了几次」这个诊断后定案——journal 里那一行**只有一条**，2 是**设备全局 dot 计数**，所以那两条断言从一开始就在拿 dot 当每实体变更数用，此前的绿是执行顺序运气（谁后跑谁红，与档位无关）。改成 per-entity 条数口径后，探针+走查+草稿区+幂等 13 条在 **API 34 与 API 26 连跑各 13/0**；断言没有放宽（「一次保存一次变更」本就是 per-entity 陈述），而真实存在过的重复写由幂等用例单独守。（报告 §2.17）。**又按 §2 对着代码补了两处界面级要求**（报告 §2.18）：**世界书列表的搜索/分页下推到 SQL** —— 原来是全表 `SELECT *` 再在 VM 里 filter，而一本世界书的正文就是 MiB 级、压力口径 100 本；现在是 `searchLorebooks`/`countLorebooks` + LIMIT/OFFSET，Room 与内存替身跑同一张行为表（页内容、续页、末页、大小写、按来源格式命中的顺序）。**正则删除也走带影响范围的确认框**：引用计数为零是有依据的（本地库没有任何列存规则 id），所以不写「被 N 处引用」骗人，改说作用域/阶段/分组与「其余规则顺序不被重排」。写替身时踩到并记下一次 Kotlin 作用域坑：`buildString { forEach { .. } }` 里的 `forEach` 绑的是那个空 builder 而不是外层字符串，名字全折成空串、排序静默退化成插入序——是分页契约用例抓出来的。**预设列表的同一缺口也已补**（`searchPresets`/`countPresets` 下推 SQL + 搜索框 + 「加载更多（X / N）」，内建分区保持整份只读；契约用例跑 Room 与替身两遍，顺手钉住「替身用 lowercase() 而 SQL 的 COLLATE NOCASE 只折 A-Z」这类只在同表跑才露的差；报告 §2.19）。设备侧草稿区+走查+压力矩阵 14 条在 API 34 与 API 26 各 0 失败。人设/正则/快捷回复三个列表仍是全表读（量级小，且 §2 那句是条件式的）。**Compose 交互层首次上设备**（`createComposeRule` 从零到有）：中心页八条入口逐个可点已验证，并当场抓到一个「列表永远出不来」的真实缺陷——`rememberSkeletonVisible` 起表用墙上时间、停表用帧时钟，两个基准混用使最短展示判定恒真、骨架屏不消失（已修，见报告 §2.11）。**界面到仓储这一段已走通**（Compose 交互层首批用例，API 34/26 各 3 条全绿）：输入前保存不可点、 输入后真实键入进草稿、触发保存=恰好一次业务变更（版本向量 `"1"`、journal 有这条）、中心页八条入口逐个可点。 **§2「所有导入显示五类」本轮逐条数过**（报告 §2.20）：预设入口此前只报三类，且**一份角色卡 JSON 会被静默导入成一条「看着有内容」的空壳预设**（`name`/`description` 从卡上串过来、决定行为的提示词正文一格都没有，用例已把逐字段结果钉住），现按格式自有标记归入「跳过」，并补 `approximateNotes` 把钳位/取整/非数值回落/截断/非法枚举丢弃说出口；角色卡唯一的真实近似（`zTXt` 与压缩 `iTXt` 段两端都读不出）此前只活在 fixture 里，现由 `unreadTextChunkKeys` 进报告；世界书把「未知字段保留」提进表头，五类即使为 0 也印出；人设/正则是**没有导入入口**（PC 侧也没有 handler），该句对它们不适用。守卫只决定「导不导」不改「导成什么」，两端 `contentHash` 仍一致。**本轮设备侧未复跑**（改动在报告读数与文案，Room 路径未动）。 **未完成**：`保存` 按钮的真实触摸注入在本宿主下点不动（已实测排除键盘遮挡与视口外两种解释）， 「手指落在按钮上」仍要靠物理真机走查收口；其余三条走查里，删除影响确认与搜索滤行仍未落地（判因与分寸见报告 §2.11），排除了 4 种猜测，报告 §2.11 留了下一步切入点；其余未完成的实机走查、API 31 档、物理真机矩阵；新增 **U-11 草稿区没有容量上限**（Preferences DataStore 全量驻留内存、每次写整文件重写，接近 2 MiB 的世界书草稿会在键入期间被放大成持续 IO），需连同 D-8 一起决策；另有 4 项决策待签字（D-4 解绑语义、D-6 死引用删除、D-7 PC Risu 文案自相矛盾、D-8 每书 5k 条与 2 MiB payload 上限互斥）。另新修两处跨端缺陷：角色名纯空白时两端哈希不同（`ifBlank`→`ifEmpty`）、`iTXt` 压缩段两端读取不一致（决策：与 PC 逐字节对齐，PC 不解压本身另立缺陷单）。**2026-09-20 增补（报告 §2.21）**：`retrieval` 此前**从未进过运行时**——`ChatLorebookCompile` 的注释声称把 `retrieval` 映成 `matchMode`，代码却没读过该字段，`ChatLorebookRuntime.Entry` 里也没有对应属性。已把它如实带进运行时，并新增 `ChatLorebookChannels` 作为单一口径（`VECTOR_AVAILABLE` / `LEXICAL_AVAILABLE` 两个常量 + `SAME`/`APPROXIMATED`/`UNAVAILABLE`/`PC_DISABLED` 四档判定表，与 PC 的 `hasKeywordChannel` / `isSemanticDeadEntry` 逐条对齐），导入结果新增用户可见的「检索通道差异」一行。由此，「SillyTavern `vectorized: true` 且无 key → `semanticPreferred` → 本机静默不注入」这条路径第一次有了读数。**有意未按 `retrieval` 分流触发**（方案 §S6-05 的分级降级才是落点，且跨语言 golden 的 12 个用例没有一条带该字段），另立 **D-9** 记录 `semanticRequired` 两端相反与 S6-05 落地前必须先定的口径。新增 13 条单元用例（另把 `pnpm lint` 的 7 个 error 清零，统一门禁第一次全绿；Android 复跑单测 **1091/0**、`lintDebug` **0 Error**、`assembleDebug` 通过）。**设备矩阵同日复跑**：API 26 与 API 34 全量各 **59/0**（本轮改了世界书编辑器/列表，受影响的草稿区 7/0、压力矩阵 4/0 均复跑通过）；过程中定位并修掉一处**真机制**——`CharacterEditorViewModel.save()` 用调用时刻的 `characterId` 决定是否 force，导致「保存还在飞时再点一次」会重复记账，现加 `busy` 重入闸并把用例拆成两条确定性时序（单跑复跑均绿，此前那次绿是靠固定 sleep 的运气）。另曾把 API 26 全量的 `SQLiteDiskIOException(522)` 记成**设备档位**问题（`pixel2Api26` 实际用的是 `Nexus 5`，一度换成 Pixel 2 后 59/0），**第 5 轮已自我推翻**：同一 Pixel 2 档位又复现同样两条 522，档位不是差异变量、单次绿是巧合（撤回记录见报告 §3.2(2)）。 **设备三档自动化矩阵**：API 26 GMD 与 API 34 GMD 全量各 **59 条**、**API 31 走经典 AVD 路径 `connectedDebugAndroidTest --rerun` 全量 59/0**（GMD 那条路被安装插件写死的 `Timeout: PT2M` 挡住，两次都 `Finished 0 tests`；换路径后 1m4s 跑完 16 个类、逐类 0 失败）；其中 api26 的两条 522 与 api34 的 `Phase4AcceptanceWalkthroughInstrumentedTest`（阶段 4 时序脆弱）属**已知既有项**，两者单跑均通过。**2026-09-20 再增补（报告 §2.22 / §2.23）**：① 把 P1-d 的「诚实失败」那一半修了——`BackupV3.inspect` 改成按 `residentBudgetBytes`（`min(契约 1 GiB, (可用堆 − 源包) × 0.5)`）在解压中**先拒**，并用 `describeInspectFailure` 把 OOM 与「包损坏」分成两句（此前用户看到的是「ZIP 解析失败：Java heap space」，像是文件坏了）；**能力层仍未修**：恢复大于驻留预算的合法备份要改 `Preview.entries` 的整包驻留接口形状。② 修掉一处 **P0**：`message`/`session` 的同步 payload 在**三条写路径上**（仓储、`LegacyCacheImporter` 一次性迁移、`FakeLocalStore` 替身）发的都是 Room 列名（`logicalTime`/`seq`/`swipesJson`/`lorebookIdsJson`），而契约要求 `timestamp`/`swipes`(数组)/`lorebookIds` 并禁止额外键——两端哈希**永远不相等**，而消息是同步量最大的实体（§12 基线 100 万条）。现统一到 `EntityPayloads.messagePayload`/`sessionPayload` 并新增两组跨端 fixture（PC 为 oracle）。仍缺 message 的 `speakerKind`/`generationKind`/`narrativeMode` 三列（属阶段 6 S6-01），已**逐键登记**在 `SyncPayloadGoldenTest`。门禁复跑：Android 单测 **1099/0**、`lintDebug` 0 Error、`pnpm test` **3047**。**另请注意 §3.2「(2)」**：api26 全量套件的间歇 522 先前被我记成「已用设备档位 A/B 定位」，第 5 轮已**自我推翻并撤回**（同档位再次复现；单次绿是巧合）。阶段 7 前置（阶段 2 含 PCE-01 + 3 + 4 + 5）因此**仍未满足** | 阶段 3、4 后 |
| 6 | [群聊与平台扩展对齐](./阶段6-群聊与平台扩展对齐实施方案.md) | 未开始 | 可与阶段 7 后半并行 |
| 7 | [同步核心与局域网同步](./阶段7-同步核心与局域网同步实施方案.md) | 未开始 | 阶段 2（含 PCE-01）、3、4、5 后 |
| 8 | [服务器同步与端到端加密](./阶段8-服务器同步与端到端加密实施方案.md) | 未开始 | 阶段 7 后 |
| 9 | [一次性迁移、旧链路删除与发布](./阶段9-迁移灰度与旧链路退场实施方案.md) | 未开始 | 阶段 6、8 后 |

## 2. Agent 领取任务模板

把下面内容与目标阶段文档一并交给执行 Agent：

```text
你负责《安卓独立客户端与主动同步》阶段 N。
先完整阅读总方案、阶段 N 实施方案、其前置阶段报告和相关现有代码。
只实现阶段文档列出的任务 ID，不提前实现后续阶段；旧伴侣链路只能按阶段 9 清单整体删除，不能零散保留或提前删到不可迁移。
本项目以 Android 重构为主。除阶段文档明确要求外，不改 PC 页面、交互、快捷键、提示词或模型配置体验；涉及 PC/共享层的改动必须补 PC 兼容性与性能证据。
保留工作区中不属于你的修改；若目标文件已有重叠修改，先报告冲突。
每完成一个任务同时补测试；最后执行阶段门禁，生成 docs/报告/ 对应实施报告，
并回写本执行索引中的状态、提交哈希、测试结果和遗留项。
不得以 TODO、mock UI、跳过测试或仅编译通过作为完成。
```

## 3. 阶段报告模板

```markdown
# Android 独立客户端重构阶段 N 实施报告

> 日期：YYYY-MM-DD
> 基线提交：...
> 完成提交：...
> 结论：通过 / 未通过

## 已完成任务
| 任务 ID | 产物 | 证据 |

## 契约或迁移变化

## 测试命令与结果
| 命令 | 结果 | 日志/产物 |

## 未完成与阻断

## 回滚方法

## 下一阶段输入
```

## 4. 看板维护规则

- 状态只用：未开始、进行中、阻断、待验收、已完成。
- “已完成”必须链接阶段报告；没有报告只能是“待验收”。
- 阻断项写明责任阶段和解除条件，不把设计问题留给后续 Agent 猜测。
- 契约、schema 或迁移发生变化时，必须列出兼容范围和 fixture 版本。
- 阶段 9 完成并经过观察期后，本目录与总方案移入 `方案/归档/`。
