package com.qingyu.companion.content

import com.qingyu.companion.local.domain.JsonValues
import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.QuickReplyAction
import org.json.JSONArray
import org.json.JSONObject

/**
 * 阶段 5 S5-06：快捷回复条目的受控 JSON 编解码。
 *
 * 键名与 PC `shared/types.ts` 的 `QuickReply` **逐字一致**（`sendWithAI` 是大写 I，
 * 不是 `sendWithAi`），因为整个条目数组就是 `quick-replies-root` 实体的同步 payload：
 * 一端改名，两端对同一份数据算出的哈希就永远不相等，首次同步会把它当成并发冲突。
 *
 * 未知键保留在 [QuickReplyItemExtras] 里回写，不做「不认识就丢」的处理——
 * PC 后续给快捷回复加字段时，Android 导入再导出应该是无损的。
 */
object QuickReplyCodec {

    /** 解码结果：条目 + 该条目的未知键（按条目 id 索引，编码时原样写回）。 */
    data class Decoded(val items: List<QuickReply>, val unknownByKey: Map<String, Map<String, Any?>>)

    fun decodeItems(json: String?, fallbackOrderBase: Int = 0): List<QuickReply> =
        decode(json, fallbackOrderBase).items

    fun decode(json: String?, fallbackOrderBase: Int = 0): Decoded {
        val array = runCatching { JSONArray(json.orEmpty().ifBlank { "[]" }) }.getOrNull()
            ?: return Decoded(emptyList(), emptyMap())
        val items = ArrayList<QuickReply>(array.length())
        val unknown = LinkedHashMap<String, Map<String, Any?>>()
        for (index in 0 until array.length()) {
            val obj = array.optJSONObject(index) ?: continue
            val map = JsonValues.parseObject(obj.toString())
            val id = map["id"] as? String ?: continue
            items += QuickReply(
                id = id,
                label = map["label"] as? String ?: "",
                content = map["content"] as? String ?: "",
                action = actionOf(map["action"]),
                sendWithAI = map["sendWithAI"] as? Boolean ?: true,
                order = (map["order"] as? Number)?.toInt() ?: (fallbackOrderBase + index),
                enabled = map["enabled"] as? Boolean ?: true,
                presetId = map["presetId"] as? String,
                command = map["command"] as? String,
            )
            (map.keys - KNOWN_KEYS).takeIf { it.isNotEmpty() }?.let { extra ->
                unknown[id] = extra.associateWith { map[it] }
            }
        }
        return Decoded(items, unknown)
    }

    /**
     * 编码回 JSON。
     *
     * 空值的处理规则与 PC 一致：`presetId`/`command`/`hotkey` 属于「有才有键」，
     * 写成 `null` 占位会让 payload 多出键，两端哈希就对不上。
     */
    fun encode(items: List<QuickReply>, unknownByKey: Map<String, Map<String, Any?>> = emptyMap()): String {
        val array = JSONArray()
        items.forEach { item ->
            val obj = JSONObject()
            obj.put("id", item.id)
            obj.put("label", item.label)
            obj.put("content", item.content)
            obj.put("action", item.action.name)
            obj.put("sendWithAI", item.sendWithAI)
            obj.put("order", item.order)
            obj.put("enabled", item.enabled)
            item.presetId?.let { obj.put("presetId", it) }
            item.command?.let { obj.put("command", it) }
            unknownByKey[item.id]?.forEach { (key, value) -> if (!obj.has(key)) obj.put(key, value) }
            array.put(obj)
        }
        return array.toString()
    }

    /**
     * 动作值归一化。
     *
     * 脏值不能默认落到 `text`：一条 `action: "preset"` 拼错成 `"presets"` 时，
     * 落回 text 会把「切换预设」变成「把预设 id 当消息发出去」——
     * 那是往聊天里塞垃圾，比报错更糟。这里回退到 text 但**保留原文**，由调用方提示。
     */
    fun actionOf(raw: Any?): QuickReplyAction = when (raw) {
        "preset" -> QuickReplyAction.preset
        "command" -> QuickReplyAction.command
        else -> QuickReplyAction.text
    }

    /** 是否是无法识别的动作值（UI 据此显示兼容性提示）。 */
    fun isUnknownAction(raw: Any?): Boolean = raw != null && raw !in KNOWN_ACTIONS

    private val KNOWN_ACTIONS = setOf("text", "preset", "command")

    private val KNOWN_KEYS = setOf(
        "id", "label", "content", "action", "sendWithAI", "order", "enabled", "presetId", "command",
    )
}

/** PC 里 `hotkey` 等字段是可选的；本表用于区分「已知但 Android 不消费」与「完全未知」。 */
object QuickReplyItemExtras {
    /** Android 暂不生效但必须原样保留的 PC 字段。 */
    val PRESERVED_ONLY = setOf("hotkey")
}
