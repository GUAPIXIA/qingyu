package com.qingyu.companion.chatcore

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 阶段 4 S4-01：跨语言 golden fixture 读取器。
 *
 * fixture 由 TypeScript（PC）侧生成（见 `shared/__tests__/chatCoreGolden.test.ts`），
 * 存放于 `shared/fixtures/cross-platform/chat-core/`；本读取器把 JSON 转成 Kotlin 原生结构，
 * 供 `ChatCoreGoldenTest` 逐字段断言与 TS 输出一致。
 *
 * 注意：读取器只承载**测试数据**，不进入生产路径（不注册到 AppContainer）。
 * 解析使用 Android 平台自带的 `org.json`，避免为测试引入额外依赖。
 */
object ChatCoreFixtures {

    private const val RELATIVE = "shared/fixtures/cross-platform/chat-core"

    /** 从 Gradle 工作目录向上查找仓库根下的 fixture 目录；找不到时抛出带候选路径的错误。 */
    fun directory(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, RELATIVE)
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("找不到 chat-core fixture 目录（相对路径 $RELATIVE）；请确认 shared/fixtures 存在且测试工作目录可上溯到仓库根")
    }

    fun text(name: String): String = File(directory(), "$name.json").readText()

    fun obj(name: String): JSONObject = JSONObject(text(name))

    /**
     * 归一化为 Kotlin 原生值：
     * JSONObject -> LinkedHashMap<String, Any?>，JSONArray -> List<Any?>，
     * 数字按有无小数点/指数决定 Long 或 Double；`JSONObject.NULL` -> null。
     *
     * 顺序保留（LinkedHashMap），因此可直接与 TS 生成的对象做结构化比较。
     */
    fun normalize(value: Any?): Any? = when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> {
            val map = LinkedHashMap<String, Any?>()
            for (key in value.keys()) map[key] = normalize(value.get(key))
            map
        }
        is JSONArray -> (0 until value.length()).map { normalize(value.get(it)) }
        is Int -> value.toLong()
        is Long -> value
        is Double -> if (value == Math.floor(value) && !value.isInfinite() && value.isNaN().not() && value.toString().endsWith(".0")) {
            // JSON 里写成 1.0 的值保持 Double，写成 1 的值已是 Long；此处不做猜测转换
            value
        } else {
            value
        }
        else -> value
    }

    fun cases(name: String): List<Map<String, Any?>> {
        val root = normalize(obj(name)) as Map<*, *>
        @Suppress("UNCHECKED_CAST")
        val list = root["cases"] as? List<Map<String, Any?>> ?: emptyList()
        return list
    }

    fun root(name: String): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return normalize(obj(name)) as Map<String, Any?>
    }

    /** 取字符串字段（缺省为 null）。 */
    fun str(map: Map<*, *>, key: String): String? = map[key] as? String

    fun intOrNull(map: Map<*, *>, key: String): Int? = (map[key] as? Number)?.toInt()

    fun boolOrNull(map: Map<*, *>, key: String): Boolean? = map[key] as? Boolean

    @Suppress("UNCHECKED_CAST")
    fun mapOrNull(map: Map<*, *>, key: String): Map<String, Any?>? = map[key] as? Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    fun listOrNull(map: Map<*, *>, key: String): List<Any?>? = map[key] as? List<Any?>
}
