package com.qingyu.companion.chatcore

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-05：长记忆结构化事实核心
 * （对齐 `shared/chat-core/memory.ts` 的解析 / 规范化 / 变更应用部分）。
 *
 * 模型按结构化格式输出：
 * ```
 * 【当前状态】…
 * 【时间线】…（或【摘要】）
 * 【事实】
 * 1. …
 * 【事实变更】[…]
 * 【事实提案】[…]
 * ```
 * 本模块负责解析并做兜底（模型不按格式输出时），以及把增量变更/语义提案应用到事实集合。
 *
 * 与 PC 一致的要点：
 * - 未包含【事实变更】段时为 `undefined`（不改变既有事实）；包含但格式无效时为 `null`
 *   ——调用方必须保留旧事实，避免「解析失败即清空记忆」；
 * - 未知 ID 的变更一律忽略；替代/停用的事实移入 history，**绝不参与后续上下文或向量检索**；
 * - 事实身份匹配键固定为 subject + predicate + scope + entityId，模型无法越权修改
 *   同名但不同作用域的事实；
 * - 事实上限 [MAX_MEMORY_FACTS]，超限时按 importance → confidence → updatedAt 保留最优。
 */
object ChatMemoryFacts {

    /** 事实列表上限（防止无限累积）。 */
    const val MAX_MEMORY_FACTS = 30

    /** 历史事实只用于审计，保留最近记录以避免会话元数据无限增长。 */
    const val MAX_MEMORY_FACT_HISTORY = 200

    /** 文本事实与结构化事实的统一表示（对应 PC 的 `string | MemoryFact`）。 */
    sealed interface FactRecord {
        data class TextFact(val text: String) : FactRecord

        data class Structured(
            val id: String,
            val subject: String,
            val predicate: String,
            val value: String,
            /** active | inactive | superseded */
            val status: String = "active",
            /** 1..5 */
            val importance: Int = 3,
            /** 0..1 */
            val confidence: Double = 0.8,
            val scope: String? = null,
            val entityId: String? = null,
            val sourceMessageIds: List<String> = emptyList(),
            /** null = 缺省（对应 JS undefined），缺失时用调用方传入的 updatedAt 兜底 */
            val updatedAt: Long? = null,
        ) : FactRecord
    }

    /**
     * 事实的持久化序列化（S4-05）。**必须无损往返**：这是用户长期记忆的唯一副本，
     * 任何字段丢失都不可恢复。`null` 与缺省在这里不做区分（读取端一律按缺省处理），
     * 但 `TextFact` 与 `Structured` 用 `kind` 显式区分，避免「看起来像对象的文本事实」被误读。
     */
    fun factsToJson(facts: List<FactRecord>): String {
        val array = org.json.JSONArray()
        for (fact in facts) {
            when (fact) {
                is FactRecord.TextFact -> array.put(
                    org.json.JSONObject().put("kind", "text").put("text", fact.text),
                )
                is FactRecord.Structured -> array.put(
                    org.json.JSONObject()
                        .put("kind", "structured")
                        .put("id", fact.id)
                        .put("subject", fact.subject)
                        .put("predicate", fact.predicate)
                        .put("value", fact.value)
                        .put("status", fact.status)
                        .put("importance", fact.importance)
                        .put("confidence", fact.confidence)
                        .put("scope", fact.scope ?: org.json.JSONObject.NULL)
                        .put("entityId", fact.entityId ?: org.json.JSONObject.NULL)
                        .put("sourceMessageIds", org.json.JSONArray(fact.sourceMessageIds))
                        .put("updatedAt", fact.updatedAt ?: org.json.JSONObject.NULL),
                )
            }
        }
        return array.toString()
    }

