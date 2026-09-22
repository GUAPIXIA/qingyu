package com.qingyu.companion.content

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 阶段 5：**内容层接线审计**（与 `ChatBuilderWiringAuditTest` 同一思路，覆盖面换成内容管理）。
 *
 * ## 为什么需要它
 * 「功能在、接线不在」是本仓反复出现的缺陷类型，而且**编译期与常规门禁都不会报错**
 * （开发环境备忘 §5-3 把它列为高发项）：实现存在、单测全绿、跨端 golden 也对，
 * 但没有任何生产代码调用它。历史上 `recordUsage`、世界书检索/渲染、会话预设、会话人设
 * 都栽在这上面；阶段 5 交付了八个内容编辑器、草稿区、媒体导入闸门、备份编排与用量分析，
 * 它们是同类风险的下一批候选。
 *
 * 本审计用三组机械检查把「接线」钉住：
 * 1. **能力 → 生产调用方**：清单里每一项都必须被**至少一个别的**生产文件引用；
 * 2. **中心页八条入口 → 非空回调 → 目标路由有落点**：三者缺一即「界面在、点不动」；
 * 3. **同步 payload 只能由 `EntityPayloads` 产出**：见 `syncPayloadsComeFromTheSharedConstructors`。
 *
 * 尚未接线的能力登记在 [notWiredYet] 里并写明原因与归属阶段；**接上之后必须删除该条目**
 * （腐烂检查会失败），这样清单不会变成免责声明。
 */
class ContentWiringAuditTest {

    // ---------------------------------------------------------------- 基础设施

    private val roots = listOf(
        "src/main/java/com/qingyu/companion",
        "app/src/main/java/com/qingyu/companion",
        "src/test/java/com/qingyu/companion",
        "app/src/test/java/com/qingyu/companion",
    )

    private fun sourceOf(relative: String): File = roots
        .map { File("$it/$relative") }
        .firstOrNull { it.exists() }
        ?: error("找不到源文件 $relative（工作目录=${File(".").absolutePath}）")

    private fun productionFiles(): List<File> {
        val dir = listOf("src/main/java/com/qingyu/companion", "app/src/main/java/com/qingyu/companion")
            .map(::File)
            .firstOrNull { it.isDirectory }
            ?: error("找不到 Android 主源码目录（工作目录=${File(".").absolutePath}）")
        return dir.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    }

    private fun filesMentioning(symbol: String): List<File> {
        val pattern = Regex("\\b$symbol\\b")
        return productionFiles().filter { pattern.containsMatchIn(it.readText()) }
    }

    // ---------------------------------------------------------------- 1. 能力 → 生产调用方

    /**
     * 阶段 5 交付的能力 → 它为什么值得被审计（写成人话，便于读失败信息时判断）。
     *
     * 判据是「被 ≥2 个生产文件提到」= 声明处 + 至少一个调用方。不写死「声明文件是哪个」，
     * 免得清单里一处路径笔误就让审计变成空跑。
     */
    private val capabilities: Map<String, String> = mapOf(
        "MediaImportGate" to "媒体先解码后落盘（S5-01 头像/背景、S6-02 附件都靠它）",
        "ContentDraftStore" to "编辑器草稿区（S5-02 自动保存）",
        "ContentDraftCodec" to "草稿行编解码（全列快照）",
        "ContentDraftAutosaver" to "草稿防抖写入器",
        "rememberEditorExitGuard" to "六个编辑器共用的离开确认",
        "BackupOrchestrator" to "Backup V3 打包与恢复编排（S5-08）",
        "BackupV3" to "Backup V3 格式与安全边界（S5-08）",
        "RegexCompatibility" to "正则兼容性判定与回溯预算（S5-05）",
        "QuickReplyPolicy" to "快捷回复命令可用性（S5-06）",
        "ContentSettingsSection" to "内容管理相关设置分区（S5-07）",
        "UsageInsightsViewModel" to "用量分析与清理（S5-07）",
        "CharacterCardCodec" to "角色卡 V1/V2/V3 与 PNG 编解码（S5-01）",
        "PresetCodec" to "预设 normalize/导入导出（S5-03）",
        "LorebookImportExport" to "世界书多格式导入导出（S5-02）",
        "LorebookMappingTemplates" to "世界书映射模板（S5-02）",
        "ChatLorebookChannels" to "世界书触发通道差异读数（S5-02 收口 / S6-05 前置）",
        "ChatLorebookCompile" to "canonical 文档 → 运行时条目（世界书是否真的生效）",
        "ChatLorebookRuntime" to "世界书运行时触发管线",
    )

