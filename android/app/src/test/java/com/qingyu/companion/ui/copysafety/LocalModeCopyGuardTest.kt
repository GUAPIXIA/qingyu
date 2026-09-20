package com.qingyu.companion.ui.copysafety

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 阶段 4 S4-06：**本地模式的文案守卫**。
 *
 * 背景：阶段 4 把入口从「伴侣模式（依赖 PC/Relay）」切到本地优先之后，
 * 一批界面文案仍在描述已经不存在的行为，例如：
 * - 「删除会话，此操作会**同步删除 PC 端数据**」——本地模式下 PC 根本没连，
 *   这句话不仅错误，还会让用户以为数据被同步删除而不敢操作；
 * - 「设置会**同步到 PC 端**」——快捷设置面板已改为只写本地；
 * - 「暂无用量数据（**PC 侧**未开启用量统计或未连接）」——本地已有自己的用量记录。
 *
 * 完成定义明确要求「代码与导航中不存在旧伴侣模式回退入口」。
 * 文案属于入口的一部分：告诉用户「去 PC 端」就是在回退。
 *
 * 为什么写成测试而不是一次性修改：这类文案会随着后续合并、补丁不断回流，
 * 人工排查无法持续。本测试把它变成可重复执行的检查。
 */
class LocalModeCopyGuardTest {

    /**
     * 这些字符串在**本地单聊闭环**中被直接展示，因此必须只描述本机行为。
     * 配对/连接相关文案不在其列——它们本身就是关于「连接 PC」的，仍应保留 PC 措辞。
     */
    private val localModeStrings = listOf(
        "msg_delete_session_confirm",
        "chat_clear_confirm_desc",
        "usage_empty",
        "chat_tts_error",
        "qs_subtitle",
        "qs_model_empty_fmt",
    )

    /** 禁止出现在本地模式文案中的回退措辞。 */
    private val forbiddenPhrases = listOf(
        "同步删除 PC",
        "同步到 PC",
        "同步到当前 PC",
        "PC 侧未",
        "PC 端已",
        "请在 PC 端",
        "在 PC 端开始",
    )

    private fun stringsFile(): File {
        // Gradle 单测的工作目录是模块目录（app/）
        val candidates = listOf(
            File("src/main/res/values/strings.xml"),
            File("app/src/main/res/values/strings.xml"),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("找不到 strings.xml（工作目录=${File("").absolutePath}）")
    }

    private fun readString(xml: String, name: String): String {
        val match = Regex("<string name=\"$name\"[^>]*>(.*?)</string>", RegexOption.DOT_MATCHES_ALL).find(xml)
            ?: error("缺少字符串资源：$name")
        return match.groupValues[1]
    }

    @Test
    fun localModeCopyDoesNotFallBackToPc() {
        val xml = stringsFile().readText()
        for (name in localModeStrings) {
            val value = readString(xml, name)
            for (phrase in forbiddenPhrases) {
                assertFalse(
                    "「$name」在本地模式下不得出现回退措辞「$phrase」，实际为：$value",
                    value.contains(phrase),
                )
            }
        }
    }

    @Test
    fun localModeEmptyStateExistsAndIsLocal() {
        val xml = stringsFile().readText()
        val local = readString(xml, "sessions_empty_desc_local")
        assertTrue("本地模式空态必须说明可在本机开始", local.contains("本机"))
        // 反向：不能把「本地模式空态」写成让用户去 PC 端
        for (phrase in forbiddenPhrases) {
            assertFalse("本地模式空态不得出现「$phrase」：$local", local.contains(phrase))
        }
    }

    @Test
    fun usagePageDescribesLocalRecordsRatherThanPc() {
        val xml = stringsFile().readText()
        val empty = readString(xml, "usage_empty")
        assertFalse("用量空态不得指向 PC 侧状态：$empty", empty.contains("PC"))
        assertTrue("用量空态应说明何时会出现数据：$empty", empty.contains("对话"))
    }

    @Test
    fun tokenCountsAreMarkedAsEstimated() {
        // S4-02：未接入精确 tokenizer 时，界面上的 token 数必须如实标注为估算
        val xml = stringsFile().readText()
        val contextUsage = readString(xml, "chat_context_used_fmt")
        assertTrue("上下文用量必须标注为估算：$contextUsage", contextUsage.contains("估算"))
    }
}
