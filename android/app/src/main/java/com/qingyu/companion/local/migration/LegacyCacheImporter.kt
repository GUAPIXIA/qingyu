package com.qingyu.companion.local.migration

import androidx.sqlite.db.SupportSQLiteDatabase
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.domain.EntityPayloads
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.domain.MigrationIdentity

/**
 * 阶段 3 S3-02：旧伴侣缓存一次性迁移。
 *
 * 决策三选一（不得提供第四条路径）：
 * 1. [ImportAsLocalCopy] 导入为新的本地副本；
 * 2. [BackupAndSkip] 备份旧缓存后不导入；
 * 3. [AbortUpgrade] 退出升级，暂不启动新版。
 *
 * 无论选哪一条，新版都不再进入旧缓存浏览或远程聊天模式。
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
    val outboxDrafts: Int,
    val outboxReconciled: Int,
    val warnings: List<LegacyImportWarning>,
    val importedFrom: String = IMPORTED_FROM,
) {
    companion object {
        const val IMPORTED_FROM = "legacy_companion_cache"
    }
}

/** 只读扫描结果（由 [LegacyCacheReader.scan] 填充）。 */
data class LegacyCacheScan(
    val schemaVersion: Int = 0,
    val hasAnyData: Boolean = false,
    val characterCount: Int = 0,
    val sessionCount: Int = 0,
    val messageCount: Int = 0,
    val outboxUnsentCount: Int = 0,
    val outboxConfirmedCount: Int = 0,
    val missingLorebookIds: List<String> = emptyList(),
    val missingPresetIds: List<String> = emptyList(),
    val extraWarnings: List<String> = emptyList(),
)

/**
 * 旧 outbox 逐条分类（S3-02 硬要求）：
 * - [Reconciled] 已由 PC 确认（有 `remoteUserMessageId`）→ 与 PC 对账后转为正式消息；
 * - [Draft] 未发送或状态不确定 → 保留为「待用户处理的本地草稿」，不自动重发、不静默丢弃、
 *   也不当作已发送消息；
 * - [DiagnosticOnly] 已完成/已取消记录与任务 cursor、旧网络重试状态 → 只作为迁移诊断，
 *   不进入新运行时。
 */
sealed interface OutboxClassification {
    data class Reconciled(val requestId: String, val remoteUserMessageId: String) : OutboxClassification
    data class Draft(val requestId: String, val reason: String) : OutboxClassification
    data class DiagnosticOnly(val requestId: String, val note: String) : OutboxClassification
}

/**
 * 迁移向导纯逻辑（[evaluate]/[plan]/[classifyOutboxRow]）与真实导入（[importInto]）。
 * 纯逻辑部分不访问网络、不改写旧库；[importInto] 只从只读快照读取。
 */
class LegacyCacheImporter(private val reader: LegacyCacheReader? = null) {

    fun evaluate(scan: LegacyCacheScan): List<LegacyImportWarning> {
        val warnings = mutableListOf<LegacyImportWarning>()
        if (scan.hasAnyData) {
            warnings += LegacyImportWarning(
                "cache",
                "legacy",
                "旧缓存是 PC 投影，导入后仅为本地副本，不是完整权威数据",
            )
        }
        if (scan.schemaVersion !in LegacyCacheReader.SUPPORTED_VERSIONS) {
            warnings += LegacyImportWarning(
                "cache",
                "schema",
                "旧缓存 schema 版本 ${scan.schemaVersion} 未在 v1—v7 验证区间内",
            )
        }
        scan.missingLorebookIds.forEach {
            warnings += LegacyImportWarning("lorebook", it, "旧缓存中世界书详情缺失，导入后需从 PC 首次同步补齐")
        }
        scan.missingPresetIds.forEach {
            warnings += LegacyImportWarning("preset", it, "旧缓存中预设详情缺失，导入后需从 PC 首次同步补齐")
        }
        if (scan.outboxUnsentCount > 0) {
            warnings += LegacyImportWarning(
                "outbox",
                "unsent",
                "${scan.outboxUnsentCount} 条未确认发送将保留为本地草稿，不自动重发",
            )
        }
        scan.extraWarnings.forEach { warnings += LegacyImportWarning("cache", "scan", it) }
        return warnings
    }

