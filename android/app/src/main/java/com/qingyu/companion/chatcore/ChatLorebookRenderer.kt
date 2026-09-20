package com.qingyu.companion.chatcore

import kotlin.math.floor
import kotlin.math.max

/**
 * 阶段 4 S4-01 第 3 层：世界书条目位置渲染
 * （对齐 `shared/chat-core/lorebookRenderer.ts`）。
 *
 * 语义：
 * - `chat` 注入按 depth（`max(0, floor(depth))`）落到聊天消息，role 可选；
 * - `prompt` 注入按 anchor 落到 7 个稳定锚点；
 * - `outlet` 保留独立输出通道，**同时回退到 prompt_end**（内容不静默消失），并记 fallback/decision；
 * - 未知 custom 插入同样回退 prompt_end 并记录。
 */
object ChatLorebookRenderer {

    /** 插入位置（对应 `LorebookInsertionV2` 的可辨识联合）。 */
    sealed interface Insertion {
        /** `kind = chat`：按深度注入聊天消息。 */
        data class Chat(val depth: Double, val role: String? = null) : Insertion

        /** `kind = prompt`：落到命名锚点。 */
        data class Prompt(val anchor: String) : Insertion

        /** `kind = outlet`：命名出口（普通聊天协议无原生槽位，回退 prompt_end）。 */
        data class Outlet(val name: String) : Insertion

        /** `kind = custom`：未知来源，回退 prompt_end。 */
        data class Custom(val source: String, val value: Any? = null) : Insertion
    }

    data class RenderItem(
        val content: String,
        val order: Int,
        val insertion: Insertion,
        val key: String? = null,
        val adapterId: String? = null,
        val retrievalMode: String? = null,
    )

    data class ChatItem(
        val content: String,
        val order: Int,
        val depth: Int,
        val role: String? = null,
    )

    data class Fallback(
        val key: String?,
        val source: String,
        val target: String,
        val value: Any? = null,
        val reason: String,
    )

    data class Decision(
        val key: String?,
        val status: String,
        val target: String,
        val reason: String? = null,
    )

    data class Plan(
        val beforeCharacter: List<String> = emptyList(),
        val afterCharacter: List<String> = emptyList(),
        val beforeExamples: List<String> = emptyList(),
        val afterExamples: List<String> = emptyList(),
        val authorsNoteTop: List<String> = emptyList(),
        val authorsNoteBottom: List<String> = emptyList(),
        val promptEnd: List<String> = emptyList(),
        val chat: List<ChatItem> = emptyList(),
        val outlets: Map<String, List<String>> = emptyMap(),
        val fallbacks: List<Fallback> = emptyList(),
        val decisions: List<Decision> = emptyList(),
    )

    /** 7 个 prompt 锚点（键名与 TS 的 buckets 一一对应）。 */
    private val PROMPT_ANCHORS = listOf(
        "before_character",
        "after_character",
        "before_examples",
        "after_examples",
        "authors_note_top",
        "authors_note_bottom",
        "prompt_end",
    )

    fun emptyPlan(): Plan = Plan()

    /**
     * 预算层插入位置 → 渲染层插入位置。
     *
     * 两层各自持有 `Insertion`（预算层只关心「分桶键」，渲染层还要处理 outlet/custom 回退），
     * 用一个显式转换而不是在调用处散落映射，避免将来新增位置时漏改一处。
     */
    fun fromBudgetInsertion(insertion: ChatLorebookBudget.Insertion): Insertion = when (insertion) {
        is ChatLorebookBudget.Insertion.Prompt -> Insertion.Prompt(insertion.anchor)
        is ChatLorebookBudget.Insertion.Chat -> Insertion.Chat(insertion.depth.toDouble(), insertion.role)
    }

    fun render(items: List<RenderItem>): Plan {
        val buckets: MutableMap<String, MutableList<String>> =
            PROMPT_ANCHORS.associateWith { mutableListOf<String>() }.toMutableMap()
        val chat = mutableListOf<ChatItem>()
        val outlets = LinkedHashMap<String, MutableList<String>>()
        val fallbacks = mutableListOf<Fallback>()
        val decisions = mutableListOf<Decision>()

        for (item in items) {
            when (val insertion = item.insertion) {
                is Insertion.Chat -> {
                    val depth = max(0, floor(insertion.depth).toInt())
                    chat += ChatItem(item.content, item.order, depth, insertion.role)
                    decisions += Decision(item.key, "exact", "chat:$depth")
                }

                is Insertion.Prompt -> {
                    val bucket = buckets[insertion.anchor]
                    if (bucket == null) {
                        // 未识别的 anchor：与 PC 一致地按 prompt_end 兜底，不丢内容
                        buckets.getValue("prompt_end") += item.content
                        decisions += Decision(item.key, "exact", "prompt_end")
                    } else {
                        bucket += item.content
                        decisions += Decision(item.key, "exact", insertion.anchor)
                    }
                }

                is Insertion.Outlet -> {
                    val name = insertion.name.trim().ifEmpty { "default" }
                    outlets.getOrPut(name) { mutableListOf() } += item.content
                    buckets.getValue("prompt_end") += item.content
                    val reason = "当前聊天协议没有命名 outlet「$name」，已回退到 prompt_end"
                    fallbacks += Fallback(item.key, "outlet", "outlet:$name", null, reason)
                    decisions += Decision(item.key, "fallback", "outlet:$name → prompt_end", reason)
                }

                is Insertion.Custom -> {
                    buckets.getValue("prompt_end") += item.content
                    val reason = "当前 renderer 不认识 ${insertion.source} 的 custom insertion，已回退到 prompt_end"
                    fallbacks += Fallback(item.key, "custom", insertion.source, insertion.value, reason)
                    decisions += Decision(item.key, "fallback", "${insertion.source} → prompt_end", reason)
                }
            }
        }

        return Plan(
            beforeCharacter = buckets.getValue("before_character").toList(),
            afterCharacter = buckets.getValue("after_character").toList(),
            beforeExamples = buckets.getValue("before_examples").toList(),
            afterExamples = buckets.getValue("after_examples").toList(),
            authorsNoteTop = buckets.getValue("authors_note_top").toList(),
            authorsNoteBottom = buckets.getValue("authors_note_bottom").toList(),
            promptEnd = buckets.getValue("prompt_end").toList(),
            chat = chat.toList(),
            outlets = outlets.mapValues { it.value.toList() },
            fallbacks = fallbacks.toList(),
            decisions = decisions.toList(),
        )
    }
}
