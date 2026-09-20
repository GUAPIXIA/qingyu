package com.qingyu.companion.local.domain

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * 阶段 5 S5-01..S5-07：内容管理域的跨层契约类型。
 *
 * 这里只放**被两个仓储实现（Room 与测试替身）共同依赖**的纯函数与值类型：
 * 任何只在其中一侧成立的语义，都会在阶段 7 变成「同一份数据两端算出不同哈希」，
 * 所以口径必须写在一处、两侧同读。
 */

/**
 * 删除影响范围（方案 §2「删除均显示影响范围」）。
 *
 * UI 必须先拿到影响数字再决定二次确认文案，所以计数与删除是两次调用；
 * 两次调用之间引用可能变化，因此**删除入口自己再做一次解绑**，不依赖这里的快照。
 */
data class BindingImpact(
    val characters: Int,
    val sessions: Int,
) {
    /** `true` 表示可以走「无引用直接删」分支，不需要向用户显示影响清单。 */
    val isEmpty: Boolean
        get() = characters == 0 && sessions == 0
}

/** S5-07 用量统计维度（方案：按模型、角色、日期和成功/失败分类）。 */
enum class UsageDimension {
    MODEL,
    PROVIDER,
    CHARACTER,
    DATE,
    STATUS,
}

/**
 * S5-07 清空用量的结果。
 *
 * 必须把**保留**的 id 一并回传：因果上未被支配的记录是并发写入的新事件，
 * 调用方据此区分「清理成功」与「清理把新数据也删了」，否则用户只能靠猜。
 */
data class UsageClearResult(
    val clearedIds: List<String>,
    val retainedIds: List<String>,
)

/**
 * 角色列表排序列白名单（S5-01）。
 *
 * `LocalCharacterDao.search` 的 `ORDER BY` 用 `CASE WHEN :sortBy = 'name' …` 展开，
 * 因为 SQLite 的绑定参数不能当标识符用；**任何新排序值都要同时改 SQL 与这里**，
 * 少了任一处都是静默错序，而不是报错。UI 传的 token 一律先过 [resolve]。
 */
object CharacterSortColumn {
    const val NAME = "name"
    const val CREATED = "created"
    const val UPDATED = "updated"

    /** 与 `LocalCharacterDao.search` 里的 `:sortBy` 分支逐字一致。 */
    val ALLOWED: Set<String> = setOf(NAME, CREATED, UPDATED)

    /** 未知/缺省 token 回落到 `name`（列表默认序），绝不把原始输入透给查询。 */
    fun resolve(token: String?): String = ALLOWED.firstOrNull { it == token } ?: NAME
}

/**
 * 版本向量（`{deviceId: UInt64 十进制字符串}`）上的因果比较与合并（总方案 §6.2/§6.3）。
 *
 * counter **不得经过 Long/Int**：UInt64 的上界超出 `Long`，一旦中途转数值就会溢出成
 * 负数或回绕，把「更新的版本」判成更旧，进而把并发数据当成已清理数据删掉。
 * 因此这里全部按十进制文本比较（先比长度、再比字典序）。
 */
object CounterVectors {

    /** 与 `shared/contracts/schemas/usage-clear-marker-payload.schema.json` 的 pattern 一致。 */
    private val DECIMAL_PATTERN = Regex("^(0|[1-9][0-9]*)$")

    fun isCanonical(counter: String): Boolean = DECIMAL_PATTERN.matches(counter)

    /** 非法 counter 直接拒绝：静默修正会让两端哈希永久对不上。 */
    fun requireCanonical(counter: String): String {
        if (!isCanonical(counter)) {
            throw IllegalArgumentException("counter 必须是十进制无符号字符串（无前导零）：'$counter'")
        }
        return counter
    }

    /** UInt64 文本比较：长度不同则长者大，同长按字典序（等长十进制串的序即数值序）。 */
    fun compare(left: String, right: String): Int {
        requireCanonical(left)
        requireCanonical(right)
        if (left.length != right.length) return if (left.length > right.length) 1 else -1
        return left.compareTo(right)
    }

    /** 逐设备取最大值（方案 §6.3「多个 marker 逐设备取最大值」，游标只前进不回退）。 */
    fun max(left: String, right: String): String =
        if (compare(left, right) >= 0) left else right

    fun merge(existing: Map<String, String>, incoming: Map<String, String>): Map<String, String> {
        val merged = LinkedHashMap<String, String>()
        existing.forEach { (device, counter) -> merged[device] = requireCanonical(counter) }
        incoming.forEach { (device, counter) ->
            val value = requireCanonical(counter)
            merged[device] = merged[device]?.let { max(it, value) } ?: value
        }
        return merged
    }