    fun plan(
        scan: LegacyCacheScan,
        choice: LegacyImportChoice,
    ): LegacyImportResult = when (choice) {
        LegacyImportChoice.AbortUpgrade -> LegacyImportResult(
            choice = choice,
            importedCharacters = 0,
            importedSessions = 0,
            importedMessages = 0,
            outboxDrafts = scan.outboxUnsentCount,
            outboxReconciled = 0,
            warnings = evaluate(scan),
        )
        LegacyImportChoice.BackupAndSkip -> LegacyImportResult(
            choice = choice,
            importedCharacters = 0,
            importedSessions = 0,
            importedMessages = 0,
            outboxDrafts = 0,
            outboxReconciled = 0,
            warnings = evaluate(scan) + LegacyImportWarning("cache", "backup", "已要求备份旧缓存且不导入"),
        )
        LegacyImportChoice.ImportAsLocalCopy -> LegacyImportResult(
            choice = choice,
            importedCharacters = scan.characterCount,
            importedSessions = scan.sessionCount,
            importedMessages = scan.messageCount,
            outboxDrafts = scan.outboxUnsentCount,
            outboxReconciled = scan.outboxConfirmedCount,
            warnings = evaluate(scan),
        )
    }

    fun classifyOutboxRow(
        requestId: String,
        state: String,
        remoteUserMessageId: String?,
    ): OutboxClassification {
        val confirmed = !remoteUserMessageId.isNullOrBlank()
        return when {
            confirmed -> OutboxClassification.Reconciled(requestId, remoteUserMessageId!!)
            state == "completed" -> OutboxClassification.DiagnosticOnly(requestId, "已完成记录，仅迁移诊断")
            state == "cancelled" -> OutboxClassification.DiagnosticOnly(requestId, "已取消记录，仅迁移诊断")
            else -> OutboxClassification.Draft(requestId, "旧版本未确认发送（state=$state），保留为本地草稿")
        }
    }