    /** 反序列化单条事实；无法识别的形状返回 null（由调用方决定是否视为损坏）。 */
    fun factRecordFromJson(raw: JSONObject): FactRecord? {
        val kind = raw.optString("kind")
        if (kind == "text") {
            val text = raw.optString("text")
            return text.takeIf { it.isNotEmpty() }?.let { FactRecord.TextFact(it) }
        }
        // 兼容无 kind 的旧形状：有 subject 视为结构化事实
        val subject = raw.optString("subject")
        if (kind != "structured" && subject.isEmpty()) return null
        val ids = raw.optJSONArray("sourceMessageIds")
        val sourceIds = if (ids == null) {
            emptyList()
        } else {
            (0 until ids.length()).map { ids.optString(it) }.filter { it.isNotEmpty() }
        }
        return FactRecord.Structured(
            id = raw.optString("id"),
            subject = subject,
            predicate = raw.optString("predicate"),
            value = raw.optString("value"),
            status = raw.optString("status").ifEmpty { "active" },
            importance = if (raw.has("importance")) raw.optInt("importance", 3) else 3,
            confidence = if (raw.has("confidence")) raw.optDouble("confidence", 0.8) else 0.8,
            scope = raw.optStringOrNull("scope"),
            entityId = raw.optStringOrNull("entityId"),
            sourceMessageIds = sourceIds,
            updatedAt = if (raw.isNull("updatedAt")) null else raw.optLong("updatedAt"),
        )
    }

    /** 模型给出的结构化事实（add 用）。 */
    data class FactPayload(
        val subject: String,
        val predicate: String,
        val value: String,
        val importance: Double? = null,
        val confidence: Double? = null,
        val scope: String? = null,
        val entityId: String? = null,
    )

    /** 增量事实变更。 */
    sealed interface FactChange {
        data class Add(val fact: FactPayload) : FactChange

        data class Update(val id: String, val patch: FactPatch) : FactChange

        data class Deactivate(val id: String) : FactChange
    }

    data class FactPatch(
        val subject: String? = null,
        val predicate: String? = null,
        val value: String? = null,
        val importance: Double? = null,
        val confidence: Double? = null,
        val scope: String? = null,
        val entityId: String? = null,
    ) {
        fun isEmpty(): Boolean =
            subject == null && predicate == null && value == null &&
                importance == null && confidence == null && scope == null && entityId == null
    }

    /** 语义提案：模型只给 subject/predicate(/scope/entityId)，ID 由服务端匹配。 */
    data class FactProposal(
        val subject: String,
        val predicate: String,
        /** clear 时归一化为空串 */
        val value: String,
        /** set | clear */
        val changeType: String,
        val scope: String? = null,
        val entityId: String? = null,
        val importance: Double? = null,
        val confidence: Double? = null,
    )

    data class ParsedMemory(
        /** 最近情节的即时状态：场景、地点、进行中的目标等。 */
        val currentState: String,
        /** 长期时间线摘要（兼容旧会话的 summary 字段）。 */
        val summary: String,
        val facts: List<String>,
        /** null = 段存在但格式无效（调用方须保留旧事实）；缺省表示未包含该段。 */
        val factChanges: List<FactChange>? = null,
        val factChangesPresent: Boolean = false,
        val factProposals: List<FactProposal>? = null,
        val factProposalsPresent: Boolean = false,
    )

    // ---------------------------------------------------------------- 解析