    /**
     * [candidate] 是否被清理游标 [marker] **因果支配**。
     *
     * 判定是「[marker] 对 [candidate] 的每个设备分量都 >=」：只要 [candidate] 里有个设备
     * 在 [marker] 中缺席，或分量更大，就说明它是清理之后（或并发期间）写入的新事件，必须保留。
     * 空向量按「不可支配」处理——不能因为读不到版本就删数据。
     */
    fun dominates(candidate: Map<String, String>, marker: Map<String, String>): Boolean {
        if (candidate.isEmpty()) return false
        return candidate.all { (device, counter) ->
            val bound = marker[device] ?: return false
            compare(bound, requireCanonical(counter)) >= 0
        }
    }
}

/**
 * `usage_clear_marker` 的规范 payload（S5-07）。
 *
 * `shared/contracts/schemas/usage-clear-marker-payload.schema.json` 是
 * `additionalProperties:false` + 必带 `clearedThrough`，所以这里**只做一件事**：
 * 造出恰好 `{clearedThrough: {deviceId: counter}}` 的 Map 并按 schema 自校验。
 * 已抹除的事件 id 列表（tombstone 记账）留在本地列里，不入 payload——
 * 塞进去会被共享契约判非法，并让 PC/Android 对同一 marker 算出不同哈希。
 */
object UsageClearMarkerPayload {

    fun of(clearedThrough: Map<String, String>): Map<String, Any?> {
        val copy = LinkedHashMap<String, Any?>(clearedThrough.size)
        clearedThrough.forEach { (device, counter) ->
            copy[device] = CounterVectors.requireCanonical(counter)
        }
        val payload = mapOf<String, Any?>("clearedThrough" to copy)
        requireValid(payload)
        return payload
    }

    /** 结构自校验：只允许 `clearedThrough` 一个键，值全部为十进制字符串。 */
    private fun requireValid(payload: Map<String, Any?>) {
        if (payload.keys != setOf("clearedThrough")) {
            throw IllegalArgumentException("usage_clear_marker payload 只能包含 clearedThrough")
        }
        val through = payload["clearedThrough"] as? Map<*, *>
            ?: throw IllegalArgumentException("clearedThrough 必须是对象")
        through.forEach { (device, counter) ->
            if (device !is String || device.isEmpty()) {
                throw IllegalArgumentException("clearedThrough 的设备键非法：$device")
            }
            if (counter !is String || !CounterVectors.isCanonical(counter)) {
                throw IllegalArgumentException("clearedThrough.$device 必须是十进制无符号字符串")
            }
        }
    }
}

/**
 * 世界书映射模板的受限 DSL 校验（S5-02）。
 *
 * 阶段 5 方案 §S5-02 末句：「模板中的路径表达式必须使用受限 DSL，不得携带可执行脚本」。
 * 这是一条**安全边界**：模板文件来自用户导入（外部输入），历史上同类问题的形态是
 * 在映射表达式里塞 JS/Shell 片段，导入器再用 `eval`/`new Function`/模板引擎求值。
 * Android 侧的白名单做法是：节点类型只允许 `field`/`index`/`const`，
 * 键集合封闭（未知键与未知 kind 一律拒绝），字符串里出现可执行内容特征字符
 * （`(`、`)`、`;`、`` ` ``、`$`）即拒绝，并在解析**之前**先限体积与嵌套深度
 * （防止深度嵌套的 JSON 在解析阶段就打爆栈）。
 *
 * 已知差异（需在 S5-02 落地时对齐，勿静默改语义）：PC 现行模板形状是
 * `shared/lorebook/adapters/mapping.ts` 的 `{entriesPath, fields:{keys,content,…}}`
 * 点分路径字符串，与 Android 采用的节点式 DSL 不同形。二者可无损互转
 * （点分路径 ≡ `field` 节点的 `name`），转换适配器属于 P1「模板创建」范围。
 */
object LorebookMappingTemplateDsl {

    /** 模板体积上限：用户导入文件，先设上限再解析（与 2 MiB envelope 上限同理，但更小）。 */
    private const val MAX_TEMPLATE_BYTES = 256 * 1024

    /** 嵌套深度上限：`const` 值允许嵌套结构，但必须有界。 */
    private const val MAX_DEPTH = 32

    private val NODE_KINDS = setOf("field", "index", "const")

