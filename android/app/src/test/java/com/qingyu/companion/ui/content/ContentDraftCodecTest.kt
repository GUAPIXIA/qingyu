package com.qingyu.companion.ui.content

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import java.lang.reflect.Parameter
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 §2 草稿区的行编解码。
 *
 * 草稿要的是「回到原位继续写」，所以这里验的是**逐列无损**：任何一列在 encode→decode 之后
 * 变了值，用户看到的都是「我明明填了，回来没了」。
 *
 * 三条用例的分工刻意不同：
 * - [everyColumnSurvivesRoundTrip] 用反射造行，不手写构造函数参数：新加一列会自动被喂进来；
 * - [codecCoversEveryRoomColumn] 是**防漏守卫**——有人给实体加了列却忘了补 codec，
 *   JSON 的键数就会少一个，这条当场变红；靠人记得改测试是守不住的；
 * - [clearedColumnIsNotTheSameAsMissingOne] 盯住「null vs 缺键」，
 *   这是最容易被 `optString` 悄悄吞掉的一类：清空头像会被恢复成「从没设过」。
 *
 * 用 Robolectric 跑：codec 直接吃 `org.json`，纯 JVM 下拿到的是「not mocked」桩。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ContentDraftCodecTest {

    private class Case(
        val label: String,
        val entity: Class<*>,
        val encode: (Any) -> String,
        val decode: (String) -> Any?,
    )

    private val cases: List<Case>
        get() = listOf(
            case("角色", LocalCharacterEntity::class.java, ContentDraftCodec::encodeCharacter, ContentDraftCodec::decodeCharacter),
            case("世界书", LocalLorebookEntity::class.java, ContentDraftCodec::encodeLorebook, ContentDraftCodec::decodeLorebook),
            case("预设", LocalPresetEntity::class.java, ContentDraftCodec::encodePreset, ContentDraftCodec::decodePreset),
            case("人设", LocalPersonaEntity::class.java, ContentDraftCodec::encodePersona, ContentDraftCodec::decodePersona),
            case("正则", LocalRegexRuleEntity::class.java, ContentDraftCodec::encodeRegexRule, ContentDraftCodec::decodeRegexRule),
            case(
                "快捷回复集合",
                LocalQuickReplySetEntity::class.java,
                ContentDraftCodec::encodeQuickReplySet,
                ContentDraftCodec::decodeQuickReplySet,
            ),
        )

    /** 六个 codec 的真实签名带实体类型，遍历用例时统一收在 `Any` 上（[Case.entity] 保证类型对得上）。 */
    @Suppress("UNCHECKED_CAST")
    private fun <T : Any> case(
        label: String,
        entity: Class<T>,
        encode: (T) -> String,
        decode: (String) -> T?,
    ) = Case(label, entity, { row -> encode(row as T) }, { json -> decode(json) })

    @Test
    fun everyColumnSurvivesRoundTrip() {
        cases.forEach { case ->
            val row = sampleRow(case.label, case.entity, blankNullables = false)
            val back = case.decode(case.encode(row))
            assertEquals(row, back, "${case.label} 的草稿往返不是逐列无损：encode→decode 改写了列值")
        }
    }

    /** 可空列全给 null 的一遍：可空列如果只能存「有值」，那和上一遍合不起来。 */
    @Test
    fun everyColumnSurvivesRoundTripWithNullablesCleared() {
        cases.forEach { case ->
            val row = sampleRow(case.label, case.entity, blankNullables = true)
            val back = case.decode(case.encode(row))
            assertEquals(row, back, "${case.label} 的草稿在可空列为 null 时丢信息")
        }
    }

    @Test
    fun codecCoversEveryRoomColumn() {
        cases.forEach { case ->
            val row = sampleRow(case.label, case.entity, blankNullables = false)
            val columns = case.entity.declaredFields
                .filterNot { it.isSynthetic || java.lang.reflect.Modifier.isStatic(it.modifiers) }
            val written = JSONObject(case.encode(row)).length()
            assertEquals(
                columns.size,
                written,
                "${case.label} 的草稿 codec 与实体列数不一致：实体有 ${columns.size} 列，" +
                    "codec 只写了 $written 个键。加了列要同时补 ContentDraftCodec 的 encode/decode。",
            )
        }
    }

    @Test
    fun clearedColumnIsNotTheSameAsMissingOne() {
        val base = sampleRow("角色", LocalCharacterEntity::class.java, blankNullables = false)
            as LocalCharacterEntity
        val cleared = base.copy(avatarPath = null, lorebookId = null)
        val restored = ContentDraftCodec.decodeCharacter(ContentDraftCodec.encodeCharacter(cleared))
        assertEquals(null, restored?.avatarPath, "清空头像被恢复成了「从没设过」")
        assertEquals(null, restored?.lorebookId, "解绑世界书被恢复成了「从没绑过」")

        // 空串是「填了又删干净」，与 null 不是一回事，两者不能互相塌陷
        val emptied = base.copy(avatarPath = "", lorebookId = "")
        val restoredEmpty = ContentDraftCodec.decodeCharacter(ContentDraftCodec.encodeCharacter(emptied))
        assertEquals("", restoredEmpty?.avatarPath)
        assertEquals("", restoredEmpty?.lorebookId)
    }

    /** 坏草稿不该挡住编辑器：解析不出来就当没有草稿，回到库里那一行。 */
    @Test
    fun malformedDraftsDecodeToNullInsteadOfThrowing() {
        listOf("{", "not json", "[]", "", "{}").forEach { broken ->
            assertNull(ContentDraftCodec.decodeCharacter(broken), "坏草稿「$broken」应该被当成没有草稿")
            assertNull(ContentDraftCodec.decodeLorebook(broken))
            assertNull(ContentDraftCodec.decodePreset(broken))
            assertNull(ContentDraftCodec.decodePersona(broken))
            assertNull(ContentDraftCodec.decodeRegexRule(broken))
            assertNull(ContentDraftCodec.decodeQuickReplySet(broken))
        }
        // 没有 id 的行无处安放：草稿键里也没有 id，恢复出来会写错行
        assertTrue(ContentDraftCodec.decodeCharacter("""{"name":"无 id"}""") == null)
    }

    // ---------------------------------------------------------------- 反射造行

    /**
     * 用主构造器造一行「每列都有值」的实体。
     *
     * 为什么反射：手写六个构造函数在加列时会自动漏掉那一列，`everyColumnSurvivesRoundTrip`
     * 就会绿着放过——正是这次改动最容易引入的错。反射把「新列」变成「必须被 codec 认识的列」。
     *
     * 构造函数要按「参数表与列集合完全一致」来挑，不能 `single()`：带默认值的 data class
     * 还会生成一个 `(列…, Int mask, DefaultConstructorMarker)` 的合成构造器，`single()` 直接红。
     */
    private fun sampleRow(label: String, entity: Class<*>, blankNullables: Boolean): Any {
        val columns = entity.declaredFields
            .filterNot { it.isSynthetic || java.lang.reflect.Modifier.isStatic(it.modifiers) }
        val ctor = entity.declaredConstructors.firstOrNull { candidate ->
            candidate.parameterTypes.size == columns.size &&
                candidate.parameterTypes.toList() == columns.map { it.type }
        } ?: error(
            "$label 找不到与列集合一一对应的构造函数：列 ${columns.map { it.type.simpleName }}，" +
                "构造器 ${entity.declaredConstructors.map { it.parameterTypes.toList().map { p -> p.simpleName } }}",
        )
        val args = ctor.parameters.mapIndexed { index, parameter ->
            sampleValue(label, parameter, index, blankNullables)
        }
        return ctor.newInstance(*args.toTypedArray())
    }

    private fun sampleValue(label: String, parameter: Parameter, index: Int, blankNullables: Boolean): Any? {
        val type = parameter.type
        val nullable = !type.isPrimitive && parameter.annotations.any {
            it.annotationClass.java.name.endsWith(".Nullable")
        }
        if (nullable && blankNullables) return null
        // id 必须非空：codec 用「有没有 id」判定草稿是否可用
        val value: Any = when (type) {
            String::class.java -> if (index == 0) "draft-$index" else "列-$index"
            java.lang.Integer::class.java, Int::class.javaPrimitiveType -> index + 7
            java.lang.Long::class.java, Long::class.javaPrimitiveType -> (index + 7) * 1000L
            java.lang.Boolean::class.java, Boolean::class.javaPrimitiveType -> true
            java.lang.Double::class.java, Double::class.javaPrimitiveType -> 0.25
            java.lang.Float::class.java, Float::class.javaPrimitiveType -> 0.5f
            else -> error("$label 出现了草稿 codec 还不认识的列类型 ${type.name}：补 ContentDraftCodec")
        }
        return value
    }
}
