package com.qingyu.companion.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.qingyu.companion.local.domain.MigrationIdentity
import kotlinx.coroutines.flow.first

private val Context.contentDraftDataStore by preferencesDataStore(name = "companion_content_drafts")

/** 草稿写入的判定结果。**拒绝必须带原因**：静默不写等于悄悄丢掉用户的自动保存。 */
enum class DraftWrite {
    ACCEPTED,

    /** 单条就超过上限。 */
    TOO_LARGE,

    /** 单条没超，但加上已有草稿会把整个 DataStore 顶过总量上限。 */
    OVER_BUDGET,
}

/**
 * 阶段 5 §2：内容编辑器的**草稿区**。
 *
 * 「编辑器自动保存必须写草稿区，不把每次键入都发布成同步变更」——这条要求有两半：
 * 1. 键入不能变成业务变更（`EditorDraft.commit` 已经保证：不点保存就不落库、不记账）；
 * 2. 自动保存**要有地方落**。在补齐本类之前，第二半其实没做：草稿只活在 ViewModel 里，
 * 手机上被系统回收进程、或用户切去聊天再回来，一篇写到一半的世界书就整篇没了——
 * 而这恰恰是移动端最常见的中断方式。
 *
 * 键按「实体类型 + 实体 id」分开：同一种实体可以同时有多个未保存草稿（编辑 A 时去看 B），
 * 用聊天输入框那种 `draft_<sessionId>` 的扁平键会互相覆盖。分区名与 `EntityTypes` 同名。
 *
 * 值是 [com.qingyu.companion.ui.content.ContentDraftCodec] 写出的 JSON，
 * **不是**同步层的 payload：payload 是按 PC 契约裁出来的稀疏白名单，
 * 拿它当草稿会静默丢掉只有本机才有的列（头像路径、内嵌世界书、卡片规范版本…）。
 *
 * 容量上限（[MAX_DRAFT_BYTES] / [MAX_DRAFT_TOTAL_BYTES]）是这里刻意加的第二层：
 * Preferences DataStore 把整份偏好**全量驻留内存**，且每次写都**整文件重写**。
 * 没有上限时，一本接近 2 MiB 的世界书草稿会把「每 300 ms 一次」的自动保存变成持续的大块重写，
 * 而多条草稿累加后这个文件再也降不下来。上限不做淘汰——**淘汰等于丢用户没保存的东西**——
 * 只拒绝新写入并让界面说明原因。
 */
interface ContentDraftStore {
    /** @return 是否真的落下了；被拒时调用方必须把原因显示给用户（见 [DraftWrite]）。 */
    suspend fun put(kind: String, entityId: String, json: String): DraftWrite

    suspend fun get(kind: String, entityId: String): String?

    suspend fun clear(kind: String, entityId: String)

    /** 单条草稿上限：直接取同步契约的单条 payload 上限，不另发明一个数。 */
    companion object {
        const val MAX_DRAFT_BYTES: Int = MigrationIdentity.MAX_PAYLOAD_BYTES

        /** 草稿区总量上限：留 4 条满额草稿的余量，再多就拒绝而不是淘汰。 */
        const val MAX_DRAFT_TOTAL_BYTES: Long = 4L * MAX_DRAFT_BYTES
    }
}

private fun utf8Size(value: String): Int = value.toByteArray(Charsets.UTF_8).size

/** DataStore 实现：写盘与崩溃安全都由 DataStore 负责，这里只管键名与容量判定。 */
class PreferencesContentDraftStore(private val context: Context) : ContentDraftStore {

    private fun key(kind: String, entityId: String) = stringPreferencesKey("$kind#$entityId")

    /**
     * 判定放在 `edit` 里：它跑在 DataStore 自己的写互斥内，
     * 所以「读到的其它草稿大小 + 这一条」与随后的写入之间不会被并发改动钻空子。
     */
    override suspend fun put(kind: String, entityId: String, json: String): DraftWrite {
        val size = utf8Size(json)
        if (size > ContentDraftStore.MAX_DRAFT_BYTES) return DraftWrite.TOO_LARGE
        var outcome = DraftWrite.ACCEPTED
        val target = key(kind, entityId)
        context.contentDraftDataStore.edit { prefs ->
            val others = prefs.asMap()
                .filterKeys { it.name != target.name }
                .values.sumOf { value -> (value as? String)?.let(::utf8Size) ?: 0 }
            if (others + size > ContentDraftStore.MAX_DRAFT_TOTAL_BYTES) {
                outcome = DraftWrite.OVER_BUDGET
            } else {
                prefs[target] = json
            }
        }
        return outcome
    }

    override suspend fun get(kind: String, entityId: String): String? =
        context.contentDraftDataStore.data.first()[key(kind, entityId)]

    override suspend fun clear(kind: String, entityId: String) {
        context.contentDraftDataStore.edit { it.remove(key(kind, entityId)) }
    }
}
