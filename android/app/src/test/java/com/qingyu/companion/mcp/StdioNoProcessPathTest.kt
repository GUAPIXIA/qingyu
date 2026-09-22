package com.qingyu.companion.mcp

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * stdio「无任何进程启动路径」源码守卫（S6-06 / 总方案 §3.2 架构禁令）。
 *
 * 双保险：
 * 1. 本守卫扫描 mcp／＊＊ 全部主源码（星号全角：避免 /＊ 触发 Kotlin 嵌套注释），任何进程启动 API（ProcessBuilder / Runtime.exec / spawn 等）
 *    一旦出现即失败——「看起来没启动」不等于「没有启动路径」；
 * 2. 行为侧（McpPlatformPolicyTest / McpTransportTest / McpServerManagerTest）验证
 *    stdio 只保留配置可见性且所有连接路径抛 McpStdioForbiddenException。
 */
class StdioNoProcessPathTest {

    private val forbiddenTokens = listOf(
        "ProcessBuilder",
        "Runtime.getRuntime",
        "getRuntime()",
        "android.os.Process",
        "ProcessImpl",
        ".exec(",
        "spawn(",
        "cmd.exe",
        "/bin/sh",
    )

    private fun locateMcpMainSources(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        repeat(6) {
            val candidate = File(dir, "src/main/java/com/qingyu/companion/mcp")
            if (candidate.isDirectory) return candidate
            dir = dir?.parentFile
        }
        throw AssertionError("未找到 mcp 主源码目录（user.dir=${System.getProperty("user.dir")}），源码守卫无法执行")
    }

    @Test
    fun `mcp 包不存在任何本地进程启动 API`() {
        val root = locateMcpMainSources()
        val files = root.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue(files.isNotEmpty(), "mcp 主源码目录为空，说明模块没被实现，不能以空目录通过守卫")

        val violations = mutableListOf<String>()
        for (file in files) {
            val text = file.readText(Charsets.UTF_8)
            for (token in forbiddenTokens) {
                if (text.contains(token)) {
                    violations += "${file.name} 含进程启动 API 片段: $token"
                }
            }
        }
        assertTrue(
            violations.isEmpty(),
            "Android 绝不启动本地进程（架构禁令）：${violations.joinToString("；")}",
        )
    }

    @Test
    fun `stdio 配置字段只出现在数据模型与可见性路径`() {
        // command/args/env 是 PC 专有字段的本地可见性镜像；它们不得出现在任何 transport/client 实现里。
        val root = locateMcpMainSources()
        val runtimeFiles = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { it.parentFile.name == "transport" || it.parentFile.name == "client" }
            .toList()
        assertTrue(runtimeFiles.isNotEmpty(), "transport/client 实现缺失，无法验证 stdio 字段未进入运行路径")
        val violations = runtimeFiles.filter { file ->
            val text = file.readText(Charsets.UTF_8)
            text.contains("config.command") || text.contains("config.args") || text.contains("config.env")
        }
        assertTrue(
            violations.isEmpty(),
            "运行路径不得消费 stdio 专有字段（command/args/env）：${violations.joinToString { it.name }}",
        )
    }
}
