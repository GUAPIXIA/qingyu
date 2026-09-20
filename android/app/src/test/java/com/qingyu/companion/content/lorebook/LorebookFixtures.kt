package com.qingyu.companion.content.lorebook

import com.qingyu.companion.local.domain.JsonValues
import java.io.File

/**
 * 测试用的 PC fixture 读取器。
 *
 * 为什么直接读 PC 的 fixture 而不是在 Kotlin 里另写一份：
 * 方案 §S5-02 末句要求「格式检测、导入结果和导出再导入语义必须与 PC fixture 一致」，
 * 复制一份样本到 `android/app/src/test/resources` 就变成了两份真相——
 * PC 侧改了 fixture，Android 这边还会绿灯。所以这里按仓库根定位
 * `tests/lorebook/fixtures/`（**同一批字节**），并在 `catalog.json` 上复用
 * PC 自己冻结的期望值（name / entries / importable）。
 *
 * 定位方式：从测试工作目录逐级上溯找 `tests/lorebook/fixtures/catalog.json`。
 * Gradle 的单元测试工作目录默认是模块目录（`android/app`），上溯两级就是仓库根；
 * 从 `android/` 或仓库根跑也一样能找到。找不到时**直接失败并说明原因**——
 * 静默跳过这些用例等于把跨端一致性门禁关掉。
 */
object LorebookFixtures {

    private val fixtureRoot: File by lazy {
        generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "tests/lorebook/fixtures") }
            .firstOrNull { File(it, "catalog.json").isFile }
            ?: throw IllegalStateException(
                "找不到 PC 世界书 fixture 目录 tests/lorebook/fixtures：" +
                    "跨端一致性用例必须跑在 PC 的同一批样本上，不能退化为本地副本。" +
                    "user.dir=${System.getProperty("user.dir")}",
            )
    }

    /** `catalog.json` 的一条记录（只取用例真正需要的字段）。 */
    data class Entry(
        val id: String,
        val path: String,
        val format: String,
        val version: String,
        val kind: String,
        val importable: Boolean,
        val nativeValid: Boolean,
        val entries: Int,
        val name: String,
    )

    val catalog: List<Entry> by lazy {
        val root = JsonValues.parseObject(File(fixtureRoot, "catalog.json").readText())
        val fixtures = JsonValues.parseArray(root["fixtures"].let { JsonValues.stringify(it) })
        fixtures.map { item ->
            val record = item as Map<*, *>
            val expected = record["expected"] as Map<*, *>
            Entry(
                id = record["id"] as String,
                path = record["path"] as String,
                format = record["format"] as String,
                version = record["version"] as String,
                kind = record["kind"] as String,
                importable = expected["importable"] as Boolean,
                nativeValid = expected["nativeValid"] as Boolean,
                entries = (expected["entries"] as Number).toInt(),
                name = expected["name"] as String,
            )
        }
    }

    fun entry(id: String): Entry = catalog.firstOrNull { it.id == id }
        ?: throw IllegalStateException("fixture 不存在: $id")

    /** fixture 原文。 */
    fun text(id: String): String = File(fixtureRoot, entry(id).path).readText()

    /** fixture 解析后的值（与适配器收到的完全同一个对象图）。 */
    fun value(id: String): Any? {
        val parsed = LorebookJson.parse(text(id))
            ?: throw IllegalStateException("fixture 解析失败: $id")
        return parsed
    }
}