    /**
     * 尚未接线的能力 → 原因与归属阶段。
     * **不是免责声明**：接上之后必须删条目，否则 [deferredEntriesAreNotStale] 会红。
     */
    private val notWiredYet: Map<String, String> = mapOf(
        "ChatEmbeddingPolicy" to "判定层已按 fixture 锁定，但 Android 尚无嵌入通道：属阶段 6 §S6-05",
        "ChatLorebookEmbedding" to "语义索引文档构造：等待阶段 6 §S6-05 的嵌入通道",
        "ChatVector" to "向量检索纯函数：等待阶段 6 §S6-05 的嵌入通道",
    )

    @Test
    fun everyDeliveredCapabilityHasAProductionCaller() {
        assertTrue("能力清单不能空跑（至少 15 项）", capabilities.size >= 15)
        val unwired = mutableListOf<String>()
        for ((symbol, why) in capabilities) {
            if (filesMentioning(symbol).size >= 2) continue
            if (notWiredYet.containsKey(symbol)) continue
            unwired += "$symbol（$why）"
        }
        assertTrue(
            "以下能力只在 1 个生产文件里出现，等于「功能在、接线不在」：\n" +
                unwired.joinToString("\n") +
                "\n要么接上调用方，要么在 notWiredYet 里写明原因与归属阶段。",
            unwired.isEmpty(),
        )
    }

    @Test
    fun deferredEntriesAreNotStale() {
        assertTrue("未接线清单不能空跑", notWiredYet.isNotEmpty())
        for ((symbol, reason) in notWiredYet) {
            assertTrue("$symbol 的原因必须写清楚（含归属阶段）", reason.length >= 10)
        }
        // 「尚未接线」的判据必须是「**簇外**没有任何生产文件引用」：
        // 这三个模块彼此互调（纯函数拆层），所以数「出现几次」会把它们判成已接线。
        val cluster = notWiredYet.keys
        val pattern = Regex("\\b(${cluster.joinToString("|")})\\b")
        val outsiders = productionFiles()
            .filter { it.nameWithoutExtension !in cluster }
            .filter { pattern.containsMatchIn(it.readText()) }
            .map { it.name }
        assertTrue(
            "notWiredYet 里的模块已经被簇外的生产文件引用了（${outsiders.joinToString()}），" +
                "说明它们其实已经接线，请从清单删除——否则清单会腐烂成免责声明",
            outsiders.isEmpty(),
        )
    }

    // ---------------------------------------------------------------- 2. 中心页可达性

    /**
     * 内容中心八条入口必须「界面在 + 回调非空 + 目标路由有落点」。
     *
     * `ContentHubScreen` 的后六个回调都有默认值 `null`——也就是说**不传也能编译**，
     * 那一行会渲染出来但点不动。这正是「界面在、功能不在」，因此这里逐个要求
     * 导航宿主传入非空实现，并且目标路由确实注册了 composable。
     */
    @Test
    fun contentHubEntriesAreAllReachable() {
        val wiring = mapOf(
            "onOpenCharacters" to "Routes.CHARACTER_MANAGER",
            "onOpenRegex" to "Routes.REGEX",
            "onOpenLorebooks" to "Routes.LOREBOOKS",
            "onOpenPresets" to "Routes.PRESETS",
            "onOpenPersonas" to "Routes.PERSONAS",
            "onOpenQuickReplies" to "Routes.QUICK_REPLIES",
            "onOpenUsageInsights" to "Routes.USAGE_INSIGHTS",
            "onOpenBackup" to "Routes.BACKUP",
        )
        assertTrue("八条入口一条都不能少", wiring.size == 8)
        val hub = sourceOf("ui/content/ContentHubScreen.kt").readText()
        val nav = sourceOf("ui/navigation/CompanionNavHost.kt").readText()

        for ((callback, route) in wiring) {
            assertTrue(
                "中心页里的 $callback 必须真的挂在一个 HubRow 的 onClick 上（否则那一行点不动）",
                Regex("onClick\\s*=\\s*$callback\\b").containsMatchIn(hub),
            )
            assertTrue(
                "导航宿主必须给 $callback 传**非空**实现（它有 null 默认值，不传也能编译，但那一行就废了）",
                Regex("$callback\\s*=\\s*\\{\\s*navController\\.navigate\\($route\\)").containsMatchIn(nav),
            )
            assertTrue(
                "$route 必须有对应的 composable 落点（否则点了无处可去）",
                Regex("composable\\($route\\)").containsMatchIn(nav),
            )
        }
    }

