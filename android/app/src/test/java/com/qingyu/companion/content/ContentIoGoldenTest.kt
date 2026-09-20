package com.qingyu.companion.content

import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.domain.EntityPayloads
import com.qingyu.companion.domain.contracts.CanonicalJson
import com.qingyu.companion.local.domain.JsonValues
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 内容管理 golden 的读取工具。
 *
 * 真值文件在 `shared/fixtures/cross-platform/content-io/`，由
 * `shared/__tests__/contentIoGolden.test.ts` 用 **PC 实现**（oracle）生成。
 * 这里把 fixture 里的 JSON 值转成与 Kotlin 实现输出同构的值，
 * 比较统一走 [CanonicalJson] 文本——`org.json` 会把 `11` 解成 `Int`、
 * `11.0` 解成 `Double`，直接比对象会因装箱差异出现假失败。
 *
 * 下方两个用例类都跑在 Robolectric 上：fixture 读取与被测编解码都用 `org.json`，
 * 那是 Android 框架类，纯 JVM 单测里只有「not mocked」桩。
 */
object ContentIoFixtures {
    private const val RELATIVE = "shared/fixtures/cross-platform/content-io"

    /** 与 `ChatCoreFixtures` 同样向上找仓库根（Gradle 的 cwd 可能是 `android/` 或 `android/app/`）。 */
    private fun directory(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, RELATIVE)
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        throw IllegalStateException(
            "找不到 $RELATIVE（从 ${File("").absolutePath} 向上查找）；" +
                "先运行 TS 生成器：$ CONTENT_IO_UPDATE_FIXTURES=1 pnpm exec vitest run shared/__tests__/contentIoGolden.test.ts",
        )
    }

    fun root(name: String): JSONObject = JSONObject(File(directory(), "$name.json").readText(Charsets.UTF_8))

    fun cases(name: String): List<JSONObject> {
        val array = root(name).getJSONArray("cases")
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    fun canonical(value: Any?): String = CanonicalJson.encode(value)

    /** org.json 值 → Kotlin 值（对象/数组/标量/NULL）。 */
    fun toValue(raw: Any?): Any? = when (raw) {
        null, JSONObject.NULL -> null
        is JSONObject -> JsonValues.parseObject(raw.toString())
        is JSONArray -> JsonValues.parseArray(raw.toString())
        else -> raw
    }

    /** fixture 里某个键的值；键不存在返回 null。 */
    fun valueOf(obj: JSONObject, key: String): Any? = if (obj.isNull(key)) null else toValue(obj.get(key))

    fun stringOf(obj: JSONObject, key: String): String? = if (obj.isNull(key)) null else obj.optString(key)

    fun stringListOf(obj: JSONObject, key: String): List<String> =
        (obj.optJSONArray(key) ?: JSONArray()).let { array -> (0 until array.length()).map { array.getString(it) } }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class PresetCodecGoldenTest {

    private val cases = ContentIoFixtures.cases("preset-normalize")

    @Test
    fun normalizeMatchesPcForEveryGoldenCase() {
        for (case in cases) {
            val label = case.getString("label")
            val input = ContentIoFixtures.valueOf(case, "input")
            if (!case.getBoolean("ok")) {
                val error = runCatching { PresetCodec.normalize(input) }.exceptionOrNull()
                assertNotNull(error, "$label：PC 判定失败，Kotlin 却成功了")
                assertEquals(ContentIoFixtures.stringOf(case, "error"), error?.message, "$label：错误文案不一致")
                continue
            }
            val actual = PresetCodec.normalize(input)
            val expected = ContentIoFixtures.valueOf(case, "preset") as Map<*, *>
            assertEquals(
                ContentIoFixtures.canonical(expected),
                ContentIoFixtures.canonical(actual),
                "$label：预设正文与 PC 不一致（会直接改变 contentHash）",
            )
        }
    }

    @Test
    fun optionalKeysAreOmittedRatherThanNullFilled() {
        val case = cases.first { it.getString("label") == "optional-keys-invalid-are-omitted" }
        val body = PresetCodec.normalize(ContentIoFixtures.valueOf(case, "input"))
        // 下发空串/非法枚举会变成另一个 payload、另一个哈希，所以必须是「没有这个键」
        assertTrue("group" !in body, "空白 group 被下发成键")
        assertTrue("contextTemplate" !in body, "空白 contextTemplate 被下发成键")
        assertTrue("exampleDialogMode" !in body, "非法 exampleDialogMode 被下发成键")
        assertEquals("auto", body["responseLengthHint"])
    }

    @Test
    fun roundingAndClampingFollowJsMathRound() {
        val halfUp = cases.first { it.getString("label") == "rounds-half-up" }
        val actual = PresetCodec.normalize(ContentIoFixtures.valueOf(halfUp, "input"))
        assertEquals(11L, (actual["maxContext"] as Number).toLong(), "10.5 应向 +∞ 取半得 11")
        assertEquals(3L, (actual["maxTokens"] as Number).toLong(), "2.5 应得 3")

        val down = cases.first { it.getString("label") == "rounds-down-below-half" }
        val downBody = PresetCodec.normalize(ContentIoFixtures.valueOf(down, "input"))
        assertEquals(10L, (downBody["maxContext"] as Number).toLong(), "10.4 应得 10")
        assertEquals(3L, (downBody["maxTokens"] as Number).toLong(), "3.49 应得 3")
    }

    @Test
    fun nonFiniteInputsFallBackToDefaults() {
        // 哨兵字符串（TS 侧 NaN/Infinity 的编码）必须走回退分支，而不是被解析成某个数
        val case = cases.first { it.getString("label") == "falls-back-on-non-finite" }
        val body = PresetCodec.normalize(ContentIoFixtures.valueOf(case, "input"))
        assertEquals(0.8, (body["temperature"] as Number).toDouble())
        assertEquals(0.95, (body["topP"] as Number).toDouble())
        assertEquals(0L, (body["maxContext"] as Number).toLong())
    }

    @Test
    fun importedPresetMatchesPcGolden() {
        for (case in ContentIoFixtures.cases("preset-import")) {
            val label = case.getString("label")
            val input = ContentIoFixtures.valueOf(case, "input")
            val options = ContentIoFixtures.valueOf(case, "options") as Map<*, *>
            if (!case.getBoolean("ok")) {
                val error = runCatching {
                    PresetCodec.normalizeImported(input, options["id"] as String, options["fallbackName"] as String)
                }.exceptionOrNull()
                assertNotNull(error, "$label：PC 判定失败，Kotlin 却成功了")
                continue
            }
            val actual = PresetCodec.normalizeImported(
                input,
                options["id"] as String,
                options["fallbackName"] as String,
            )
            assertEquals(ContentIoFixtures.stringOf(case, "sourceFormat"), actual.sourceFormat, "$label：来源格式判定不一致")
            assertEquals(ContentIoFixtures.stringListOf(case, "unsupportedFields"), actual.unsupportedFields, "$label：未识别字段报告不一致")
            assertEquals(
                ContentIoFixtures.canonical(ContentIoFixtures.valueOf(case, "preset") as Map<*, *>),
                ContentIoFixtures.canonical(actual.body),
                "$label：归一化正文不一致",
            )
        }
    }

    /**
     * §3 的整条链：**PC 导入 → Android 导出 → PC 再导入**（外加 Android 自己的反向流程）。
     *
     * `importedPresetMatchesPcGolden` 只钉第一跳。方案 §3 要的是整条链，
     * §4 的完成定义写着「P0 格式往返不丢语义」——只测导入的话，
     * 「导入实现对齐、导出把某一列写歪」和「导出的文件再导入一次就变味」都能绿过去。
     *
     * 三步各自钉住：
     * 1. Android 的导入结果 == PC 的导入结果（同一份外部 JSON）；
     * 2. Android 用**生产代码**的 payload 构造器（`EntityPayloads.presetPayload`，就是进 contentHash
     *    的那一份）导出的 payload == fixture 里 PC 的 payload；
     * 3. Android 读回自己导出的内容、再导出一次，payload 不变，且 == PC 二次导入自己导出后的 payload。
     *
     * 比较一律走 canonical JSON：payload 是顺序敏感的 Map，键顺序由 `sync-payload` 那组管，
     * 这里要回答的只是「同一份预设两台设备算出来是不是同一件事」。
     */
    @Test
    fun presetChainPcImportAndroidExportPcReimport() {
        for (case in ContentIoFixtures.cases("preset-roundtrip")) {
            val label = case.getString("label")
            val options = ContentIoFixtures.valueOf(case, "options") as Map<*, *>
            val id = options["id"] as String
            val fallbackName = options["fallbackName"] as String

            val imported = PresetCodec.normalizeImported(ContentIoFixtures.valueOf(case, "input"), id, fallbackName)
            assertEquals(
                ContentIoFixtures.canonical(ContentIoFixtures.valueOf(case, "importedPreset")),
                ContentIoFixtures.canonical(imported.body),
                "$label：Android 的导入结果与 PC 不一致",
            )

            val exported = PresetCodec.bodyJsonOf(imported.body)
            val androidPayload = EntityPayloads.presetPayload(presetRow(id, exported))
            assertEquals(
                ContentIoFixtures.canonical(ContentIoFixtures.valueOf(case, "importedPayload")),
                ContentIoFixtures.canonical(androidPayload),
                "$label：Android 导出的预设 payload 与 PC 不等——同一条预设两端会算出不同 contentHash",
            )

            val reread = PresetCodec.normalizeImported(PresetCodec.bodyOf(exported), id, fallbackName)
            val rereadPayload = EntityPayloads.presetPayload(presetRow(id, PresetCodec.bodyJsonOf(reread.body)))
            assertEquals(
                ContentIoFixtures.canonical(androidPayload),
                ContentIoFixtures.canonical(rereadPayload),
                "$label：Android 自己的导出→读回就已经变了",
            )
            assertEquals(
                ContentIoFixtures.canonical(ContentIoFixtures.valueOf(case, "reimportedPayload")),
                ContentIoFixtures.canonical(rereadPayload),
                "$label：PC 再导入 Android 的导出后与 PC 自己的往返不等价（往返有语义损失）",
            )
        }
    }

    /** 只填 payload 会读到的列；其余走实体默认值，避免测试把无关列的默认值钉死。 */
    private fun presetRow(id: String, bodyJson: String): LocalPresetEntity = LocalPresetEntity(
        id = id,
        name = "",
        bodyJson = bodyJson,
        createdAt = 0L,
        updatedAt = 0L,
    )
}


@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class PngTextChunksGoldenTest {

    private val cases = ContentIoFixtures.cases("png-chunks")

    @Test
    fun mimeSniffingChunkReadingAndChunkWritingMatchPc() {
        for (case in cases) {
            val label = case.getString("label")
            val bytes = java.util.Base64.getMimeDecoder().decode(case.getString("bytesBase64"))
            assertEquals(case.getString("mimeType"), PngTextChunks.detectMimeType(bytes), "$label：MIME 判定不一致")

            val chunks = PngTextChunks.read(bytes)
            assertEquals(
                ContentIoFixtures.canonical(ContentIoFixtures.valueOf(case, "chunks") as Map<*, *>),
                ContentIoFixtures.canonical(chunks),
                "$label：文本段解析结果不一致",
            )
            assertEquals(ContentIoFixtures.stringOf(case, "chara"), chunks["chara"], "$label：chara 段不一致")
            assertEquals(ContentIoFixtures.stringOf(case, "ccv3"), chunks["ccv3"], "$label：ccv3 段不一致")

            val written = PngTextChunks.writeTextChunk(bytes, "chara", "eyJ3aWRlIjp0cnVlfQ==")
            assertEquals(
                case.getString("afterWriteBase64"),
                java.util.Base64.getEncoder().encodeToString(written),
                "$label：写段后的字节不一致（插入位置或 CRC 有偏差）",
            )
            assertEquals(
                ContentIoFixtures.stringOf(case, "roundTripsAfterWrite"),
                PngTextChunks.read(written)["chara"],
                "$label：写后再读不一致",
            )
        }
    }

    @Test
    fun exportBaseIsAStructurallySoundPng() {
        val fixture = ContentIoFixtures.root("png-export-base")
        val base = java.util.Base64.getMimeDecoder().decode(fixture.getString("blankPngBase64"))
        assertEquals(listOf("IHDR", "IDAT", "IEND"), PngTextChunks.chunkTypes(base))
        // 曾经的 PC 常量把 IDAT 长度写成 11（实际 13），按块遍历会在 IEND 前脱轨，
        // 导致「PC 导出的角色卡 PC 自己导不回去」。这里把结构合法性钉死。
        val embedded = PngTextChunks.writeTextChunk(base, "chara", "e30=")
        assertTrue(
            java.util.Base64.getEncoder().encodeToString(embedded) == fixture.getString("embeddedBase64"),
            "chara 段插入位置或 CRC 与 PC 不一致",
        )
        assertEquals("e30=", PngTextChunks.read(embedded)["chara"])
    }

    @Test
    fun unknownPrivateChunksSurviveAWrite() {
        // 方案 S5-01 要求「未知字段保留」：写 chara 段不能丢掉别人家的 chunk
        val case = cases.first { it.getString("label") == "ccv3-and-unknown-chunks-preserved" }
        val bytes = java.util.Base64.getMimeDecoder().decode(case.getString("bytesBase64"))
        val written = PngTextChunks.writeTextChunk(bytes, "chara", "e30=")
        assertTrue(PngTextChunks.chunkTypes(written).contains("caGX"), "未知私有段被写段操作丢掉了")
        assertEquals("eyJiIjoyfQ==", PngTextChunks.read(written)["ccv3"], "原有 ccv3 段应保留")
    }
}
