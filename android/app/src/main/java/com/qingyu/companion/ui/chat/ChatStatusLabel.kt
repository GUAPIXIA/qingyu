package com.qingyu.companion.ui.chat

import com.qingyu.companion.data.ChatRepository

/**
 * 阶段 4 S4-06：单聊状态标签的**纯映射**。
 *
 * 抽成纯函数的原因：阶段 4 的验收要求「本地生成任务状态与模型连接状态有清晰标签」，
 * 这条要求必须可断言。放在 Compose 里就只能靠人工看界面；放在这里可以穷举用例锁定文案，
 * 并保证「未配置模型」一定给出可行动作，而不是让用户面对一个不动的输入框。
 */
object ChatStatusLabel {

    /** 数据源标签：明确「本地直连 + 具体模型」，与旧的「已连接 PC」区分开。 */
    fun source(status: ChatRepository.DataSourceStatus): String = when {
        !status.local -> "PC 远程"
        status.modelConfigured && !status.model.isNullOrBlank() -> "本地直连 · ${status.model}"
        status.modelConfigured -> "本地直连"
        else -> "本地直连 · 未配置模型"
    }

    /** 生成中标签；空闲时为 null（界面不显示，避免常态噪声）。 */
    fun generating(isGenerating: Boolean): String? = if (isGenerating) "正在生成…" else null

    /**
     * 未配置模型时的可行动作提示；已配置时为 null。
     * 与 [source] 的区别：[source] 是常驻状态，本方法只在需要用户操作时出现。
     */
    fun actionHint(status: ChatRepository.DataSourceStatus): String? =
        if (status.local && !status.modelConfigured) "请到「连接」页添加模型连接后再发送" else null

    /**
     * 未迁移能力的提示（如世界书/预设/翻译）。
     * 本地模式尚未提供的能力必须显式告知，不能静默返回空列表。
     */
    fun unsupportedNote(notice: String?): String? = notice?.takeIf { it.isNotBlank() }

    /**
     * 顶栏副标题行：会话标题 + 数据源/生成状态（单行，避免顶栏溢出）。
     *
     * 优先级：生成中 > 缺少模型配置的可行动作 > 常驻数据源标签。
     * 生成中优先是为了让「界面是否在动」这件事一眼可见；
     * 缺少配置时给出动作而非仅报状态，符合 S4-06「错误提示显示可行动作」。
     */
    fun secondaryLine(
        sessionTitle: String,
        status: ChatRepository.DataSourceStatus,
        isGenerating: Boolean,
    ): String {
        val statusText = when {
            isGenerating -> generating(true)!!
            else -> actionHint(status) ?: source(status)
        }
        return listOf(sessionTitle.trim(), statusText)
            .filter { it.isNotEmpty() }
            .joinToString(" · ")
    }
}