    /**
     * 解析模型输出的结构化记忆文本。
     * - 剥离 `<thought>` 思考标签；
     * - 【当前状态】/【时间线】（或【摘要】）/【事实】分段；
     * - 兜底：无【摘要】标记且无【当前状态】时把全文（去掉【事实…】部分）作为摘要。
     */
    fun parseMemoryResult(text: String?): ParsedMemory {
        val cleaned = stripAllThinking(text ?: "")
        if (cleaned.isEmpty()) return ParsedMemory(currentState = "", summary = "", facts = emptyList())

        // 用 \z 而非 $：Java 的 $ 会匹配「结尾换行之前」，与 JS 的 $ 不等价
        val currentStateMatch = regex("【当前状态】([\\s\\S]*?)(?=【(?:时间线|摘要|事实|事实变更|事实提案)】|\\z)").find(cleaned)
        val timelineMatch = regex("【时间线】([\\s\\S]*?)(?=【(?:事实|事实变更|事实提案)】|\\z)").find(cleaned)
        val summaryMatch = regex("【摘要】([\\s\\S]*?)(?=【(?:事实|事实变更|事实提案)】|\\z)").find(cleaned)
        val factsMatch = regex("【事实】([\\s\\S]*?)(?=【(?:事实变更|事实提案)】|\\z)").find(cleaned)
        val factChangesMatch = regex("【事实变更】([\\s\\S]*)\\z").find(cleaned)
        val factProposalsMatch = regex("【事实提案】([\\s\\S]*)\\z").find(cleaned)

        val currentState = currentStateMatch?.groupValues?.get(1)?.trim().orEmpty()
        val summaryRaw = timelineMatch?.groupValues?.get(1) ?: summaryMatch?.groupValues?.get(1)
        val summary = summaryRaw?.trim().orEmpty()
        val facts = (factsMatch?.groupValues?.get(1) ?: "")
            .split("\n")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { FACT_PREFIX.replace(it, "").trim() }
            .filter { it.isNotEmpty() }
            .take(MAX_MEMORY_FACTS)

        val fallbackSummary = if (currentState.isNotEmpty()) {
            ""
        } else {
            regex("【事实(?:变更|提案)?】[\\s\\S]*\\z").replace(cleaned, "").trim()
        }

        return ParsedMemory(
            currentState = currentState,
            summary = summary.ifEmpty { fallbackSummary },
            facts = facts,
            factChanges = factChangesMatch?.let { parseFactChanges(it.groupValues[1]) },
            factChangesPresent = factChangesMatch != null,
            factProposals = factProposalsMatch?.let { parseFactProposals(it.groupValues[1]) },
            factProposalsPresent = factProposalsMatch != null,
        )
    }

    private fun jsonTextOf(section: String): String =
        section.trim()
            .replace(regex("^```(?:json)?\\s*", RegexOption.IGNORE_CASE), "")
            .replace(regex("\\s*```\\z"), "")
            .trim()

    /** 解析【事实变更】段；无效返回 null（调用方须保留旧事实）。 */
    fun parseFactChanges(section: String): List<FactChange>? {
        val array = runCatching { JSONArray(jsonTextOf(section)) }.getOrNull() ?: return null
        val changes = (0 until array.length()).map { index ->
            parseFactChange(array.opt(index) as? JSONObject ?: return@map null)
        }
        return if (changes.all { it != null }) changes.filterNotNull() else null
    }

    private fun parseFactChange(raw: JSONObject?): FactChange? {
        val item = raw ?: return null
        return when (item.optString("action")) {
            "add" -> {
                val fact = item.optJSONObject("fact") ?: return null
                val subject = fact.optStringOrNull("subject") ?: return null
                val predicate = fact.optStringOrNull("predicate") ?: return null
                val value = fact.optStringOrNull("value") ?: return null
                // PC 的 add 分支只取 subject/predicate/value(+importance/confidence)，
                // 刻意不读 scope/entityId，避免模型绕过身份匹配键
                FactChange.Add(
                    FactPayload(
                        subject = subject,
                        predicate = predicate,
                        value = value,
                        importance = fact.optDoubleOrNull("importance"),
                        confidence = fact.optDoubleOrNull("confidence"),
                    ),
                )
            }

            "update" -> {
                val id = item.optStringOrNull("id") ?: return null
                val patchObject = item.optJSONObject("patch") ?: return null
                // 同 add：不解析 scope/entityId
                val patch = FactPatch(
                    subject = patchObject.optStringOrNull("subject"),
                    predicate = patchObject.optStringOrNull("predicate"),
                    value = patchObject.optStringOrNull("value"),
                    importance = patchObject.optDoubleOrNull("importance"),
                    confidence = patchObject.optDoubleOrNull("confidence"),
                )
                if (patch.isEmpty()) return null
                FactChange.Update(id, patch)
            }

            "deactivate" -> item.optStringOrNull("id")?.let { FactChange.Deactivate(it) }

            else -> null
        }
    }

