package com.qingyu.companion.local.migration

/**
 * 阶段 3 S3-02：旧伴侣缓存一次性迁移决策。
 * 旧 `qingyu-companion-cache` 只读；新库独立；导入后标记 importedFrom。
 */
enum class LegacyImportChoice {
    ImportAsLocalCopy,
    BackupAndSkip,
    AbortUpgrade,
}

data class LegacyImportWarning(
    val entityType: String,
    val entityId: String,
    val message: String,
)

data class LegacyImportResult(
    val choice: LegacyImportChoice,
    val importedCharacters: Int,
    val importedSessions: Int,
    val importedMessages: Int,
    val warnings: List<LegacyImportWarning>,
    val outboxDrafts: Int,
    val importedFrom: String = "legacy_companion_cache",
)

/**
 * 只读扫描结果（由 Room 侧填充；此处为可测骨架）。
 */
data class LegacyCacheScan(
    val hasAnyData: Boolean = false,
    val characterCount: Int = 0,
    val sessionCount: Int = 0,
    val messageCount: Int = 0,
    val outboxUnsentCount: Int = 0,
    val missingLorebookIds: List<String> = emptyList(),
    val missingPresetIds: List<String> = emptyList(),
)

/**
 * 迁移向导纯逻辑：不访问网络，不改写旧库。
 */
class LegacyCacheImporter {
    fun evaluate(scan: LegacyCacheScan): List<LegacyImportWarning> {
        val warnings = mutableListOf<LegacyImportWarning>()
        if (scan.hasAnyData) {
            warnings += LegacyImportWarning(
                "cache",
                "legacy",
                "旧缓存可能是 PC 投影，导入后仅为本地副本，不是完整权威数据",
            )
        }
        scan.missingLorebookIds.forEach {
            warnings += LegacyImportWarning("lorebook", it, "旧缓存中世界书详情缺失")
        }
        scan.missingPresetIds.forEach {
            warnings += LegacyImportWarning("preset", it, "旧缓存中预设详情缺失")
        }
        if (scan.outboxUnsentCount > 0) {
            warnings += LegacyImportWarning(
                "outbox",
                "unsent",
                "${scan.outboxUnsentCount} 条未确认发送将保留为本地草稿，不自动重发",
            )
        }
        return warnings
    }

    fun plan(
        scan: LegacyCacheScan,
        choice: LegacyImportChoice,
    ): LegacyImportResult {
        return when (choice) {
            LegacyImportChoice.AbortUpgrade -> LegacyImportResult(
                choice = choice,
                importedCharacters = 0,
                importedSessions = 0,
                importedMessages = 0,
                warnings = evaluate(scan),
                outboxDrafts = scan.outboxUnsentCount,
            )
            LegacyImportChoice.BackupAndSkip -> LegacyImportResult(
                choice = choice,
                importedCharacters = 0,
                importedSessions = 0,
                importedMessages = 0,
                warnings = evaluate(scan) + LegacyImportWarning("cache", "backup", "已要求备份旧缓存且不导入"),
                outboxDrafts = 0,
            )
            LegacyImportChoice.ImportAsLocalCopy -> LegacyImportResult(
                choice = choice,
                importedCharacters = scan.characterCount,
                importedSessions = scan.sessionCount,
                importedMessages = scan.messageCount,
                warnings = evaluate(scan),
                outboxDrafts = scan.outboxUnsentCount,
            )
        }
    }
}
