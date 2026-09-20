package com.qingyu.companion.content

import com.qingyu.companion.local.domain.JsonValues
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 §3：角色卡的**整条**三跳链「PC 导入 → Android 导出 → PC 再导入」（及反向），
 * 输入是阶段 0 冻结的卡（V1 裸卡 / V2 内嵌世界书 / V3）。
 *
 * 为什么已有 `character-card-validation`、`png-chunks`、`png-export-base` 还不够：
 * 那三份钉的是**单步**（判定、chunk 读写、导出基底）。单步全对不等于链对——
 * 导入读错一个字段、导出少写一个键、或者「导出的文件再导入一次就变味」，
 * 都要靠把整条链跑一遍才会红。§4 的完成定义写的正是「P0 格式往返不丢语义」。
 *
 * fixture 由 `shared/__tests__/contentIoGolden.test.ts` 用 PC 真实函数生成：
 * PC 从阶段 0 的卡导入 → 导出成文件文本 → 再导入 → 再导出。
 * 本类做 Android 侧对应的三步，并把两边对齐。
 *
 * 用 Robolectric 跑：编解码与用例都直接吃 `org.json`，纯 JVM 下是「not mocked」桩。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class CharacterCardChainGoldenTest {

    private val cases = ContentIoFixtures.cases("character-card-roundtrip")

    /** 跳 1+2：同一张卡，Android 导出的那份必须就是 PC 导出的那份。 */
    @Test
    fun androidExportOfImportedCardMatchesPcExport() {
        forEachImportable { label, case ->
            val fromOriginal = androidExportOf(case.getString("cardText"), label)
            assertEquals(
                canonical(case.getString("pcExport")),
                canonical(fromOriginal),
                "$label：Android 导入原始卡再导出的内容，与 PC 导出的不一致（同一张卡两端会给出两份不同的文件）",
            )
        }
    }

    /**
     * 逐字节档：两端导出文本完全相同。
     *
     * 语义相等（上一条）就足够证明「不丢语义」；字节相等更强，强到值得单独一条——
     * 一旦哪一侧改了缩进/键序/转义，用户拿到的文件名相同内容却不同，
     * 而那种差异在语义比较下是隐形的。
     */
    @Test
    fun androidExportIsByteIdenticalToPcExport() {
        forEachImportable { label, case ->
            val fromOriginal = androidExportOf(case.getString("cardText"), label)
            assertEquals(
                case.getString("pcExport"),
                fromOriginal,
                "$label：导出文本不再是逐字节相同（语义仍相等，但两端写出的文件已不是同一份字节）",
            )
        }
    }

    /** 跳 3 的反向：Android 读 PC 导出的那份，再导一次，必须还是同一份。 */
    @Test
    fun androidReimportsPcExportWithoutDrift() {
        forEachImportable { label, case ->
            val first = androidExportOf(case.getString("cardText"), label)
            val second = androidExportOf(case.getString("pcExport"), label)
            assertEquals(
                canonical(first),
                canonical(second),
                "$label：Android 读 PC 导出的卡之后再导出，内容就变了（往返有损）",
            )
            assertEquals(
                canonical(case.getString("pcReExport")),
                canonical(second),
                "$label：PC 自己二次导出的结果与 Android 读回后的再导出不一致",
            )
        }
    }

    /** fixture 里 PC 自身的往返幂等标记也进门禁，不停留在注释。 */
    @Test
    fun pcSideOfTheChainIsImportableAndIdempotent() {
        var importable = 0
        cases.forEach { case ->
            val label = case.getString("label")
            if (!case.optBoolean("ok", false)) {
                assertTrue(
                    case.optString("error").isNotEmpty(),
                    "$label：PC 导入失败却没有原因记录",
                )
                return@forEach
            }
            importable += 1
            assertTrue(case.getBoolean("exportStable"), "$label：PC 自己的导出→导入→导出已经不幂等，链的第三跳无从谈起")
        }
        assertEquals(3, importable, "三份阶段 0 角色卡都必须能被 PC 导入，否则这条链是空跑")
    }

    // ---------------------------------------------------------------- 内部

    private fun androidExportOf(cardText: String, label: String): String {
        val result = CharacterCardCodec.importJson(cardText)
        val draft = (result as? CharacterCardCodec.ImportResult.Success)?.draft
        assertNotNull(draft, "$label：PC 能导入的卡 Android 却拒了：${(result as? CharacterCardCodec.ImportResult.Rejected)?.reason}")
        // PC 的导出实现写死 V2（`spec: chara_card_v2`），所以链上比的是 V2 档；
        // Android 另有 V3 档（PC 无对应导出），那条档位不在本链的断言范围内。
        return CharacterCardCodec.exportV2Json(requireNotNull(draft))
    }

    private fun forEachImportable(body: (String, JSONObject) -> Unit) {
        cases.forEach { case ->
            if (!case.optBoolean("ok", false)) return@forEach
            body(case.getString("label"), case)
        }
        assertTrue(cases.any { it.optBoolean("ok", false) }, "角色卡三跳 fixture 里一条可导入样本都没有")
    }

    /** 比较走 canonical JSON：两端文本缩进与键序都不该影响「是不是同一份数据」。 */
    private fun canonical(jsonText: String): String =
        ContentIoFixtures.canonical(JsonValues.parseObject(jsonText))
}