    /** 解析【事实提案】段；逐条容错，但非空数组全部无效时仍报告解析失败。 */
    fun parseFactProposals(section: String): List<FactProposal>? {
        val array = runCatching { JSONArray(jsonTextOf(section)) }.getOrNull() ?: return null
        val proposals = (0 until array.length()).mapNotNull { index ->
            parseFactProposal(array.opt(index) as? JSONObject ?: return@mapNotNull null)
        }
        return if (array.length() > 0 && proposals.isEmpty()) null else proposals
    }

    private fun parseFactProposal(raw: JSONObject?): FactProposal? {
        val item = raw ?: return null
        val changeType = item.optString("changeType")
        if (changeType != "set" && changeType != "clear") return null
        val subject = item.optStringOrNull("subject") ?: return null
        val predicate = item.optStringOrNull("predicate") ?: return null
        val valueRaw = item.opt("value")
        if (changeType == "set" && (valueRaw !is String || valueRaw.trim().isEmpty())) return null
        if (changeType == "clear" && valueRaw != null && valueRaw !is String) return null
        return FactProposal(
            subject = subject,
            predicate = predicate,
            // clear 按 subject + predicate + scope + entityId 匹配旧事实，不依赖 value；
            // 模型通常输出空串或省略该字段，统一归一化为空串以维持契约。
            value = (valueRaw as? String)?.trim().orEmpty(),
            changeType = changeType,
            scope = item.optStringOrNull("scope"),
            entityId = item.optStringOrNull("entityId"),
            importance = item.optDoubleOrNull("importance"),
            confidence = item.optDoubleOrNull("confidence"),
        )
    }

    // ---------------------------------------------------------------- 身份与规范化

    /** 判断是否为已迁移的结构化事实。 */
    fun isMemoryFact(fact: FactRecord?): Boolean = fact is FactRecord.Structured

    /** 面向提示词与 UI 的稳定事实文本。 */
    fun memoryFactToText(fact: FactRecord): String = when (fact) {
        is FactRecord.TextFact -> fact.text.trim()
        is FactRecord.Structured -> {
            val subject = fact.subject.trim()
            val predicate = fact.predicate.trim()
            val value = fact.value.trim()
            if (predicate.isNotEmpty()) "${subject}的${predicate}：$value" else "${subject}：$value"
        }
    }

    /** 仅返回当前有效事实的可嵌入文本。 */
    fun memoryFactsToTexts(facts: List<FactRecord>?): List<String> = (facts ?: emptyList())
        .filter { !isMemoryFact(it) || (it as FactRecord.Structured).status == "active" }
        .map { memoryFactToText(it) }
        .filter { it.isNotEmpty() }

    private fun clampImportance(value: Double?): Int {
        val numeric = if (value != null && value.isFinite()) jsRoundToInt(value) else 3
        return min(5, max(1, numeric))
    }

    private fun clampConfidence(value: Double?): Double {
        val numeric = if (value != null && value.isFinite()) value else 0.8
        return min(1.0, max(0.0, numeric))
    }

    /** JS `Math.round`：半数向 +∞ 取整（与 Kotlin Math.round 一致，显式写出以便审查）。 */
    private fun jsRoundToInt(value: Double): Int = Math.round(value).toInt()

    /** 旧文本事实的稳定 id：JS 32 位字符串散列 + base36。 */
    fun stableLegacyId(text: String, index: Int): String {
        var hash = 0
        for (ch in text) hash = (hash shl 5) - hash + ch.code
        // JS `Math.abs` 作用于 double：Int.MIN_VALUE 必须走 Long 才不会返回负数
        return "legacy-${java.lang.Long.toString(abs(hash.toLong()), 36)}-$index"
    }

