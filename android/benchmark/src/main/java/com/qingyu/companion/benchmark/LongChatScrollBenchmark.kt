package com.qingyu.companion.benchmark

import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.ExperimentalMetricApi
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * G-01 长聊天滚动基准：长列表 fling 帧稳定性 + 流式 chunk 帧稳定性。
 *
 * 场景（实施文档 §G-01）：
 *  - 长列表 fling（大会话快速滚动，FrameTimingMetric 统计掉帧）；
 *  - 100ms chunk 连续 60 秒的流式渲染帧稳定性（流式只重组 streaming item）。
 *
 * TODO：真机接入后填充——预置超长会话数据，用 UiAutomator 执行 fling 手势，
 * 并以 FrameTimingMetric 采集；流式场景需 mock PC 推送 100ms 间隔 chunk。
 * 当前为占位骨架，保证模块可编译。
 */
@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalMetricApi::class)
class LongChatScrollBenchmark {

    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    @Test
    fun flingLongChatList() {
        benchmarkRule.measureRepeated(
            packageName = PACKAGE_NAME,
            metrics = listOf(FrameTimingMetric()),
            compilationMode = CompilationMode.DEFAULT,
            startupMode = StartupMode.COLD,
            iterations = 5,
        ) {
            // TODO: 打开超长会话 -> UiAutomator fling 滚动 -> 等待 settle
            android.util.Log.d(TAG, "LongChatScrollBenchmark placeholder (fling)")
        }
    }

    @Test
    fun streamingChunkFrameStability() {
        benchmarkRule.measureRepeated(
            packageName = PACKAGE_NAME,
            metrics = listOf(FrameTimingMetric()),
            compilationMode = CompilationMode.DEFAULT,
            startupMode = StartupMode.COLD,
            iterations = 5,
        ) {
            // TODO: 模拟 PC 侧 100ms chunk 连续 60 秒 -> 帧稳定性采集
            android.util.Log.d(TAG, "LongChatScrollBenchmark placeholder (streaming)")
        }
    }

    private companion object {
        const val PACKAGE_NAME = "com.qingyu.companion"
        const val TAG = "QingyuBenchmark"
    }
}