    // ---------------------------------------------------------------- 3. 同步 payload 收口

    /**
     * 同步 payload 只能由 `EntityPayloads` 的构造函数产出。
     *
     * 这条守卫直接来自 2026-09-20 的三次修复（报告 §2.23/§2.24）：`message`/`session`/`group`
     * 的 payload 曾在**三条写路径**（仓储、一次性迁移、测试替身）上各有一份「Room 列名版」副本，
     * 三份**彼此一致地错**——契约套件比的是「两端是否相同」，所以它抓不到；
     * 而结果是两端 `contentHash` 永不相等（消息还是同步量最大的实体）。
     *
     * 机械判据：这三条写路径必须委派给 `EntityPayloads.*Payload`，且**不得**再出现
     * 「把 Room 列名当 payload 键」的写法（`"xxxJson" to …`）。
     */
    @Test
    fun syncPayloadsComeFromTheSharedConstructors() {
        val writePaths = listOf(
            "local/domain/RoomLocalSyncRepository.kt",
            "local/migration/LegacyCacheImporter.kt",
            "local/testing/FakeLocalStore.kt",
        )
        val roomColumnKeys = listOf(
            "characterIdsJson", "lorebookIdsJson", "swipesJson", "imagesJson", "usageJson",
            "logicalTime", "exampleDialogueJson", "extensionsJson", "boundLorebookIdsJson",
        )
        for (path in writePaths) {
            val text = sourceOf(path).readText()
            assertTrue(
                "$path 必须委派给 EntityPayloads 的 payload 构造函数（不许再自带一份规则）",
                Regex("EntityPayloads\\.\\w+Payload").containsMatchIn(text),
            )
            val offenders = roomColumnKeys.filter { Regex("\"$it\"\\s+to\\b").containsMatchIn(text) }
            assertTrue(
                "$path 里又出现了「把 Room 列名当 payload 键」的写法：$offenders\n" +
                    "这正是 §2.23/§2.24 修掉的那类缺陷（两端哈希永不相等），请改用 EntityPayloads。",
                offenders.isEmpty(),
            )
        }
    }

    // ---------------------------------------------------------------- 4. 未迁移能力的提示链

    /**
     * 未迁移能力必须**继续**留下可行动提示，而且提示要被界面消费。
     *
     * 「静默返回空值」会让用户分不清「真的没有」和「还没做」（`LocalChatRepository` 里
     * 自己写着这句话）；而即使 `notMigrated` 写了提示，只要没人 `collect` 那个 StateFlow，
     * 它就等于不存在——那又是一次「提示在、界面不在」。
     *
     * 阶段 6 S6-01b/S6-01d 起**群聊数据面与群生成闭环已本地迁移**（列表/会话/消息/成员/翻译/AI 回复），
     * 仍在 notMigrated 名单里的只剩公告/版本（S6-07）：
     * 本测试把两头都钉住——剩余未迁移能力必须走 notMigrated（不得静默返回空值），
     * 已迁移的群能力**不得**再退回 notMigrated（把「已经做了」伪装回「还没做」同样是撒谎）。
     */
    @Test
    fun unmigratedCapabilitiesKeepAnActionableNoticeThatTheUiConsumes() {
        val repository = sourceOf("data/local/LocalChatRepository.kt").readText()
        assertTrue(
            "未迁移能力必须走 notMigrated 并写入提示（不得静默返回空值）",
            repository.contains("private fun <T> notMigrated(") &&
                repository.contains("unsupported.value ="),
        )
        for (capability in listOf("公告", "版本信息")) {
            assertTrue(
                "能力「$capability」在本地模式下必须显式走 notMigrated（属阶段 6 §S6-07），" +
                    "静默返回空值会让用户分不清「真的没有」和「还没做」",
                repository.contains("notMigrated(\"$capability\""),
            )
        }
        // 已迁移能力反向守卫：群数据面走真实现后不得回退成 notMigrated
        for (capability in listOf("群聊列表", "群聊成员添加", "群聊翻译", "新建群聊", "群聊 AI 回复")) {
            assertTrue(
                "能力「$capability」已随 S6-01b 本地迁移，不得再走 notMigrated 伪装成「还没做」",
                !repository.contains("notMigrated(\"$capability\""),
            )
        }
        val viewModel = sourceOf("ui/chat/ChatViewModel.kt").readText()
        assertTrue(
            "unsupportedNotice 必须被界面消费，否则「可行动提示」等于不存在",
            viewModel.contains("unsupportedNotice"),
        )
    }
}