    private fun legacyFactToRecord(text: String, index: Int, updatedAt: Long): FactRecord.Structured {
        val trimmed = text.trim()
        val match = regex("^(.+?)的(.+?)[：:]\\s*(.+)\\z").find(trimmed)
        return FactRecord.Structured(
            id = stableLegacyId(trimmed, index),
            subject = match?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() } ?: "历史事实",
            predicate = match?.groupValues?.get(2)?.trim()?.takeIf { it.isNotEmpty() } ?: "内容",
            value = match?.groupValues?.get(3)?.trim()?.takeIf { it.isNotEmpty() } ?: trimmed,
            status = "active",
            importance = 3,
            confidence = 0.7,
            sourceMessageIds = emptyList(),
            updatedAt = updatedAt,
        )
    }

    fun normalizeFact(fact: FactRecord, index: Int, updatedAt: Long): FactRecord.Structured {
        if (fact !is FactRecord.Structured) {
            return legacyFactToRecord((fact as FactRecord.TextFact).text, index, updatedAt)
        }
        return fact.copy(
            subject = fact.subject.trim(),
            predicate = fact.predicate.trim(),
            value = fact.value.trim(),
            status = if (fact.status == "inactive" || fact.status == "superseded") fact.status else "active",
            importance = clampImportance(fact.importance.toDouble()),
            confidence = clampConfidence(fact.confidence),
            sourceMessageIds = fact.sourceMessageIds.filter { it.isNotEmpty() },
            updatedAt = fact.updatedAt ?: updatedAt,
        )
    }

    private fun normalizeIdentityPart(value: String?): String = (value ?: "").trim().lowercase(Locale.ROOT)

    private fun normalizeScope(value: String?): String {
        val scope = normalizeIdentityPart(value)
        if (scope.isEmpty()) return ""
        if (scope in setOf("本会话", "当前会话", "会话", "session")) return "session"
        if (scope in setOf("本群聊", "当前群聊", "群聊", "group")) return "group"
        return scope
    }

    private fun scopesCompatible(left: String?, right: String?): Boolean {
        val a = normalizeScope(left)
        val b = normalizeScope(right)
        if (a.isEmpty() || b.isEmpty() || a == b) return true
        if ((a == "session" && b.startsWith("session:")) || (b == "session" && a.startsWith("session:"))) return true
        if ((a == "group" && b.startsWith("group:")) || (b == "group" && a.startsWith("group:"))) return true
        return false
    }

    /** 旧事实缺少 scope/entityId 时按通配处理，便于渐进迁移且不制造重复项。 */
    fun sameFactIdentity(
        left: PickIdentity,
        right: PickIdentity,
    ): Boolean {
        if (normalizeIdentityPart(left.subject) != normalizeIdentityPart(right.subject)) return false
        if (normalizeIdentityPart(left.predicate) != normalizeIdentityPart(right.predicate)) return false
        if (!scopesCompatible(left.scope, right.scope)) return false
        val leftEntity = normalizeIdentityPart(left.entityId)
        val rightEntity = normalizeIdentityPart(right.entityId)
        return leftEntity.isEmpty() || rightEntity.isEmpty() || leftEntity == rightEntity
    }

    /** 身份匹配所需的最小字段集。 */
    data class PickIdentity(
        val subject: String,
        val predicate: String,
        val scope: String?,
        val entityId: String?,
    )

    private fun identityOf(fact: FactRecord.Structured): PickIdentity =
        PickIdentity(fact.subject, fact.predicate, fact.scope, fact.entityId)

    private fun identityOf(payload: FactPayload): PickIdentity =
        PickIdentity(payload.subject, payload.predicate, payload.scope, payload.entityId)

    private fun identityOf(proposal: FactProposal): PickIdentity =
        PickIdentity(proposal.subject, proposal.predicate, proposal.scope, proposal.entityId)

    private fun retainBestFacts(facts: List<FactRecord.Structured>): List<FactRecord.Structured> {
        if (facts.size <= MAX_MEMORY_FACTS) return facts
        val ranked = facts.sortedWith(
            compareByDescending<FactRecord.Structured> { it.importance }
                .thenByDescending { it.confidence }
                .thenByDescending { it.updatedAt ?: 0L },
        )
        val keepIds = ranked.take(MAX_MEMORY_FACTS).map { it.id }.toSet()
        return facts.filter { it.id in keepIds }
    }

    private fun withSource(fact: FactRecord.Structured, messageId: String, updatedAt: Long): FactRecord.Structured =
        fact.copy(
            sourceMessageIds = if (messageId.isNotEmpty() && messageId !in fact.sourceMessageIds) {
                fact.sourceMessageIds + messageId
            } else {
                fact.sourceMessageIds
            },
            updatedAt = updatedAt,
        )

    // ---------------------------------------------------------------- 应用变更

    data class ApplyResult(
        val facts: List<FactRecord.Structured>,
        val history: List<FactRecord.Structured>,
    )

    /**
     * 应用模型给出的增量事实变更。未知 ID 一律忽略；解析失败由调用方完全保留旧快照。
     * 替代和停用的事实移动到 history，绝不参与后续上下文或向量检索。
     */
    fun applyMemoryFactChanges(
        previousFacts: List<FactRecord>?,
        previousHistory: List<FactRecord>?,
        changes: List<FactChange>,
        sourceMessageId: String,
        updatedAt: Long,
    ): ApplyResult {
        val facts = (previousFacts ?: emptyList())
            .mapIndexed { index, fact -> normalizeFact(fact, index, updatedAt) }
            .filter { it.status == "active" }
            .toMutableList()
        val history = (previousHistory ?: emptyList())
            .mapIndexed { index, fact -> normalizeFact(fact, index, updatedAt) }
            .toMutableList()

        fun archive(fact: FactRecord.Structured, status: String) {
            history += withSource(
                fact.copy(id = "${fact.id}:history:$updatedAt:${history.size}", status = status),
                sourceMessageId,
                updatedAt,
            )
        }

        changes.forEachIndexed { index, change ->
            when (change) {
                is FactChange.Add -> {
                    // 同键旧事实全部归档，避免出现两个同名事实
                    for (i in facts.indices.reversed()) {
                        if (sameFactIdentity(identityOf(facts[i]), identityOf(change.fact))) {
                            archive(facts.removeAt(i), "superseded")
                        }
                    }
                    facts += FactRecord.Structured(
                        id = "fact-${java.lang.Long.toString(updatedAt, 36)}-$index",
                        subject = change.fact.subject.trim(),
                        predicate = change.fact.predicate.trim(),
                        value = change.fact.value.trim(),
                        status = "active",
                        importance = clampImportance(change.fact.importance),
                        confidence = clampConfidence(change.fact.confidence),
                        scope = change.fact.scope?.trim()?.takeIf { it.isNotEmpty() },
                        entityId = change.fact.entityId?.trim()?.takeIf { it.isNotEmpty() },
                        sourceMessageIds = if (sourceMessageId.isNotEmpty()) listOf(sourceMessageId) else emptyList(),
                        updatedAt = updatedAt,
                    )
                }

                is FactChange.Deactivate -> {
                    val targetIndex = facts.indexOfFirst { it.id == change.id }
                    if (targetIndex < 0) return@forEachIndexed
                    archive(facts[targetIndex], "inactive")
                    facts.removeAt(targetIndex)
                }

                is FactChange.Update -> {
                    val targetIndex = facts.indexOfFirst { it.id == change.id }
                    if (targetIndex < 0) return@forEachIndexed
                    val target = facts[targetIndex]
                    val patch = change.patch
                    val next = withSource(
                        target.copy(
                            subject = patch.subject ?: target.subject,
                            predicate = patch.predicate ?: target.predicate,
                            value = patch.value ?: target.value,
                            scope = patch.scope ?: target.scope,
                            entityId = patch.entityId ?: target.entityId,
                            importance = clampImportance(patch.importance ?: target.importance.toDouble()),
                            confidence = clampConfidence(patch.confidence ?: target.confidence),
                        ),
                        sourceMessageId,
                        updatedAt,
                    )
                    if (next.value != target.value) archive(target, "superseded")
                    for (i in facts.indices.reversed()) {
                        if (i != targetIndex && sameFactIdentity(identityOf(facts[i]), identityOf(next))) {
                            archive(facts.removeAt(i), "superseded")
                        }
                    }
                    val nextIndex = facts.indexOfFirst { it.id == target.id }
                    if (nextIndex >= 0) facts[nextIndex] = next
                }
            }
        }

        return ApplyResult(
            facts = retainBestFacts(facts),
            history = if (history.size > MAX_MEMORY_FACT_HISTORY) history.takeLast(MAX_MEMORY_FACT_HISTORY) else history,
        )
    }

    /**
     * 将模型的无 ID 语义提案转换为服务端事实变更。
     * 匹配键固定为 subject + predicate + scope + entityId，模型无法越权修改同名但不同作用域的事实。
     */
    fun applyFactProposals(
        previousFacts: List<FactRecord>?,
        previousHistory: List<FactRecord>?,
        proposals: List<FactProposal>,
        sourceMessageId: String,
        updatedAt: Long,
    ): ApplyResult {
        var result = applyMemoryFactChanges(previousFacts, previousHistory, emptyList(), sourceMessageId, updatedAt)
        proposals.forEach { proposal ->
            val target = result.facts.firstOrNull { sameFactIdentity(identityOf(it), identityOf(proposal)) }
            if (proposal.changeType == "clear") {
                if (target != null) {
                    result = applyMemoryFactChanges(
                        result.facts,
                        result.history,
                        listOf(FactChange.Deactivate(target.id)),
                        sourceMessageId,
                        updatedAt,
                    )
                }
                return@forEach
            }
            val change = if (target != null) {
                FactChange.Update(
                    id = target.id,
                    patch = FactPatch(
                        value = proposal.value,
                        scope = proposal.scope ?: target.scope,
                        entityId = proposal.entityId ?: target.entityId,
                        importance = proposal.importance,
                        confidence = proposal.confidence,
                    ),
                )
            } else {
                FactChange.Add(
                    FactPayload(
                        subject = proposal.subject,
                        predicate = proposal.predicate,
                        value = proposal.value,
                        scope = proposal.scope,
                        entityId = proposal.entityId,
                        importance = proposal.importance,
                        confidence = proposal.confidence,
                    ),
                )
            }
            result = applyMemoryFactChanges(result.facts, result.history, listOf(change), sourceMessageId, updatedAt)
        }
        return result
    }

    // ---------------------------------------------------------------- 内部工具

    private fun regex(pattern: String, vararg options: RegexOption) = Regex(pattern, options.toSet())

    /** 与 PC `stripAllThinking` 同口径：移除所有思考块。 */
    fun stripAllThinking(text: String): String =
        Regex("<thought>[\\s\\S]*?</thought>", RegexOption.IGNORE_CASE).replace(text, "")

    private val FACT_PREFIX =
        Regex("^\\s*(?:[-*]|\\d{1,3}[.、．)）]|[一二三四五六七八九十]+[、.．])\\s*")

    private fun JSONObject.optStringOrNull(key: String): String? {
        val value = opt(key) ?: return null
        if (value !is String) return null
        val trimmed = value.trim()
        return trimmed.ifEmpty { null }
    }

    private fun JSONObject.optDoubleOrNull(key: String): Double? {
        val value = opt(key) ?: return null
        return if (value is Number) value.toDouble() else null
    }
}
