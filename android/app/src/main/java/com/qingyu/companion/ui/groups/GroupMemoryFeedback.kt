package com.qingyu.companion.ui.groups

import com.qingyu.companion.chatcore.LocalGroupMemoryService

/**
 * 群记忆面板可见反馈（S6-01(f) 第 7 项）。
 *
 * 把 `LocalGroupMemoryService.summarize` 的 [LocalGroupMemoryService.Outcome]
 * 投影为可渲染反馈（纯函数，JVM 可测）。Summarized / Skipped / Failed 的字面量文案
 * 由 Outcome 自带（S6-01(e) 已钉），本层只做**可见反馈**归类，不改写语义。
 */
data class GroupMemoryFeedback(
    /** 面板主文案（摘要结果／跳过原因／失败提示）。 */
    val text: String,
    /** 是否失败（提示色）。 */
    val isError: Boolean,
    /** 是否已产出新摘要（成功徽标）。 */
    val summarized: Boolean,
) {
    companion object {
        fun from(outcome: LocalGroupMemoryService.Outcome): GroupMemoryFeedback = when (outcome) {
            is LocalGroupMemoryService.Outcome.Summarized -> GroupMemoryFeedback(
                text = "已更新群记忆：${outcome.summary}",
                isError = false,
                summarized = true,
            )
            is LocalGroupMemoryService.Outcome.Skipped -> GroupMemoryFeedback(
                text = outcome.reason,
                isError = false,
                summarized = false,
            )
            is LocalGroupMemoryService.Outcome.Failed -> GroupMemoryFeedback(
                text = outcome.message,
                isError = true,
                summarized = false,
            )
        }
    }
}
