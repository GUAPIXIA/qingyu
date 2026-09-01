package com.qingyu.companion.ui.usage

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.UsageRecordDto
import com.qingyu.companion.model.UsageSummary
import com.qingyu.companion.ui.components.LoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E-02 用量页 LoadState 投影单测：
 * 「有内容」= 累计汇总存在（PC 侧开启用量统计的标志）；records 为空仍算有内容。
 */
class UsageLoadStateTest {

    private val summary = UsageSummary(totalInput = 10, totalOutput = 20, totalChars = 30, count = 2)
    private val records = listOf(
        UsageRecordDto(
            id = "r1", timestamp = 0L, characterId = "c1", sessionId = "s1",
            model = "test-model", inputChars = 1, outputChars = 2, totalChars = 3,
        ),
    )

    @Test
    fun `加载中无数据投影为Loading`() {
        val st = projectUsageLoadState(loading = true, error = null, data = UsageViewModel.UsageData())
        assertEquals(LoadState.Loading, st)
    }

    @Test
    fun `累计汇总存在投影为Content`() {
        val data = UsageViewModel.UsageData(today = summary, total = summary, records = emptyList())
        val st = projectUsageLoadState(loading = false, error = null, data = data)
        assertEquals(LoadState.Content(data, refreshing = false), st)
    }

    @Test
    fun `无汇总且未加载投影为Empty`() {
        val st = projectUsageLoadState(
            loading = false,
            error = null,
            data = UsageViewModel.UsageData(records = records),
        )
        assertEquals(LoadState.Empty, st)
    }

    @Test
    fun `失败且无数据投影为Error且可重试`() {
        val st = projectUsageLoadState(
            loading = false,
            error = CompanionError.Offline(),
            data = UsageViewModel.UsageData(),
        )
        assertTrue(st is LoadState.Error)
        assertTrue((st as LoadState.Error).retryable)
    }

    @Test
    fun `网络类失败但有上次数据投影为Offline`() {
        val data = UsageViewModel.UsageData(today = summary, total = summary, records = records)
        val st = projectUsageLoadState(loading = false, error = CompanionError.Timeout(), data = data)
        assertEquals(LoadState.Offline(data), st)
    }
}
