package com.qingyu.companion.content

import com.qingyu.companion.local.domain.JsonValues
import org.json.JSONObject

/**
 * 阶段 5 S5-03：预设归一化。
 *
 * 逐条移植自 `shared/preset.ts` 的 `normalizePreset` / `normalizeImportedPreset`——
 * 这是总方案 §3.1「所有跨端确定性算法都有同一 fixture 驱动的一致性测试」所指的算法之一：
 * 预设正文整体进入 `preset` 实体的同步 payload，任何一端多补或少补一个键，
 * 同一份预设就会有两个不同的 `contentHash`。因此这里的**默认值、钳位区间、
 * 字段存在性**都必须与 TS 侧完全一致，包括：
 * - `temperature` 默认 0.8 且钳在 [0,2]，`topP` 默认 0.95 钳在 [0.01,1]；
 * - `maxContext`/`maxTokens` 先钳位再 `Math.round`（顺序影响结果，四舍五入在钳位之后）；
 * - 可选键（`contextTemplate`/`group`/`exampleDialogMode`/`enableThoughtFormat`）**只在下发时存在**，
 *   不能写成 `null` 占位；
 * - `responseLengthHint` 的兜底依赖 `isBuiltin`：内置旧卡把历史 `maxTokens` 推断成篇幅偏好，
 *   用户预设一律 `auto`，避免把用户手设的硬上限误判成篇幅意图。
 */
object PresetCodec {

    const val MAX_NAME_LENGTH = 100
    const val MAX_GROUP_LENGTH = 50

    private val VALID_EXAMPLE_MODES = setOf("always", "first_turn", "off")
    private val VALID_RESPONSE_LENGTH_HINTS = setOf("auto", "brief", "balanced", "detailed")

    /** 原生 camelCase 字段；其余键在导入时列入 `unsupportedFields`。 */
    private val NATIVE_PRESET_FIELDS = setOf(
        "id", "name", "description", "systemPrompt", "jailbreak", "maxContext", "temperature",
        "topP", "maxTokens", "responseLengthHint", "frequencyPenalty", "presencePenalty",
        "isBuiltin", "contextTemplate", "group", "exampleDialogMode", "enableThoughtFormat",
    )

    /** 通用/酒馆蛇形字段 → 原生字段。 */
    private val STANDARD_FIELD_MAP = linkedMapOf(
        "main_prompt" to "systemPrompt",
        "jailbreak_prompt" to "jailbreak",
        "max_context" to "maxContext",
        "top_p" to "topP",
        "max_tokens" to "maxTokens",
        "frequency_penalty" to "frequencyPenalty",
        "presence_penalty" to "presencePenalty",
        "context_template" to "contextTemplate",
    )

    /**
     * [approximated] 是归一化过程中**被改动过的用户输入**清单（方案 §2 报告五类里的「近似映射」）。
     *
     * 只读、不影响 [body]：`body` 整体就是同步 payload 的正文，跨端 golden 钉的是它的形状，
     * 所以近似清单走独立字段，绝不为了报告去改 [normalize] 的输出。
     */
    data class ImportResult(
        val body: Map<String, Any?>,
        val sourceFormat: String,
        val unsupportedFields: List<String>,
        val approximated: List<String>,
    )

    class PresetFormatException(message: String) : IllegalArgumentException(message)

