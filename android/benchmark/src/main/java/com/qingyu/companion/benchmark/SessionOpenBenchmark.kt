package com.qingyu.companion.benchmark

import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.ExperimentalMetricApi
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * G-01 会话打开基准：打开 200/1000 条消息的会话列表到首屏可见。
 *
 * 场景（实施文档 §G-01）：
 *  - 冷启动到缓存会话可见；
 *  - 打开 200/1000 条消息会话（本地缓存，离线可读）。
 *
 * TODO：真机接入后在此填充——预置 200/1000 条消息的会话数据
 * （经 adb 或测试专属注入路径），然后 startActivityAndWait + measureRepeated。
 * 当前为占位骨架，保证模块可编译。
 */
@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalMetricApi::class)
class SessionOpenBenchmark {

    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    @Test
    fun openSession200Messages() {
        benchmarkRule.measureRepeated(
            packageName = PACKAGE_NAME,
            metrics = listOf(StartupTimingMetric()),
            compilationMode = CompilationMode.DEFAULT,
            startupMode = StartupMode.COLD,
            iterations = 5,
        ) {
            // TODO: 预置 200 条消息的会话 -> 启动 -> 等待会话列表渲染 -> 打开会话
            android.util.Log.d(TAG, "SessionOpenBenchmark placeholder (200)")
        }
    }

    @Test
    fun openSession1000Messages() {
        benchmarkRule.measureRepeated(
            packageName = PACKAGE_NAME,
            metrics = listOf(StartupTimingMetric()),
            compilationMode = CompilationMode.DEFAULT,
            startupMode = StartupMode.COLD,
            iterations = 5,
        ) {
            // TODO: 预置 1000 条消息的会话 -> 启动 -> 等待会话列表渲染 -> 打开会话
            android.util.Log.d(TAG, "SessionOpenBenchmark placeholder (1000)")
        }
    }

    private companion object {
        const val PACKAGE_NAME = "com.qingyu.companion"
        const val TAG = "QingyuBenchmark"
    }
}
