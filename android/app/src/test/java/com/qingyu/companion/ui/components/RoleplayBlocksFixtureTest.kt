package com.qingyu.companion.ui.components

import com.qingyu.companion.network.NetworkModule
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 阶段7.2（方案 §6.2/§6.3）：语义分块跨端契约测试（Android 半边）。
 *
 * fixture 单处权威 = repo 根 shared/fixtures/roleplay-blocks.json；
 * 本目录 android/app/src/test/resources/fixtures/ 为**副本**。
 * 修改分块规则时必须先改 shared/fixtures/ 再同步副本，PC（roleplayBlocksFixture.test.ts）
 * 与本测试同时跑绿。Kotlin 分块器（RoleplayBlocks.kt）对同一输入必须得到
 * 相同块数量与块类型（dialogue 还要求 speaker 一致）。
 */
class RoleplayBlocksFixtureTest {

    private val json = NetworkModule.json

    private fun fixture(name: String): String {
        val raw = javaClass.classLoader?.getResourceAsStream("fixtures/$name")
            ?.bufferedReader()?.use { it.readText() }
            ?: error("缺少契约 fixture: fixtures/$name（权威副本 shared/fixtures/$name）")
        return raw
    }

    private fun actualSummary(blocks: List<RoleplayBlock>): List<String> = blocks.map { block ->
        when (block) {
            is RoleplayBlock.Dialogue -> "dialogue|${block.speaker ?: ""}|${block.text}"
            is RoleplayBlock.Narration -> "narration||${block.text}"
            is RoleplayBlock.Thought -> "thought||${block.text}"
            is RoleplayBlock.Mixed -> "mixed||${block.text}"
        }
    }

    private fun expectedSummary(expected: JsonArray): List<String> = expected.map { item ->
        val obj = item.jsonObject
        val kind = obj.getValue("kind").jsonPrimitive.content
        val text = obj.getValue("text").jsonPrimitive.content
        val speaker = obj["speaker"]?.jsonPrimitive?.content ?: ""
        "$kind|$speaker|$text"
    }

    @Test
    fun `共享 fixture 全量样本块数量与类型一致`() {
        val root = json.parseToJsonElement(fixture("roleplay-blocks.json")).jsonObject
        val cases = root.getValue("cases").jsonArray
        assertEquals("fixture 样本量至少 30", true, cases.size >= 30)
        val mismatches = mutableListOf<String>()
        for (caseValue in cases) {
            val case = caseValue.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            val input = case.getValue("input").jsonPrimitive.content
            val expected = case.getValue("expected").jsonArray
            val actual = actualSummary(RoleplayBlocks.build(input))
            val want = expectedSummary(expected)
            if (actual != want) {
                mismatches.add("[$name]\n  expected=$want\n  actual  =$actual")
            }
        }
        assertEquals("Kotlin 分块与共享 fixture 不一致：\n${mismatches.joinToString("\n")}", emptyList<String>(), mismatches)
    }

    @Test
    fun `contentRenderMode 缺省时不误分块（调用方走 Markdown 兼容渲染）`() {
        // 渲染开关由 UI 层按字段判断；分块器本身只保证确定性
        assertEquals(emptyList<RoleplayBlock>(), RoleplayBlocks.build(""))
        assertEquals(emptyList<RoleplayBlock>(), RoleplayBlocks.build(null))
    }
}
