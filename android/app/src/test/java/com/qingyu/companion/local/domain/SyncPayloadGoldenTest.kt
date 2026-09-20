package com.qingyu.companion.local.domain

import com.qingyu.companion.domain.contracts.CanonicalJson
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 B-2：同步实体 payload 的跨端 golden（真值由 **PC 生产代码** 生成）。
 *
 * 用例形态是**不动点**：把 PC 对某份数据算出的 payload 当作 Android 的落库结果重建行，
 * 再用 Android 的构造函数回算 payload，要求逐字节相同。
 * 之所以比「各端各测自己的映射」强：`contentHash = sha256(canonicalJson(payload))`，
 * 少一个键、多一个键、把 null 写成缺省都会让同一实体在两端得到不同哈希，
 * 阶段 7 的合并就退化成满屏伪冲突（总方案 §12）。
 *
 * [ANDROID_ONLY_KEYS] 逐条列出**当前已知**的偏差（Android 的非空列只能把「未设置」
 * 表达成 `""`/`[]`，而 PC 的稀疏对象表达成「键不存在」）。它是白名单而不是宽容：
 * 任何新键跑进来都会让本用例变红，从而把偏差保持在一个可数、可复审的集合里。
 *
 * 重新生成真值：
 *   $env:SYNC_PAYLOAD_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/syncPayloadGolden.test.ts
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class SyncPayloadGoldenTest {

    // ---------------------------------------------------------------- fixture

    private fun fixture(name: String): JSONObject = JSONObject(
        File(directory(), "$name.json").readText(Charsets.UTF_8),
    )

    private fun directory(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, RELATIVE)
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        throw IllegalStateException(
            "找不到 $RELATIVE（从 ${File("").absolutePath} 向上查找）；" +
                "先运行 TS 生成器：$ SYNC_PAYLOAD_UPDATE_FIXTURES=1 pnpm exec vitest run " +
                "shared/__tests__/syncPayloadGolden.test.ts",
        )
    }

    private fun cases(name: String): List<JSONObject> =
        fixture(name).getJSONArray("cases").let { array ->
            (0 until array.length()).map { array.getJSONObject(it) }
        }

    private fun typedCases(entityType: String): List<JSONObject> =
        fixture("other-entity-payloads").getJSONArray(entityType).let { array ->
            (0 until array.length()).map { array.getJSONObject(it) }
        }

    /** 比较走 canonical 文本：`org.json` 把 `11` 解成 Int、`11.0` 解成 Double，直接比对象会假失败。 */
    private fun assertPayload(label: String, expected: Map<String, Any?>, actual: Map<String, Any?>) {
        val extra = actual.keys - expected.keys
        val missing = expected.keys - actual.keys
        val allowed = ANDROID_ONLY_KEYS[label].orEmpty()
        assertTrue(
            missing.isEmpty(),
            "$label：Android 丢了 PC 下发的键 $missing（同一实体会算出两个 contentHash）",
        )
        // 额外键必须**恰好**等于登记集合：多了是新漂移，少了说明登记已过期、该删
        assertEquals(allowed, extra, "$label：与 PC 的键集合偏差已变化，需复审 ANDROID_ONLY_KEYS")
        for (key in expected.keys) {
            assertEquals(
                CanonicalJson.encode(mapOf("v" to expected[key])),
                CanonicalJson.encode(mapOf("v" to actual[key])),
                "$label：键 $key 的值两端不一致",
            )
        }
    }

    // ---------------------------------------------------------------- S5-01 角色

    @Test
    fun characterPayloadIsAFixedPointOfPcPayload() {
        for (case in cases("character-payload")) {
            val label = "character/${case.getString("label")}"
            if (case.isNull("payload")) continue
            val payload = valueOf(case, "payload") as Map<String, Any?>
            assertPayload(label, payload, EntityPayloads.characterPayload(characterRow(payload)))
        }
    }

    @Test
    fun characterKeepsLocalOnlyFieldsOutOfThePayload() {
        // 这些列是角色卡往返保真用的，契约 schema 是 additionalProperties:false
        val row = characterRow(
            mapOf(
                "name" to "甲",
                "description" to "乙",
                "personality" to "",
                "scenario" to "",
                "firstMessage" to "",
            ),
        ).let {
            it.copy(
                avatarPath = "/media/private/avatar.png",
                backgroundPath = "/media/private/bg.png",
                lorebookId = "lb-legacy",
                creatorNotes = "备注",
                postHistoryInstructions = "PHI",
                characterVersion = "1.2.3",
                groupOnlyGreetingsJson = """["群聊开场"]""",
                authorNoteJson = """{"depth":1}""",
                embeddedLorebookJson = """{"schema":"qingyu_lorebook"}""",
                defaultMemoryMode = "layered",
                defaultNarrativeMode = "immersive",
                translatedContentJson = """{"name":"译名"}""",
                importedFrom = "character-card-v3",
            )
        }
        val payload = EntityPayloads.characterPayload(row)
        // 白名单：契约里的 12 个键。「未设置」在 Android 是 `""`/`[]`，所以这些键恒在——
        // 与 PC 上真实存储（normalize 后带全字段）的角色一致，见 ANDROID_ONLY_KEYS 的说明。
        assertEquals(
            setOf(
                "name", "description", "personality", "scenario", "firstMessage", "exampleDialog",
                "systemPrompt", "creator", "tags", "alternateGreetings", "boundLorebookIds",
                "boundPresetId",
            ),
            payload.keys,
        )
        // fixture 明确登记了这些键不许下发；这里把同一份清单当作断言，防两端清单各自漂移
        val declared = fixture("character-payload").getJSONArray("deliberatelyExcluded")
        for (index in 0 until declared.length()) {
            val key = declared.getString(index)
            val camel = if (key == "embeddedLorebook") "embeddedLorebookJson" else key
            assertTrue(
                key !in payload && camel !in payload,
                "$key 只应存在于本地列/Backup V3，进了 payload 会改变哈希",
            )
        }
    }

    // ---------------------------------------------------- S5-02/03/04/05/06/07

    @Test
    fun lorebookPayloadIsWholeCanonicalDocumentMinusId() {
        for (case in typedCases("lorebook")) {
            val label = "lorebook/${case.getString("label")}"
            val payload = valueOf(case, "payload") as Map<String, Any?>
            val row = LocalLorebookEntity(
                id = "lb-golden",
                name = payload["name"] as String,
                canonicalJson = JsonValues.stringify(payload + ("id" to "lb-golden")),
                createdAt = 1L,
                updatedAt = 2L,
            )
            assertPayload(label, payload, EntityPayloads.lorebookPayload(row))
            // 条目与外部厂商扩展必须原样回来：丢了就是「静默改数据」，不只是哈希问题
            val replayed = EntityPayloads.lorebookPayload(row)
            assertEquals(CanonicalJson.encode(payload["entries"]), CanonicalJson.encode(replayed["entries"]), "$label：entries 被改写")
            assertEquals(CanonicalJson.encode(payload["defaults"]), CanonicalJson.encode(replayed["defaults"]), "$label：defaults 被改写")
            assertEquals(payload.containsKey("foreign"), replayed.containsKey("foreign"), "$label：foreign 保真失败")
        }
    }

    @Test
    fun presetPayloadIsWholeBodyMinusId() {
        for (case in typedCases("preset")) {
            val label = "preset/${case.getString("label")}"
            val payload = valueOf(case, "payload") as Map<String, Any?>
            val row = LocalPresetEntity(
                id = "pre-golden",
                name = payload["name"] as String,
                bodyJson = JsonValues.stringify(payload + ("id" to "pre-golden")),
                createdAt = 1L,
                updatedAt = 2L,
            )
            assertPayload(label, payload, EntityPayloads.presetPayload(row))
        }
    }

    @Test
    fun personaPayloadKeepsOnlyTheThreeBusinessFields() {
        for (case in typedCases("persona")) {
            val label = "persona/${case.getString("label")}"
            val payload = valueOf(case, "payload") as Map<String, Any?>
            val row = LocalPersonaEntity(
                id = "p-golden",
                name = payload["name"] as String,
                description = payload["description"] as String,
                persona = payload["persona"] as String,
                isDefault = true,
                avatarPath = "/media/private/p.png",
                importedFrom = "sillytavern",
                createdAt = 1L,
                updatedAt = 2L,
            )
            assertPayload(label, payload, EntityPayloads.personaPayload(row))
        }
    }

    @Test
    fun regexRulePayloadMatchesPcForEveryKeyPcStored() {
        for (case in typedCases("regex_rule")) {
            val label = "regex_rule/${case.getString("label")}"
            val payload = valueOf(case, "payload") as Map<String, Any?>
            assertPayload(label, payload, EntityPayloads.regexRulePayload(regexRow(payload)))
            val viaIpc = valueOf(case, "alsoViaIpc") as? Map<String, Any?>
            if (viaIpc != null) {
                // PC 自己有两份 regexRulePayload；它们不一致时 bootstrap 与增量写会给出不同哈希
                assertEquals(
                    CanonicalJson.encode(viaIpc),
                    CanonicalJson.encode(payload),
                    "$label：PC 的两处实现已漂移，Android 无法同时对齐",
                )
            }
        }
    }

    @Test
    fun quickReplyStorePayloadIsOneWholeLibraryEntity() {
        for (case in typedCases("quick_reply_set")) {
            val label = "quick_reply_set/${case.getString("label")}"
            val payload = valueOf(case, "payload") as Map<String, Any?>
            assertPayload(label, payload, EntityPayloads.quickReplyStorePayload(quickReplyRows(payload)))
        }
    }

    @Test
    fun usageRecordPayloadOmitsAbsentOptionalKeysLikePc() {
        for (case in typedCases("usage_record")) {
            val label = "usage_record/${case.getString("label")}"
            val payload = valueOf(case, "payload") as Map<String, Any?>
            val row = LocalUsageRecordEntity(
                id = "u-golden",
                model = payload["model"] as String,
                createdAt = (payload["timestamp"] as Number).toLong(),
                characterId = payload["characterId"] as String?,
                sessionId = payload["sessionId"] as String?,
                inputChars = (payload["inputChars"] as Number).toInt(),
                outputChars = (payload["outputChars"] as Number).toInt(),
            )
            assertPayload(label, payload, EntityPayloads.usageRecordPayload(row))
            assertEquals(false, case.getBoolean("containsId"), "$label：PC 的 payload 里出现了 id")
            assertEquals(
                (payload["inputChars"] as Number).toLong() + (payload["outputChars"] as Number).toLong(),
                (payload["totalChars"] as Number).toLong(),
                "$label：真值自身的 totalChars 就不自洽",
            )
            assertEquals(
                (payload["totalChars"] as Number).toLong(),
                (EntityPayloads.usageRecordPayload(row)["totalChars"] as Number).toLong(),
                "$label：totalChars 不是输入+输出",
            )
        }
    }

    /**
     * 用量保留上限的跨端钉。
     *
     * §3 要求「所有跨端确定性算法都有同一 fixture 驱动的一致性测试」：超限淘汰是确定性行为，
     * 两端保留不同的记录集就等于两台设备看到不同的用量历史。
     * 只写在注释里不算守卫——PC 改 `MAX_RECORDS` 而 Android 不跟时，不会有任何测试变红。
     */
    @Test
    fun usageRetentionLimitMatchesPc() {
        val pcLimit = fixture("usage-retention").getInt("maxRecords")
        assertEquals(
            pcLimit,
            LocalStore.MAX_USAGE_RECORDS,
            "用量保留上限两端不一致：PC=$pcLimit Android=${LocalStore.MAX_USAGE_RECORDS}（" +
                "改任何一端都必须同时改另一端并重生成 fixture）",
        )
    }

    @Test
    fun settingsPublicPayloadIsAFixedPointAndEnforcesTheWhitelist() {
        for (case in typedCases("settings_public")) {
            val label = "settings_public/${case.getString("label")}"
            val payload = valueOf(case, "payload") as Map<String, Any?>
            assertPayload(label, payload, EntityPayloads.settingsPublicPayload(payload))
        }
        // 白名单本身：fixture 的输入已被 PC 过滤过一遍，所以这里直接用未过滤输入复算
        assertEquals(
            mapOf("language" to "zh-CN"),
            EntityPayloads.settingsPublicPayload(mapOf("theme" to "hotdog", "language" to "zh-CN")),
            "非法 theme 必须整键不下发，而不是下发成字符串",
        )
        assertEquals(
            emptyMap<String, Any?>(),
            EntityPayloads.settingsPublicPayload(mapOf("language" to "x".repeat(33))),
            "超长 language 必须丢弃",
        )
        assertEquals(
            emptyMap<String, Any?>(),
            EntityPayloads.settingsPublicPayload(mapOf("responseLengthMode" to "extra-long")),
            "枚举外的长度模式不下发",
        )
        val nulls = EntityPayloads.settingsPublicPayload(mapOf("activePersonaId" to null, "activePresetId" to "p-1"))
        assertTrue("activePersonaId" in nulls, "显式 null 的下发要保键：丢键=不改动，下发 null=取消绑定")
        assertEquals(null, nulls["activePersonaId"])
        val secrets = EntityPayloads.settingsPublicPayload(
            mapOf("apiKey" to "sk-1", "deviceName" to "Pixel", "theme" to "light"),
        )
        assertEquals(setOf("theme"), secrets.keys, "非白名单键（凭据/设备偏好）绝不允许进入同步 payload")
    }

    // ---------------------------------------------------------------- 行构造

    @Suppress("UNCHECKED_CAST")
    private fun characterRow(payload: Map<String, Any?>) = LocalCharacterEntity(
        id = "char-golden",
        name = payload["name"] as String,
        description = payload["description"] as String? ?: "",
        personality = payload["personality"] as String? ?: "",
        scenario = payload["scenario"] as String? ?: "",
        firstMessage = payload["firstMessage"] as String? ?: "",
        exampleDialog = payload["exampleDialog"] as String? ?: "",
        systemPrompt = payload["systemPrompt"] as String? ?: "",
        creator = payload["creator"] as String? ?: "",
        tagsJson = JsonValues.stringify(payload["tags"] ?: emptyList<String>()),
        alternateGreetingsJson = JsonValues.stringify(payload["alternateGreetings"] ?: emptyList<String>()),
        boundLorebookIdsJson = JsonValues.stringify(payload["boundLorebookIds"] ?: emptyList<String>()),
        extensionsJson = JsonValues.stringify(payload["extensions"] ?: emptyMap<String, Any?>()),
        defaultPresetId = payload["boundPresetId"] as String?,
        createdAt = 1L,
        updatedAt = 2L,
    )

    private fun regexRow(payload: Map<String, Any?>) = LocalRegexRuleEntity(
        id = "r-golden",
        name = payload["name"] as String,
        pattern = payload["pattern"] as String,
        replacement = payload["replacement"] as String? ?: "",
        flags = payload["flags"] as String? ?: "",
        scope = payload["scope"] as String? ?: "output",
        enabled = payload["enabled"] as Boolean,
        group = payload["group"] as String? ?: "",
        stage = payload["stage"] as String? ?: "text",
        triggerPattern = payload["triggerPattern"] as String? ?: "",
        triggerFlags = payload["triggerFlags"] as String? ?: "",
        stopStringsJson = JsonValues.stringify(payload["stopStrings"] ?: emptyList<String>()),
        createdAt = 1L,
        updatedAt = 2L,
    )

    /** 一份 payload 反推成 Android 的「整库多集合」形态：全局一个集合，每个角色一个集合。 */
    @Suppress("UNCHECKED_CAST")
    private fun quickReplyRows(payload: Map<String, Any?>): List<LocalQuickReplySetEntity> {
        val rows = ArrayList<LocalQuickReplySetEntity>()
        var sortIndex = 0
        (payload["global"] as? List<Any?>)?.takeIf { it.isNotEmpty() }?.let {
            rows += quickReplySetRow("set-global", null, it, sortIndex++)
        }
        (payload["byCharacter"] as? Map<String, Any?>)?.forEach { (characterId, items) ->
            rows += quickReplySetRow("set-$characterId", characterId, items as List<Any?>, sortIndex++)
        }
        return rows
    }

    private fun quickReplySetRow(
        id: String,
        characterId: String?,
        items: List<Any?>,
        sortIndex: Int,
    ) = LocalQuickReplySetEntity(
        id = id,
        name = characterId ?: "全局",
        itemsJson = JsonValues.stringify(items),
        sortIndex = sortIndex,
        characterId = characterId,
        createdAt = 1L,
        updatedAt = 2L,
    )

    @Suppress("UNCHECKED_CAST")
    private fun valueOf(obj: JSONObject, key: String): Any? = when (val raw = obj.get(key)) {
        is JSONObject -> JsonValues.parseObject(raw.toString())
        is org.json.JSONArray -> JsonValues.parseArray(raw.toString())
        else -> raw
    }

    private companion object {
        private const val RELATIVE = "shared/fixtures/cross-platform/sync-payload"

        /**
         * 已登记的 Android 额外键：`""`/`[]` 表达「未设置」的非空列，对位 PC 的「键不存在」。
         *
         * 只登记 PC 用**合成输入**（整键缺失）构造的用例。两端真实存储的数据都必须带全这些键，
         * 因此这不影响实际合并；要新增一条就得先在报告里说明它来自哪条真实路径。
         */
        private val ANDROID_ONLY_KEYS: Map<String, Set<String>> = mapOf(
            "character/minimal" to setOf(
                "description", "personality", "scenario", "firstMessage", "exampleDialog",
                "systemPrompt", "creator", "tags", "alternateGreetings", "boundLorebookIds",
                "boundPresetId",
            ),
            "regex_rule/minimal" to setOf(
                "flags", "group", "stage", "triggerPattern", "triggerFlags", "stopStrings",
            ),
        )
    }
}
