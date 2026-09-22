package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-05 模型包四条硬要求的第四条：**卸载影响提示**。
 * 提示必须先回答用户最怕的那件事——「卸载会不会删我的世界书」。
 */
class ModelPackageUninstallTest {

    private val stats = object : ModelPackageUsageStats {
        override fun isModelActive(modelId: String, version: String) = true
        override fun modelBytes(modelId: String, version: String) = 96L * 1024 * 1024
        override fun indexBytes(modelId: String, version: String) = 8L * 1024 * 1024
        override fun indexedLorebookCount(modelId: String, version: String) = 3
        override fun indexedEntryCount(modelId: String, version: String) = 42
    }

    @Test
    fun impactAggregatesAllPcFields() {
        val impact = ModelPackageUninstall.impact(UninstallRequest("bge-m3", "1.0.0", removeIndexes = true), stats)
        assertTrue("是否正在使用必须进影响（决定要不要提示降级）", impact.active)
        assertEquals("模型占用要报出来（用户据此决定要不要卸）", 96L * 1024 * 1024, impact.modelBytes)
        assertEquals("索引占用要报出来", 8L * 1024 * 1024, impact.indexBytes)
        assertEquals("受影响世界书数要报出来", 3, impact.lorebookCount)
        assertEquals("受影响条目数要报出来", 42, impact.entryCount)
    }

    @Test
    fun hintAnswersWhatUsersActuallyFearBeforeUninstall() {
        val request = UninstallRequest("bge-m3", "1.0.0", removeIndexes = true)
        val hint = ModelPackageUninstall.hint(request, ModelPackageUninstall.impact(request, stats))

        assertTrue("提示要先说卸载不会删正文（用户第一顾虑）：$hint", hint.contains("不会删除世界书、记忆与聊天记录"))
        assertTrue("正在使用中必须提示语义检索会降级：$hint", hint.contains("降级为关键词/词法检索"))
        assertTrue("必须明说关键词世界书不受影响（总方案 §3.2 硬边界）：$hint", hint.contains("关键词世界书不受影响"))
        assertTrue("连带删除索引要给出数量：$hint", hint.contains("3 本世界书、42 条条目"))
        assertTrue("要说明索引可重建、不同步：$hint", hint.contains("重建"))
        assertTrue("要报释放空间：$hint", hint.contains("MB"))
    }

    @Test
    fun hintDistinguishesKeepingIndexesFromDeletingThem() {
        val keep = UninstallRequest("bge-m3", "1.0.0", removeIndexes = false)
        val keepHint = ModelPackageUninstall.hint(keep, ModelPackageUninstall.impact(keep, stats))
        assertTrue("保留索引的口径要与删除不同（用户可重装复用）：$keepHint", keepHint.contains("保留其语义索引"))

        val inactiveStats = object : ModelPackageUsageStats {
            override fun isModelActive(modelId: String, version: String) = false
            override fun modelBytes(modelId: String, version: String) = 0L
            override fun indexBytes(modelId: String, version: String) = 0L
            override fun indexedLorebookCount(modelId: String, version: String) = 0
            override fun indexedEntryCount(modelId: String, version: String) = 0
        }
        val remove = UninstallRequest("bge-m3", "1.0.0", removeIndexes = true)
        val removeHint = ModelPackageUninstall.hint(remove, ModelPackageUninstall.impact(remove, inactiveStats))
        assertFalse("没有索引时不该硬编数字吓用户", removeHint.contains("0 本世界书"))
        assertTrue("没有索引就直说没有：$removeHint", removeHint.contains("没有需要连带删除的语义索引"))
    }

    @Test
    fun deletionsNeverContainUserContent() {
        val withIndexes = ModelPackageUninstall.deletions(UninstallRequest("bge-m3", "1.0.0", removeIndexes = true))
        assertEquals("删除清单只允许模型文件与其派生索引", listOf("模型文件:bge-m3@1.0.0", "语义索引:bge-m3@1.0.0"), withIndexes)

        val withoutIndexes = ModelPackageUninstall.deletions(UninstallRequest("bge-m3", "1.0.0", removeIndexes = false))
        assertEquals("保留索引时删除清单只有模型文件", listOf("模型文件:bge-m3@1.0.0"), withoutIndexes)
    }
}