    /**
     * 真正导入：从只读快照读取，逐实体写入新主库。
     *
     * - 保留原 ID；补默认值；标记 `importedFrom = legacy_companion_cache`。
     * - 若提供 PC migration genesis manifest 且同 ID + 同业务哈希，则继承共同 genesis
     *   （`origin = migration`，不生成独立并发版本）；离线独有内容才生成 Android 本地 dot。
     * - 调用方负责「失败即删除未提交的新主库」，不得 destructive fallback（阶段 3 §5 回滚）。
     */
    suspend fun importInto(
        db: SupportSQLiteDatabase,
        store: LocalStore,
        genesisManifest: Map<Pair<String, String>, String> = emptyMap(),
    ): LegacyImportResult {
        val scan = requireReader().scan(db)
        val warnings = evaluate(scan).toMutableList()

        val sessionColumns = requireReader().columnNames(db, "cached_sessions")
        val messageColumns = requireReader().columnNames(db, "cached_messages")
        val outboxColumns = requireReader().columnNames(db, "outbox_messages")

        // ---- 角色（先于会话，保证父实体存在） ----
        val characterIds = LinkedHashSet<String>()
        if ("characterId" in sessionColumns) {
            db.query("SELECT DISTINCT characterId, characterName FROM cached_sessions").use { c ->
                val idIndex = c.getColumnIndex("characterId")
                val nameIndex = c.getColumnIndex("characterName")
                val now = System.currentTimeMillis()
                while (c.moveToNext()) {
                    val id = if (idIndex >= 0) c.getString(idIndex) else null
                    if (id.isNullOrBlank()) continue
                    val name = (if (nameIndex >= 0) c.getString(nameIndex) else null)?.takeIf { it.isNotBlank() } ?: id
                    characterIds += id
                    val entity = LocalCharacterEntity(
                        id = id,
                        name = name,
                        importedFrom = LegacyImportResult.IMPORTED_FROM,
                        createdAt = now,
                        updatedAt = now,
                    )
                    store.importFromLegacy(
                        entityType = "character",
                        entityId = id,
                        genesisContentHash = genesisManifest["character" to id],
                        payload = { characterPayload(entity) },
                        // 顶层实体：角色没有父
                        parentId = null,
                        business = { store.importCharacter(entity) },
                    )
                }
            }
        }

        // ---- 会话 ----
        var importedSessions = 0
        val sessionIds = LinkedHashSet<String>()
        if (sessionColumns.isNotEmpty()) {
            db.query("SELECT id, characterId, title, createdAt, updatedAt FROM cached_sessions").use { c ->
                val idIndex = c.getColumnIndex("id")
                val charIndex = c.getColumnIndex("characterId")
                val titleIndex = c.getColumnIndex("title")
                val createdIndex = c.getColumnIndex("createdAt")
                val updatedIndex = c.getColumnIndex("updatedAt")
                while (c.moveToNext()) {
                    val id = if (idIndex >= 0) c.getString(idIndex) else null
                    if (id.isNullOrBlank()) continue
                    val characterId = if (charIndex >= 0) c.getString(charIndex)?.takeIf { it.isNotBlank() } else null
                    val title = if (titleIndex >= 0) c.getString(titleIndex) ?: "" else ""
                    val updatedAt = if (updatedIndex >= 0) c.getLong(updatedIndex) else System.currentTimeMillis()
                    val createdAt = if (createdIndex >= 0) c.getLong(createdIndex) else updatedAt
                    val entity = LocalSessionEntity(
                        id = id,
                        characterId = characterId,
                        title = title,
                        importedFrom = LegacyImportResult.IMPORTED_FROM,
                        createdAt = createdAt,
                        updatedAt = updatedAt,
                    )
                    store.importFromLegacy(
                        entityType = "session",
                        entityId = id,
                        genesisContentHash = genesisManifest["session" to id],
                        payload = { sessionPayload(entity) },
                        // 会话的父是角色（旧伴侣缓存里没有群会话，所以这里就是 characterId）
                        parentId = characterId,
                        business = { store.importSession(entity) },
                    )
                    sessionIds += id
                    importedSessions++
                }
            }
        }

        // ---- 消息 ----
        var importedMessages = 0
        if (messageColumns.isNotEmpty()) {
            val perSessionSeq = mutableMapOf<String, Long>()
            db.query(
                "SELECT id, sessionId, characterId, role, content, images, timestamp, translation, swipes, " +
                    "swipeIndex, replyToId, usage FROM cached_messages ORDER BY sessionId, timestamp ASC, id ASC",
            ).use { c ->
                val idIndex = c.getColumnIndex("id")
                val sessionIndex = c.getColumnIndex("sessionId")
                val characterIndex = c.getColumnIndex("characterId")
                val roleIndex = c.getColumnIndex("role")
                val contentIndex = c.getColumnIndex("content")
                val imagesIndex = c.getColumnIndex("images")
                val timestampIndex = c.getColumnIndex("timestamp")
                val translationIndex = c.getColumnIndex("translation")
                val swipesIndex = c.getColumnIndex("swipes")
                val swipeIndexIndex = c.getColumnIndex("swipeIndex")
                val replyToIndex = c.getColumnIndex("replyToId")
                val usageIndex = c.getColumnIndex("usage")

                while (c.moveToNext()) {
                    val id = if (idIndex >= 0) c.getString(idIndex) else null
                    val sessionId = if (sessionIndex >= 0) c.getString(sessionIndex) else null
                    if (id.isNullOrBlank() || sessionId.isNullOrBlank()) continue
                    if (sessionId !in sessionIds) continue
                    val logicalTime = if (timestampIndex >= 0) c.getLong(timestampIndex) else System.currentTimeMillis()
                    val seq = perSessionSeq.getOrDefault(sessionId, 0L)
                    perSessionSeq[sessionId] = seq + 1
                    val entity = LocalMessageEntity(
                        id = id,
                        sessionId = sessionId,
                        characterId = if (characterIndex >= 0) c.getString(characterIndex) else null,
                        role = if (roleIndex >= 0) c.getString(roleIndex) ?: "user" else "user",
                        content = if (contentIndex >= 0) c.getString(contentIndex) ?: "" else "",
                        imagesJson = if (imagesIndex >= 0) c.getString(imagesIndex) ?: "[]" else "[]",
                        replyToId = if (replyToIndex >= 0) c.getString(replyToIndex) else null,
                        swipesJson = if (swipesIndex >= 0) c.getString(swipesIndex) else null,
                        swipeIndex = if (swipeIndexIndex >= 0 && !c.isNull(swipeIndexIndex)) c.getInt(swipeIndexIndex) else null,
                        translation = if (translationIndex >= 0) c.getString(translationIndex) else null,
                        usageJson = if (usageIndex >= 0) c.getString(usageIndex) else null,
                        logicalTime = logicalTime,
                        seq = seq,
                        importedFrom = LegacyImportResult.IMPORTED_FROM,
                        createdAt = logicalTime,
                        updatedAt = logicalTime,
                    )
                    store.importFromLegacy(
                        entityType = "message",
                        entityId = id,
                        genesisContentHash = genesisManifest["message" to id],
                        payload = { messagePayload(entity) },
                        // 消息的父是它所属的会话
                        parentId = sessionId,
                        business = { store.importMessage(entity) },
                    )
                    importedMessages++
                }
            }
        }

        // ---- 旧 outbox 逐条分类 ----
        var drafts = 0
        var reconciled = 0
        if ("requestId" in outboxColumns) {
            val stateColumn = if ("state" in outboxColumns) "state" else "'queued'"
            val remoteColumn = if ("remoteUserMessageId" in outboxColumns) "remoteUserMessageId" else "NULL"
            db.query("SELECT requestId, $stateColumn AS state, $remoteColumn AS remote FROM outbox_messages").use { c ->
                val idIndex = c.getColumnIndex("requestId")
                val stateIndex = c.getColumnIndex("state")
                val remoteIndex = c.getColumnIndex("remote")
                while (c.moveToNext()) {
                    val requestId = if (idIndex >= 0) c.getString(idIndex) else null
                    if (requestId.isNullOrBlank()) continue
                    val state = if (stateIndex >= 0) c.getString(stateIndex) ?: "queued" else "queued"
                    val remote = if (remoteIndex >= 0) c.getString(remoteIndex) else null
                    when (val classification = classifyOutboxRow(requestId, state, remote)) {
                        is OutboxClassification.Reconciled -> {
                            reconciled++
                            warnings += LegacyImportWarning(
                                "outbox",
                                requestId,
                                "该记录已由 PC 确认（${classification.remoteUserMessageId}），迁移后按正式消息对账",
                            )
                        }
                        is OutboxClassification.Draft -> {
                            drafts++
                            warnings += LegacyImportWarning(
                                "outbox",
                                requestId,
                                "${classification.reason}，不自动重发",
                            )
                        }
                        is OutboxClassification.DiagnosticOnly -> {
                            warnings += LegacyImportWarning(
                                "outbox",
                                requestId,
                                "${classification.note}，不进入新运行时",
                            )
                        }
                    }
                }
            }
        }

        return LegacyImportResult(
            choice = LegacyImportChoice.ImportAsLocalCopy,
            importedCharacters = characterIds.size,
            importedSessions = importedSessions,
            importedMessages = importedMessages,
            outboxDrafts = drafts,
            outboxReconciled = reconciled,
            warnings = warnings,
        )
    }

