package com.qingyu.companion.domain.contracts

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * 与 shared/contracts/fixtures/canonical/golden-cases.json 对齐的契约测试。
 * 资源路径：从仓库相对路径读取（Android 单测工作目录为 android/）。
 */
class CanonicalJsonGoldenTest {

    @Test
    fun emptyObject() {
        assertEquals("{}", CanonicalJson.encode(emptyMap<String, Any?>()))
    }

    @Test
    fun keyOrderSorted() {
        val value = linkedMapOf<String, Any?>(
            "b" to 1,
            "a" to linkedMapOf("z" to true, "y" to null),
            "c" to listOf(1, 2, mapOf("k" to "v")),
        )
        assertEquals(
            "{\"a\":{\"y\":null,\"z\":true},\"b\":1,\"c\":[1,2,{\"k\":\"v\"}]}",
            CanonicalJson.encode(value),
        )
    }

    @Test
    fun negativeZero() {
        assertEquals("0", CanonicalJson.encode(-0.0))
    }

    @Test
    fun maxSafeInteger() {
        assertEquals("9007199254740991", CanonicalJson.encode(9007199254740991L))
    }

    @Test
    fun floatExponent() {
        assertEquals("1e-7", CanonicalJson.encode(1e-7))
    }

    @Test
    fun escapeQuotes() {
        assertEquals("\"q\\\"\\\\n\"", CanonicalJson.encode("q\"\\n"))
    }

    @Test
    fun arrayOrderPreserved() {
        assertEquals("[3,1,2]", CanonicalJson.encode(listOf(3, 1, 2)))
    }

    @Test
    fun emojiAndCjk() {
        assertEquals("{\"s\":\"你好👋\"}", CanonicalJson.encode(mapOf("s" to "你好👋")))
    }

    @Test
    fun goldenFileExists() {
        val cwd = File(".").absolutePath
        val paths = listOf(
            File("../shared/contracts/fixtures/canonical/golden-cases.json"),
            File("../../shared/contracts/fixtures/canonical/golden-cases.json"),
            File("shared/contracts/fixtures/canonical/golden-cases.json"),
            File("D:/Code/qingyu/shared/contracts/fixtures/canonical/golden-cases.json"),
        )
        val file = paths.firstOrNull { it.exists() && it.length() > 0 }
        org.junit.Assert.assertTrue(
            "golden fixture not found cwd=$cwd tried=${paths.map { it.absolutePath }}",
            file != null,
        )
    }
}