    /** 顶层键封闭：`mappings` 必带，`name`/`sourceFormat` 可选。 */
    private val TOP_LEVEL_KEYS = setOf("mappings", "name", "sourceFormat")

    private val MAPPING_KEYS = setOf("target", "source")

    /** 每种节点允许的键集合（多余键即拒绝，避免悄悄夹带可执行片段）。 */
    private val NODE_KEYS = mapOf(
        "field" to setOf("kind", "name"),
        "index" to setOf("kind", "at"),
        "const" to setOf("kind", "value"),
    )

    /** 所有节点键的并集：先按它筛掉明显不属于 DSL 的键，再按 kind 校验组合是否合法。 */
    private val ALL_NODE_KEYS: Set<String> = NODE_KEYS.values.flatten().toSet()

    /** 可执行内容的特征字符：函数调用、语句分隔、模板插值都用得到它们。 */
    private const val FORBIDDEN_CHARS = "();`$"

    /** 与 PC `DANGEROUS_KEYS` 一致：原型链键不允许出现在路径里。 */
    private val DANGEROUS_SEGMENTS = setOf("__proto__", "constructor", "prototype")

    fun isValid(templateJson: String): Boolean = runCatching { requireValid(templateJson) }.isSuccess

    /** 非法模板抛 [IllegalArgumentException]，消息里点名 offending key/kind。 */
    fun requireValid(templateJson: String) {
        val bytes = templateJson.toByteArray(Charsets.UTF_8).size
        if (bytes > MAX_TEMPLATE_BYTES) {
            throw IllegalArgumentException("映射模板 $bytes 字节超过上限 $MAX_TEMPLATE_BYTES 字节")
        }
        val text = templateJson.trim()
        val structure = scanStructure(text)
        if (structure.maxDepth > MAX_DEPTH) {
            throw IllegalArgumentException("映射模板嵌套深度超过上限 $MAX_DEPTH")
        }
        val root = runCatching { JSONTokener(text).nextValue() }.getOrElse {
            throw IllegalArgumentException("映射模板不是合法 JSON：${it.message}")
        }
        if (root !is JSONObject) throw IllegalArgumentException("映射模板必须是 JSON 对象")
        requireNothingAfterRoot(text, structure.rootEnd)
        validateTemplate(root)
    }

    private fun validateTemplate(root: JSONObject) {
        for (key in root.keys()) {
            if (!TOP_LEVEL_KEYS.contains(key)) throw unknownKey("模板", key)
        }
        if (!root.has("mappings")) throw IllegalArgumentException("映射模板缺少必需键: 'mappings'")
        val mappings = root.get("mappings")
        if (mappings !is JSONArray) throw IllegalArgumentException("映射模板的 'mappings' 必须是数组")
        stringField(root, "name", 1)
        stringField(root, "sourceFormat", 1)
        for (i in 0 until mappings.length()) {
            val mapping = mappings.get(i)
            if (mapping !is JSONObject) {
                throw IllegalArgumentException("映射模板 mappings[$i] 必须是对象")
            }
            for (key in mapping.keys()) {
                if (!MAPPING_KEYS.contains(key)) throw unknownKey("mappings[$i]", key)
            }
            requireNode(mapping, "target", "mappings[$i]", 2)
            requireNode(mapping, "source", "mappings[$i]", 2)
        }
    }

    private fun stringField(obj: JSONObject, key: String, depth: Int) {
        if (!obj.has(key)) return
        val value = obj.get(key)
        if (value !is String) throw IllegalArgumentException("映射模板的 '$key' 必须是字符串")
        guardDepth(depth)
        requireSafeText(value, "'$key'")
    }