    companion object {
        /**
         * 这三条 payload 此前在本文件里各有一份**自己的**规则，用的还是 Room 列名
         * （`exampleDialogueJson`/`lorebookId`/`lorebookIdsJson`/`logicalTime`/`seq`…）——
         * 也就是阶段 5 §2.1 已经给 `EntityPayloads` 修掉的那类缺陷，在**一次性迁移这条写路径上还在**。
         * 迁移是旧 Android 首次启动唯一的数据入口，走这条路的角色/会话/消息会拿到与仓储
         * 写出来的**不同** `contentHash`：同一份数据在本机内部就先自相矛盾，更不可能与 PC 一致。
         * 现在统一委派给 [EntityPayloads]，本文件不再保留第二份规则（金丝雀由
         * `SyncPayloadGoldenTest` 与 `local/domain` 的契约套件一起看着）。
         */
        fun characterPayload(entity: LocalCharacterEntity): Map<String, Any?> =
            EntityPayloads.characterPayload(entity)

        fun sessionPayload(entity: LocalSessionEntity): Map<String, Any?> =
            EntityPayloads.sessionPayload(entity)

        fun messagePayload(entity: LocalMessageEntity): Map<String, Any?> =
            EntityPayloads.messagePayload(entity)
    }

    private fun requireReader(): LegacyCacheReader = reader
        ?: throw IllegalStateException(
            "本 LegacyCacheImporter 无 reader；scan/importInto 请使用 LegacyCacheImporter(LegacyCacheReader(context))",
        )
}

/** 计算某条旧记录在导入时应继承的 genesis hash（若 manifest 中存在）。 */
fun genesisHashFor(
    manifest: Map<Pair<String, String>, String>,
    entityType: String,
    entityId: String,
): String? = MigrationIdentity.normalizeHash(manifest[entityType to entityId])
