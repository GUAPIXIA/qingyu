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
 * G-01 冷启动基准：从进程冷启动到 MainShell 可交互。
 *
 * 运行前提：
 *  - 真机（Macrobenchmark 需要 profileable 目标，模拟器性能不代表真机）；
 *  - 安装被测 app：`./gradlew :app:installDebug`
 *  - 执行：`./gradlew :benchmark:connectedBenchmarkAndroidTest`
 *    （androidx.benchmark 插件自动为 :app 生成 profileable 变体并安装）
 *
 * 指标：TimeToInitialDisplay（TTID）/ TimeToFullDisplay（TTFD），
 * 覆盖冷启动 -> MainShell（MainActivity 是启动入口，UI 树含 CompanionNavHost/MainShell）。
 *
 * TODO(G-02/G-03 后续)：本方法体为官方模板占位（见类注释），待真机接入后
 * 补充 startActivityAndWait + measureRepeated 的完整测量逻辑，并验证
 * Compose 首帧渲染（ProfileInstaller 已由 profileinstaller 依赖注入）。
 */
@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalMetricApi::class)
class StartupBenchmark {

    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    @Test
    fun startupColdToMainShell() {
        benchmarkRule.measureRepeated(
            packageName = PACKAGE_NAME,
            metrics = listOf(StartupTimingMetric()),
            compilationMode = CompilationMode.DEFAULT,
            startupMode = StartupMode.COLD,
            iterations = 5,
        ) {
            // TODO: 真机 profileable 构建下启动 MainActivity 并等待首帧
            // startActivityAndWait(Intent().setComponent(...))
            // 当前为占位：保证模块可编译、可 assemble、无设备时任务 no-op
            android.util.Log.d(TAG, "StartupBenchmark placeholder")
        }
    }

    private companion object {
        const val PACKAGE_NAME = "com.qingyu.companion"
        const val TAG = "QingyuBenchmark"
    }
}
