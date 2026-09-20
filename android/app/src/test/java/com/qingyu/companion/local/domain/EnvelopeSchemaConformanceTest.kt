package com.qingyu.companion.local.domain

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阶段 5：**同步信封与冻结 schema 的一致性**（Android 侧）。
 *
 * ## 为什么需要它
 * `LocalEnvelope` 是 Android 写进 change journal 的**规范实体信封**，真值来自阶段 1 冻结的
 * `shared/contracts/schemas/sync-envelope.schema.json`（`additionalProperties:false` +
 * 11 个 `required`）。而这条路径此前**没有任何机械检查**：信封里少了 `parentId` 与
 * `schemaVersion`（两个必填键）却一直没人发现——因为 Android 只写不读，跨端 payload golden
 * 只管 payload 不管信封，而契约套件比的是「Room 与替身是否相同」（两边同样缺，所以一致地错）。
 *
 * 后果不是「不一致」这么轻：`parentId` 是 §6.3 跨实体不变量（角色—会话—消息、会话—记忆）
 * 的**唯一来源**，Sync Core 要靠它做 delete fence / 孤儿检测；`schemaVersion` 是 payload
 * 迁移注册表（`shared/contracts/migrations.ts` 只允许 N→N+1）的入口。少了这两个键，
 * 阶段 7 既无法判定依赖冲突，也无法判断该不该跑迁移。
 *
 * ## 判据
 * 直接读**同一份 schema 文件**逐项核对：必填键齐全、无额外键、`contractVersion` 为常量、
 * `entityType` 在枚举内、`dot` 恰为 `{deviceId, counter}`、所有 counter 是十进制字符串、
 * `contentHash` 形态正确。schema 一改，这里立刻红——这正是「契约驱动」该有的样子。
 */
class EnvelopeSchemaConformanceTest {

    private fun schemaFile(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, RELATIVE)
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        error("找不到 $RELATIVE（从 ${File("").absolutePath} 向上查找）")
    }

    private val schema: JsonObject by lazy {
        Json.parseToJsonElement(schemaFile().readText(Charsets.UTF_8)).jsonObject
    }

    private fun envelopeWith(parentId: String?): JsonObject {
        val envelope = LocalEnvelope(
            entityType = EntityTypes.MESSAGE,
            entityId = "m-1",
            payload = mapOf("content" to "你好"),
            deviceId = "android-a",
            counter = "7",
            version = mapOf("android-a" to "7", "pc-b" to "3"),
            parentId = parentId,
            schemaVersion = 2,
        )
        return Json.parseToJsonElement(envelope.toJson()).jsonObject
    }

    @Test
    fun emittedEnvelopeSatisfiesTheFrozenSchema() {
        val properties = schema["properties"]!!.jsonObject
        val required = schema["required"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertTrue("schema 的 required 没读到（否则本测试形同空跑）", required.size >= 10)

        for (parentId in listOf(null, "char-1")) {
            val envelope = envelopeWith(parentId)
            val label = "parentId=$parentId"

            val missing = required.filterNot { it in envelope.keys }
            assertTrue(
                "$label：信封缺少契约必填键 $missing（阶段 7 会读到非法信封）",
                missing.isEmpty(),
            )
            val extra = envelope.keys - properties.keys
            assertTrue(
                "$label：信封出现契约未声明的键 $extra（schema 是 additionalProperties:false）",
                extra.isEmpty(),
            )

            assertEquals("$label：contractVersion 必须是常量 1", 1, envelope["contractVersion"]!!.jsonPrimitive.int)
            val entityTypeEnum = properties["entityType"]!!.jsonObject["enum"]!!.jsonArray
                .map { it.jsonPrimitive.content }
            assertTrue(
                "$label：entityType 必须在 schema 枚举内，实际 ${envelope["entityType"]}",
                envelope["entityType"]!!.jsonPrimitive.content in entityTypeEnum,
            )

            // counter 必须是「无前导零的 UInt64 十进制字符串」，不能经过 JVM Long 的有损转换
            val counterPattern = Regex("^(0|[1-9][0-9]*)$")
            val dot = envelope["dot"]!!.jsonObject
            assertEquals("$label：dot 只能有 deviceId 与 counter", setOf("deviceId", "counter"), dot.keys)
            assertTrue(
                "$label：dot.counter 必须是十进制字符串，实际 ${dot["counter"]}",
                counterPattern.matches(dot["counter"]!!.jsonPrimitive.content),
            )
            envelope["version"]!!.jsonObject.values.forEach { value ->
                assertTrue(
                    "$label：version 计数必须是十进制字符串，实际 $value",
                    counterPattern.matches(value.jsonPrimitive.content),
                )
            }
            assertTrue(
                "$label：contentHash 必须是 sha256:<64 hex>，实际 ${envelope["contentHash"]}",
                Regex("^sha256:[0-9a-f]{64}$").matches(envelope["contentHash"]!!.jsonPrimitive.content),
            )

            val emittedParent = (envelope["parentId"] as? JsonNull)?.let { null }
                ?: envelope["parentId"]!!.jsonPrimitive.contentOrNull
            assertEquals("$label：parentId 必须原样出现在信封里", parentId, emittedParent)
            assertEquals("$label：schemaVersion 必须原样出现在信封里", 2, envelope["schemaVersion"]!!.jsonPrimitive.int)
        }
    }

    /**
     * 「缺键」这件事单独钉一条：`parentId`/`schemaVersion` 曾经**根本不在 toJson 的输出里**，
     * 而它们恰好是 §6.3 依赖的两个键。删掉任一个都会让上一条测试红，这里再把语义说清楚。
     */
    @Test
    fun parentAndSchemaVersionAreCarriedNotJustAllowed() {
        val child = envelopeWith("sess-1")
        assertEquals("sess-1", child["parentId"]!!.jsonPrimitive.content)
        assertEquals(2, child["schemaVersion"]!!.jsonPrimitive.int)
        // 顶层实体允许 parentId 为 null，但**键必须在**（契约 required 里有它）
        val topLevel = envelopeWith(null)
        assertTrue("parentId 键必须存在（值可以是 null）", "parentId" in topLevel.keys)
        assertTrue("顶层实体的 parentId 应是显式 null", topLevel["parentId"] is JsonNull)
    }

    private companion object {
        private const val RELATIVE = "shared/contracts/schemas/sync-envelope.schema.json"
    }
}