    /**
     * 归一化为规范正文（不含 `id`）。
     *
     * 返回的 Map 就是要写进 `local_presets.body_json` 的内容，
     * 也直接决定 `preset` 实体的同步 payload（见 `EntityPayloads.presetPayload`）。
     */
    fun normalize(input: Any?): Map<String, Any?> {
        val raw = input as? Map<*, *> ?: throw PresetFormatException("预设格式无效")
        val id = (raw["id"] as? String)?.trim().orEmpty()
        val name = (raw["name"] as? String)?.trim().orEmpty()
        if (id.isEmpty()) throw PresetFormatException("预设 ID 不能为空")
        if (name.isEmpty()) throw PresetFormatException("预设名称不能为空")

        val isBuiltin = raw["isBuiltin"] == true
        val maxTokens = round(finite(raw["maxTokens"], 0.0, 0.0, 262_144.0))

        val body = LinkedHashMap<String, Any?>()
        body["id"] = id
        body["name"] = name.take(MAX_NAME_LENGTH)
        body["description"] = raw["description"] as? String ?: ""
        body["systemPrompt"] = raw["systemPrompt"] as? String ?: ""
        body["jailbreak"] = raw["jailbreak"] as? String ?: ""
        body["maxContext"] = round(finite(raw["maxContext"], 0.0, 0.0, 2_000_000.0))
        body["temperature"] = finite(raw["temperature"], 0.8, 0.0, 2.0)
        body["topP"] = finite(raw["topP"], 0.95, 0.01, 1.0)
        // 0 = 自动动态预算；正数 = 用户明确设置的严格硬上限。
        body["maxTokens"] = maxTokens
        body["frequencyPenalty"] = finite(raw["frequencyPenalty"], 0.0, -2.0, 2.0)
        body["presencePenalty"] = finite(raw["presencePenalty"], 0.0, -2.0, 2.0)
        body["isBuiltin"] = isBuiltin

        (raw["contextTemplate"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
            ?.let { body["contextTemplate"] = it }
        (raw["group"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
            ?.let { body["group"] = it.take(MAX_GROUP_LENGTH) }
        (raw["exampleDialogMode"] as? String)?.takeIf { VALID_EXAMPLE_MODES.contains(it) }
            ?.let { body["exampleDialogMode"] = it }
        (raw["enableThoughtFormat"] as? Boolean)?.let { body["enableThoughtFormat"] = it }

        body["responseLengthHint"] = (raw["responseLengthHint"] as? String)
            ?.takeIf { VALID_RESPONSE_LENGTH_HINTS.contains(it) }
            ?: if (isBuiltin) inferLegacyResponseLength(maxTokens.toInt()) else "auto"

        return body
    }

    /** 导入外部预设 JSON：先做蛇形→原生字段映射，再归一化，并报告未识别字段。 */
    fun normalizeImported(input: Any?, id: String, fallbackName: String): ImportResult {
        if (input !is Map<*, *> || input["__array"] == true) throw PresetFormatException("预设格式无效")
        val converted = LinkedHashMap<String, Any?>()
        input.forEach { (k, v) -> converted[k.toString()] = v }
        var mappedStandardField = false
        STANDARD_FIELD_MAP.forEach { (source, target) ->
            if (input.containsKey(source)) {
                mappedStandardField = true
                if (!converted.containsKey(target) || converted[target] == null) converted[target] = input[source]
            }
        }
        val importedName = (input["name"] as? String)?.trim().orEmpty()
        converted["id"] = id
        converted["name"] = importedName.ifBlank { fallbackName.trim() }
        converted["isBuiltin"] = false

        val recognized = NATIVE_PRESET_FIELDS + STANDARD_FIELD_MAP.keys
        val unsupported = input.keys.mapNotNull { it as? String }
            .filterNot { recognized.contains(it) }
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it })

        val normalized = normalize(converted)
        return ImportResult(
            body = normalized,
            sourceFormat = if (mappedStandardField) "standard" else "qingyu",
            unsupportedFields = unsupported,
            approximated = approximateNotes(converted, normalized),
        )
    }

    /**
     * 「这文件不是预设」的判据，返回给用户看的原因；不是外来结构就返回 null。
     *
     * 只服务 Android 的导入路由（方案 §2 报告五类里的「跳过」），**不参与跨端 payload**：
     * PC 的 `normalizeImportedPreset` 没有同类守卫，直接吃任何对象。放在这里也不改变归一化结果——
     * 守卫只决定「导不导」，不改「导成什么」，所以两端对同一份预设仍算同一个 contentHash。
     *
     * 为什么 Android 要有：预设正文里只有 `id`/`name` 是必填，而角色卡顶层恰好也有 `name`
     * （V2.5 型则是 `data.name` 之外还有个顶层 name），于是一份角色卡会被**静默导入成一条空白预设**。
     * 空壳预设比一次明确的失败难查得多。标记用格式自己的字段（`spec` / `data.first_mes` / `entries`），
     * 与角色侧 `CharacterCardCodec` 认 `first_mes`、世界书侧认 `entries` 同源。
     */
    fun foreignShapeNote(body: Map<String, Any?>): String? {
        val spec = body["spec"]
        if (spec == "chara_card_v2" || spec == "chara_card_v3") return "是角色卡（spec=$spec），请到角色页导入"
        val data = body["data"]
        if (data is Map<*, *> && data.containsKey("first_mes")) return "是角色卡（data.first_mes），请到角色页导入"
        if (body["entries"] is List<*>) return "是世界书（含 entries 条目数组），请到世界书页导入"
        return null
    }

    /** Room 行 → 正文 Map（供编辑器回填）。 */
    fun bodyOf(bodyJson: String?): Map<String, Any?> = JsonValues.parseObject(bodyJson)

    /** 正文 Map → Room 行用的 JSON 文本。 */
    fun bodyJsonOf(body: Map<String, Any?>): String = JSONObject(body as Map<out String, Any?>).toString()

    /** 预设实体主键（正文与实体 id 同源，导入时由调用方分配）。 */
    fun idOf(body: Map<String, Any?>): String? = body["id"] as? String

    /**
     * 归一化**改动了用户输入**的清单——方案 §2 导入报告五类里的「近似映射」。
     *
     * `normalize` 会钳位、取整、把非数值/非法枚举回落到默认、截断超长文本、把非文本的正文当空。
     * 这些都是静默改数据：不报出来，用户看到的就是「我导入的温度 11 怎么变成 2 了」，
     * 而界面上没有任何一处承认过。
     *
     * 口径（与 [normalize] 一一对应，别在这里加规则也不要在 normalize 里删）：
     * - 只报「用户填了、且值被改动或被丢弃」的键；键缺失是「用户没填」，用默认值不算近似；
     * - 显式 `null` 同缺失处理（JSON 里的 null 表示没设置，不是设置成了 0）；
     * - 数值能被原样保留时（例如字符串 "0.8"）不报——值没变，只是类型换了，两端都能读。
     *
     * 入参是 [normalizeImported] 做完蛇形→原生映射之后的 Map，所以这里只认 camelCase 键。
     */
    fun approximateNotes(input: Map<String, Any?>, normalized: Map<String, Any?>): List<String> {
        val rules = listOf(
            Triple("maxContext", 0.0, 2_000_000.0),
            Triple("temperature", 0.0, 2.0),
            Triple("topP", 0.01, 1.0),
            Triple("maxTokens", 0.0, 262_144.0),
            Triple("frequencyPenalty", -2.0, 2.0),
            Triple("presencePenalty", -2.0, 2.0),
        )
        val integerKeys = setOf("maxContext", "maxTokens")
        val notes = ArrayList<String>()

        rules.forEach { (key, min, max) ->
            val given = input[key] ?: return@forEach
            val parsed = when (given) {
                is Number -> given.toDouble()
                is String -> given.trim().toDoubleOrNull()
                else -> null
            }
            val applied = normalized[key] as? Number ?: return@forEach
            when {
                parsed == null || parsed.isNaN() || parsed.isInfinite() ->
                    notes += "$key「${textOf(given)}」不是可用数值，已回落到 ${numberOf(applied)}"
                parsed < min || parsed > max ->
                    notes += "$key ${numberOf(parsed)} 超出可用区间 ${numberOf(min)}–${numberOf(max)}，已钳位为 ${numberOf(applied)}"
                key in integerKeys && parsed != applied.toDouble() ->
                    notes += "$key ${numberOf(parsed)} 不是整数，已取整为 ${numberOf(applied)}"
            }
        }

        listOf("systemPrompt", "jailbreak", "description").forEach { key ->
            val given = input[key]
            if (given != null && given !is String) {
                notes += "$key 不是文本，已按空内容导入"
            }
        }

        listOf("name" to MAX_NAME_LENGTH, "group" to MAX_GROUP_LENGTH).forEach { (key, cap) ->
            val given = (input[key] as? String)?.trim() ?: return@forEach
            val applied = normalized[key] as? String ?: return@forEach
            if (given.length > applied.length) {
                notes += "$key 超过 $cap 字符，已截断为「$applied…」"
            }
        }

        val exampleMode = input["exampleDialogMode"]
        if (exampleMode != null && !(exampleMode is String && VALID_EXAMPLE_MODES.contains(exampleMode))) {
            notes += "exampleDialogMode「${textOf(exampleMode)}」不是可用取值（${VALID_EXAMPLE_MODES.joinToString("/")}），该字段未导入"
        }
        val hint = input["responseLengthHint"]
        if (hint != null && !(hint is String && VALID_RESPONSE_LENGTH_HINTS.contains(hint))) {
            notes += "responseLengthHint「${textOf(hint)}」不是可用取值，已回落到 ${normalized["responseLengthHint"] ?: "auto"}"
        }

        return notes
    }

    /** 报告给人看的文本：原值可能是数字、布尔或带引号的字符串，一律收成一行。 */
    private fun textOf(value: Any?): String = value.toString()

    /** 整数不带 `.0`——否则报告里会出现「钳位为 2.0」这种没人这么说话的句子。 */
    private fun numberOf(value: Any?): String {
        val number = (value as? Number)?.toDouble() ?: return value.toString()
        return if (number == kotlin.math.floor(number) && !number.isInfinite()) {
            number.toLong().toString()
        } else {
            number.toString()
        }
    }

    /** W10：旧快捷 maxTokens 只用于补篇幅偏好；原正数本身仍作为用户硬上限保留。 */
    private fun inferLegacyResponseLength(maxTokens: Int): String = when {
        maxTokens <= 0 -> "auto"
        maxTokens <= 768 -> "brief"
        maxTokens <= 1536 -> "balanced"
        else -> "detailed"
    }

    /** `Number(value)` + 有限性检查 + 钳位（与 TS `finiteNumber` 一致）。 */
    private fun finite(value: Any?, fallback: Double, min: Double, max: Double): Double {
        val number = when (value) {
            is Number -> value.toDouble()
            is String -> value.trim().toDoubleOrNull()
            else -> null
        }
        if (number == null || number.isNaN() || number.isInfinite()) return fallback
        return minOf(max, maxOf(min, number))
    }

    /** JS `Math.round`：向 +∞ 方向取半（`-2.5 → -2`），与 Kotlin `roundToInt` 不同。 */
    private fun round(value: Double): Long = kotlin.math.floor(value + 0.5).toLong()
}
