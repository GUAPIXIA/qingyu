package com.qingyu.companion.embedding

/**
 * 阶段 6 S6-05 模型包四条硬要求的第四条：**卸载影响提示**。
 *
 * 对齐 PC `electron/services/localModels/manager.ts#uninstallImpact` 的读数口径
 * （`active` / `modelBytes` / `indexBytes` / `lorebookCount` / `entryCount`），
 * 并补一条 Android 特有但必须说出口的事实：**索引与模型包都不同步、不进备份主数据**
 * （总方案 §6.1），删掉的只是派生缓存，正文与关键词世界书一条不少——
 * 用户听到「会删索引」的第一反应是「我的世界书会不会没」，提示必须先回答这个。
 */

/** 模型包与其索引的占用读数（存储/索引注册表提供，测试用替身）。 */
interface ModelPackageUsageStats {
    /** 该版本是否是当前启用的本地向量模型。 */
    fun isModelActive(modelId: String, version: String): Boolean

    fun modelBytes(modelId: String, version: String): Long

    fun indexBytes(modelId: String, version: String): Long

    /** 该模型版本建立过语义索引的世界书数量。 */
    fun indexedLorebookCount(modelId: String, version: String): Int

    /** 该模型版本索引过的条目（含事实）数量。 */
    fun indexedEntryCount(modelId: String, version: String): Int
}

/** 卸载影响（PC `LocalModelUninstallImpact` 同字段）。 */
data class UninstallImpact(
    val active: Boolean,
    val modelBytes: Long,
    val indexBytes: Long,
    val lorebookCount: Int,
    val entryCount: Int,
)

/** 卸载请求（PC `LocalModelUninstallRequest` 同形状：是否连带删除索引）。 */
data class UninstallRequest(
    val modelId: String,
    val version: String,
    val removeIndexes: Boolean,
)

object ModelPackageUninstall {

    /** 汇总卸载影响。 */
    fun impact(
        request: UninstallRequest,
        stats: ModelPackageUsageStats,
    ): UninstallImpact = UninstallImpact(
        active = stats.isModelActive(request.modelId, request.version),
        modelBytes = stats.modelBytes(request.modelId, request.version),
        indexBytes = stats.indexBytes(request.modelId, request.version),
        lorebookCount = stats.indexedLorebookCount(request.modelId, request.version),
        entryCount = stats.indexedEntryCount(request.modelId, request.version),
    )

    /**
     * 卸载影响提示（界面确认文案）。三个必答点：
     * 1. 释放多少空间、当前是否正在使用（正在使用 → 语义检索将降级，**关键词世界书不受影响**）；
     * 2. 会删多少索引（按 [UninstallRequest.removeIndexes] 分两种口径）；
     * 3. 索引是派生缓存、可从世界书/记忆数据重建，正文不丢。
     */
    fun hint(request: UninstallRequest, impact: UninstallImpact): String {
        val parts = mutableListOf<String>()
        parts += "将释放模型占用 ${mb(impact.modelBytes)} MB"
        if (impact.active) {
            parts += "该模型正在使用中，卸载后语义检索将降级为关键词/词法检索（关键词世界书不受影响）"
        }
        if (request.removeIndexes) {
            if (impact.lorebookCount > 0 || impact.entryCount > 0) {
                parts += "同时删除其建立的语义索引：${impact.lorebookCount} 本世界书、${impact.entryCount} 条条目（约 ${mb(impact.indexBytes)} MB）"
            } else {
                parts += "该模型没有需要连带删除的语义索引"
            }
        } else {
            parts += "保留其语义索引（约 ${mb(impact.indexBytes)} MB），安装同版本模型后可直接复用"
        }
        parts += "语义索引与模型包都是本地派生缓存、不参与同步，可随时从世界书/记忆数据重建，卸载不会删除世界书、记忆与聊天记录"
        return parts.joinToString("；") + "。"
    }

    /** 卸载实际删除的内容清单（接线层据此执行，测试据此断言「正文永不在删除清单里」）。 */
    fun deletions(request: UninstallRequest): List<String> {
        val items = mutableListOf("模型文件:${request.modelId}@${request.version}")
        if (request.removeIndexes) items += "语义索引:${request.modelId}@${request.version}"
        return items
    }

    private fun mb(bytes: Long): Long = bytes / 1024 / 1024
}
