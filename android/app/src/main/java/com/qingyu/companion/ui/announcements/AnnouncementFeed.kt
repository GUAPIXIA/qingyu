package com.qingyu.companion.ui.announcements

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.toCompanionError
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.Announcement
import com.qingyu.companion.model.AnnouncementPage
import kotlinx.coroutines.CancellationException

/**
 * S6-07 公告获取降级通道（纯逻辑，JVM 可测；本地可用、离线不崩）。
 *
 * 公告与版本检查在获取失败时**必须降级**：返回上次列表（或空）+ 可行动提示，
 * 绝不把异常抛给 UI 造成崩溃。UI 接线由主代理完成（见报告「建议接线点」）。
 */

/** 公告获取结果 */
sealed interface AnnouncementFeedResult {
    /** 获取成功 */
    data class Loaded(val items: List<Announcement>) : AnnouncementFeedResult

    /** 获取失败降级：cached=上次列表（可能为空），notice=用户可读提示（本地提示不崩） */
    data class Degraded(val cached: List<Announcement>, val notice: String) : AnnouncementFeedResult
}

/** 公告源（窄接口，适配 ChatRepository.listAnnouncements） */
fun interface AnnouncementSource {
    suspend fun listAnnouncements(): AnnouncementPage
}

class AnnouncementFeed(private val source: AnnouncementSource) {

    /** 上次成功列表（离线回退缓存） */
    private var lastItems: List<Announcement> = emptyList()

    suspend fun load(): AnnouncementFeedResult = try {
        val items = source.listAnnouncements().items
        lastItems = items
        AnnouncementFeedResult.Loaded(items)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        AnnouncementFeedResult.Degraded(cached = lastItems, notice = noticeFor(e))
    }

    private fun noticeFor(e: Exception): String {
        val error: CompanionError = e.toCompanionError()
        return error.userMessage()
    }
}
