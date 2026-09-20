package com.qingyu.companion.local.db

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 阶段 3/4：Room 导出 schema 的守卫。
 *
 * 为什么需要它：导出的 schema JSON 是迁移测试的唯一可信基线——
 * `MemoryMigrationAndCasInstrumentedTest` 用 `MigrationTestHelper.createDatabase(name, 1)`
 * 从 `1.json` 造出老版本库，再用 `runMigrationsAndValidate(name, 2, ...)` 与 `2.json` 校验迁移结果。
 * 一旦导出被关掉或 schema 目录被移走/删除，迁移测试就失去基线校验能力，
 * 而**编译与常规门禁都不会报错**。
 *
 * ## 本守卫能保证什么、不能保证什么（不要过度信任它）
 * - **能**：`exportSchema = true` 仍然开着；每个声明版本的 schema 文件在本地存在
 *   （覆盖「关掉导出」「删掉/移走 schema 目录」「schemaLocation 配错」）。
 * - **不能**：「文件是否已提交到仓库」。Room 在编译期**自己会写出**缺失版本的 JSON，
 *   因此「提升版本后忘记导出」在本地根本不会出现——已用版本号突变验证过：
 *   把 `version = 2` 改成 3 后编译直接产出 `3.json`，本守卫依旧通过。
 *   提交与否属于流程环节，只能在提交时核对，见实施报告。
 */
class RoomSchemaExportGuardTest {

    private data class DatabaseDecl(
        val simpleName: String,
        val packageName: String,
        val version: Int,
        val exportSchema: Boolean,
    )

    @Test
    fun `每个导出 schema 的数据库都必须存在对应版本的 schema 文件`() {
        val declarations = scanDatabaseDeclarations()
        assertTrue("必须至少扫描到 QingyuLocalDatabase（否则守卫空跑）", declarations.isNotEmpty())
        assertTrue(
            "必须扫描到本地权威库",
            declarations.any { it.simpleName == "QingyuLocalDatabase" },
        )

        val checked = mutableListOf<String>()
        for (decl in declarations) {
            if (!decl.exportSchema) continue
            val expected = File(
                schemaRoot(),
                "${decl.packageName}.${decl.simpleName}/${decl.version}.json",
            )
            assertTrue(
                "缺少导出 schema：${expected.path}（版本 ${decl.version}）。" +
                    "提升 @Database version 后必须重新编译导出，且该文件必须随仓库保留——" +
                    "迁移测试以它为基线，缺文件不会让门禁变红，只会让迁移校验静默失效。",
                expected.exists(),
            )
            checked += "${decl.simpleName}@${decl.version}"
        }
        assertTrue("至少要校验到本地权威库的 schema", checked.any { it.startsWith("QingyuLocalDatabase@") })
    }

    @Test
    fun `本地权威库与缓存库都必须开启 schema 导出`() {
        // 关掉导出让迁移测试失去基线，且不会有任何构建错误；这条断言专门挡住它
        val declarations = scanDatabaseDeclarations().associateBy { it.simpleName }
        for (name in listOf("QingyuLocalDatabase", "CacheDatabase")) {
            val decl = declarations[name]
            assertTrue("必须扫描到 $name（否则守卫空跑）", decl != null)
            assertTrue(
                "$name 必须声明 exportSchema = true——否则迁移测试没有可信基线，" +
                    "而关掉导出不会让任何门禁变红",
                decl!!.exportSchema,
            )
        }
    }

    @Test
    fun `本地权威库的 v1 基线与 v2 现状必须同时存在`() {
        // v1 是阶段 3 的落地基线，v2 由阶段 4 S4-05 引入；两者缺一，迁移测试就无法成立
        val v1 = File(schemaRoot(), "com.qingyu.companion.local.db.QingyuLocalDatabase/1.json")
        val v2 = File(schemaRoot(), "com.qingyu.companion.local.db.QingyuLocalDatabase/2.json")
        assertTrue("v1 基线必须存在（迁移测试的起点）", v1.exists())
        assertTrue("v2 现状必须存在（迁移校验的终点）", v2.exists())
        assertTrue("v1 基线不能是空文件", v1.length() > 1000)
        assertTrue("v2 现状不能是空文件", v2.length() > 1000)
    }

    /**
     * schema 根目录：Gradle 单测的工作目录是**模块目录**（`android/app`），
     * 但不同运行方式（IDE / CI / 根目录执行）可能是仓库根，因此探测多个候选。
     */
    private fun schemaRoot(): File {
        val candidates = listOf(File("schemas"), File("app/schemas"), File("android/app/schemas"))
        return candidates.firstOrNull { File(it, "com.qingyu.companion.local.db.QingyuLocalDatabase").exists() }
            ?: error(
                "找不到 Room schema 根目录（工作目录=${File(".").absolutePath}）；" +
                    "候选=${candidates.joinToString { it.path }}",
            )
    }

    private fun scanDatabaseDeclarations(): List<DatabaseDecl> {
        val root = listOf(File("src/main/java"), File("app/src/main/java"))
            .firstOrNull { it.exists() }
            ?: error("找不到源目录（工作目录=${File(".").absolutePath}）")
        val files = root.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        val declarations = mutableListOf<DatabaseDecl>()
        for (file in files) {
            val text = file.readText()
            val annotationIndex = text.indexOf("@Database(")
            if (annotationIndex < 0) continue
            // 注解可能带参数、后跟多个注解或类声明：取注解之后的一段做版本/导出解析
            val window = text.substring(annotationIndex, minOf(text.length, annotationIndex + 2000))
            val version = Regex("version\\s*=\\s*(\\d+)").find(window)?.groupValues?.get(1)?.toInt() ?: continue
            val exportSchema = Regex("exportSchema\\s*=\\s*(true|false)")
                .find(window)?.groupValues?.get(1)?.toBoolean() ?: false
            val packageName = Regex("package\\s+([\\w.]+)").find(text)?.groupValues?.get(1) ?: continue
            val classMatch = Regex("(?:abstract\\s+)?class\\s+(\\w+)\\s*:\\s*RoomDatabase")
                .find(window) ?: continue
            declarations += DatabaseDecl(
                simpleName = classMatch.groupValues[1],
                packageName = packageName,
                version = version,
                exportSchema = exportSchema,
            )
        }
        return declarations
    }
}
