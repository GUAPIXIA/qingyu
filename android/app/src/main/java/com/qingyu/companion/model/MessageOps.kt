package com.qingyu.companion.model

/**
 * 消息列表合并操作（纯函数，便于 JVM 单测）。
 * 约定：列表按时间**降序**存储（最新在前），配合 LazyColumn(reverseLayout=true) 展示。
 */
object MessageOps {

    /** 去重 + 按时间降序插入（最新在前）：流式 done / 编辑 / swipe 结果回写共用 */
    fun upsert(list: List<Message>, message: Message): List<Message> =
        (list.filterNot { it.id == message.id } + message)
            .sortedByDescending { it.timestamp }

    /** 合并分页结果：去重 + 按时间降序（历史分页追加） */
    fun merge(list: List<Message>, incoming: List<Message>): List<Message> =
        (list + incoming)
            .distinctBy { it.id }
            .sortedByDescending { it.timestamp }

    /** 删除单条 */
    fun remove(list: List<Message>, messageId: String): List<Message> =
        list.filterNot { it.id == messageId }

    /** 按 id 更新单条（翻译回写等），返回新列表 */
    fun replace(list: List<Message>, message: Message): List<Message> =
        list.map { if (it.id == message.id) message else it }
}