    private fun requireNode(container: JSONObject, field: String, where: String, depth: Int) {
        guardDepth(depth)
        if (!container.has(field)) throw IllegalArgumentException("$where 缺少节点: '$field'")
        val node = container.get(field)
        if (node !is JSONObject) throw IllegalArgumentException("$where 的 '$field' 必须是节点对象")
        for (key in node.keys()) {
            if (key != "kind" && !ALL_NODE_KEYS.contains(key)) {
                throw unknownKey("$where.$field", key)
            }
        }
        val kindValue = node.opt("kind")
        if (kindValue !is String) throw IllegalArgumentException("$where.$field 的 'kind' 必须是字符串")
        val kind = kindValue
        if (!NODE_KINDS.contains(kind)) {
            throw IllegalArgumentException("映射节点 kind 不在受限 DSL 白名单内: '$kind'（允许 $NODE_KINDS）")
        }
        for (key in node.keys()) {
            if (!NODE_KEYS.getValue(kind).contains(key)) throw unknownKey("$where.$field(kind=$kind)", key)
        }
        when (kind) {
            "field" -> {
                if (!node.has("name")) throw IllegalArgumentException("field 节点缺少必需键: 'name'")
                val name = node.opt("name")
                if (name !is String) throw IllegalArgumentException("field 节点缺少字符串 'name'")
                requireSafeText(name, "field.name")
                requirePath(name)
            }
            "index" -> {
                if (!node.has("at")) throw IllegalArgumentException("index 节点缺少必需键: 'at'")
                val at = node.opt("at")
                if (at !is Number) throw IllegalArgumentException("index 节点的 'at' 必须是整数")
                val value = at.toDouble()
                if (value != value.toLong().toDouble() || value < 0.0 || value > Int.MAX_VALUE.toDouble()) {
                    throw IllegalArgumentException("index 节点的 'at' 必须是非负整数下标: $at")
                }
            }
            else -> {
                if (!node.has("value")) throw IllegalArgumentException("const 节点缺少必需键: 'value'")
                requireValue(node.opt("value"), "const.value", depth + 1)
            }
        }
    }

    /** `const` 值允许任意 JSON 值，但同样受深度、键封闭与特征字符约束。 */
    private fun requireValue(value: Any?, where: String, depth: Int) {
        guardDepth(depth)
        when (value) {
            null, JSONObject.NULL -> Unit
            is String -> requireSafeText(value, where)
            is Number, is Boolean -> Unit
            is JSONArray -> for (i in 0 until value.length()) {
                requireValue(value.get(i), "$where[$i]", depth + 1)
            }
            is JSONObject -> for (key in value.keys()) {
                if (DANGEROUS_SEGMENTS.contains(key)) throw unknownKey(where, key)
                requireSafeText(key, "$where 的键")
                requireValue(value.get(key), "$where.$key", depth + 1)
            }
            else -> throw IllegalArgumentException("$where 含非 JSON 值类型: ${value::class.java.name}")
        }
    }

    /** 路径段：`.` 分段，空段与原型链键都拒绝（数字段合法，数组下标也可写成路径）。 */
    private fun requirePath(path: String) {
        if (path.isEmpty()) return
        for (segment in path.split('.')) {
            if (segment.isEmpty()) throw IllegalArgumentException("字段路径存在空段: '$path'")
            if (DANGEROUS_SEGMENTS.contains(segment)) throw unknownKey("字段路径 '$path'", segment)
        }
    }

    private fun requireSafeText(text: String, where: String) {
        val offending = text.firstOrNull { FORBIDDEN_CHARS.contains(it) }
        if (offending != null) {
            throw IllegalArgumentException("映射模板 $where 含可执行内容特征字符 '$offending'，已拒绝")
        }
    }

    private fun guardDepth(depth: Int) {
        if (depth > MAX_DEPTH) throw IllegalArgumentException("映射模板嵌套深度超过上限 $MAX_DEPTH")
    }

    private fun unknownKey(where: String, key: String): IllegalArgumentException =
        IllegalArgumentException("映射模板 $where 含未知键: '$key'")

    /**
     * `JSONObject(String)` 会忽略对象后面的尾随内容（如 `{"mappings":[]} garbage`），
     * 那会让「校验通过的文本」与最终落库的文本不是一回事，因此要求根值之后只剩空白。
     */
    private fun requireNothingAfterRoot(text: String, rootEnd: Int) {
        if (text.substring(rootEnd.coerceAtMost(text.length)).isNotBlank()) {
            throw IllegalArgumentException("映射模板末尾存在多余内容")
        }
    }

    /** 顶层结构扫描：最大嵌套深度 + 根值结束下标（两个用途见调用点注释）。 */
    private fun scanStructure(text: String): Structure {
        var depth = 0
        var maxDepth = 0
        var rootEnd = text.length
        var inString = false
        var escaped = false
        for (i in text.indices) {
            val ch = text[i]
            if (inString) {
                when {
                    escaped -> escaped = false
                    ch == '\\' -> escaped = true
                    ch == '"' -> inString = false
                }
                continue
            }
            when (ch) {
                '"' -> inString = true
                '{', '[' -> {
                    depth++
                    if (depth > maxDepth) maxDepth = depth
                }
                '}', ']' -> {
                    depth--
                    if (depth == 0 && rootEnd == text.length) rootEnd = i + 1
                }
                else -> Unit
            }
        }
        return Structure(maxDepth, rootEnd)
    }

    private class Structure(val maxDepth: Int, val rootEnd: Int)
}
