package com.qingyu.companion.domain.contracts

import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.MigrationIdentity
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import com.qingyu.companion.local.domain.VersionVectorJson
import com.qingyu.companion.local.testing.FakeLocalStore

/**
 * 阶段 3 S3-03：`shared/contracts/fixtures/repository/behavior-table.json` 的 Kotlin 执行器。
 *
 * 与 `shared/contracts/repositoryContract.ts` 语义一一对应：PC 文件实现、进程内内存实现
 * （阶段 2）与本阶段 Room 实现必须对**同一份表**给出一致结果。
 * 失败以 [ContractFailure] 列表返回，由各测试框架转换为自己的断言。
 */
data class ContractRepositoryStep(
    val op: String,
    val entityType: String,
    val entityId: String,
    val payload: Map<String, Any?>,
    val expect: Map<String, Any?>,
    val payloadContains: Map<String, Any?>,
    val `as`: String?,
    val earlier: String?,
    val later: String?,
    val left: String?,
    val right: String?,
    val cursor: Long,
    val limit: Int,
    val expectTotal: Int,
    val deviceId: String?,
    val counter: String?,
)

data class ContractRepositoryCase(val id: String, val steps: List<ContractRepositoryStep>)

data class ContractFailure(val caseId: String, val stepIndex: Int, val op: String, val message: String)

/** 被契约约束的最小仓储接口（对应 TS 的 ContractRepositoryAdapter）。 */
interface ContractRepositoryAdapter {
    fun put(entityType: String, entityId: String, payload: Map<String, Any?>)

    fun tombstone(entityType: String, entityId: String)

    fun applyRemote(entityType: String, entityId: String, payload: Map<String, Any?>, deviceId: String, counter: String)

    fun head(entityType: String, entityId: String): ContractHead?

    fun changesAfter(cursor: Long, limit: Int): ContractChangePage

    fun readEntity(entityType: String, entityId: String): Map<String, Any?>?

    fun reset()
}

data class ContractHead(val version: Map<String, String>, val hash: String, val deleted: Boolean)

data class ContractChangeRow(val seq: Long, val origin: String)

data class ContractChangePage(val rows: List<ContractChangeRow>, val nextCursor: Long)

/** behavior-table 用到的 entityType 命名空间（用于隔离契约 journal/head）。 */
val CONTRACT_NAMESPACE_TYPES: List<String> = listOf("persona", "character", "settings_public")

object RepositoryContractRunner {

    fun run(
        cases: List<ContractRepositoryCase>,
        adapter: ContractRepositoryAdapter,
        hashOf: (Map<String, Any?>) -> String,
    ): List<ContractFailure> {
        val failures = mutableListOf<ContractFailure>()
        for (case in cases) {
            adapter.reset()
            val captured = mutableMapOf<String, Any?>()

            case.steps.forEachIndexed { stepIndex, step ->
                fun fail(message: String) {
                    failures += ContractFailure(case.id, stepIndex, step.op, message)
                }

                try {
                    when (step.op) {
                        "put" -> adapter.put(step.entityType, step.entityId, step.payload)

                        "tombstone" -> adapter.tombstone(step.entityType, step.entityId)

                        "applyRemote" -> adapter.applyRemote(
                            step.entityType,
                            step.entityId,
                            step.payload,
                            step.deviceId ?: "remote",
                            step.counter ?: "1",
                        )

                        "captureHeadVersion" -> {
                            val head = adapter.head(step.entityType, step.entityId)
                            if (head == null) fail("head 不存在，无法捕获版本向量") else captured[step.`as`!!] = head.version
                        }

                        "captureHeadHash" -> {
                            val head = adapter.head(step.entityType, step.entityId)
                            if (head == null) fail("head 不存在，无法捕获哈希") else captured[step.`as`!!] = head.hash
                        }

                        "expectVersionStrictlyGreater" -> {
                            @Suppress("UNCHECKED_CAST")
                            val earlier = captured[step.earlier] as? Map<String, String>
                            @Suppress("UNCHECKED_CAST")
                            val later = captured[step.later] as? Map<String, String>
                            if (earlier == null || later == null) {
                                fail("缺少捕获的版本向量")
                            } else {
                                val rel = compareVersionVectors(later, earlier)
                                if (rel != "greater") fail("版本向量未严格递增（later vs earlier = $rel）")
                            }
                        }

                        "expectEqual" -> {
                            val l = captured[step.left]
                            val r = captured[step.right]
                            if (l != r) fail("期望相等：$l != $r")
                        }

                        "expectHead" -> {
                            val head = adapter.head(step.entityType, step.entityId)
                            val expect = step.expect
                            if (expect["exists"] == false) {
                                if (head != null) fail("期望 head 不存在，但实际存在")
                            } else if (head == null) {
                                fail("期望 head 存在，但缺失")
                            } else {
                                val expectedDeleted = expect["deleted"]
                                if (expectedDeleted is Boolean && head.deleted != expectedDeleted) {
                                    fail("deleted 期望 $expectedDeleted 实际 ${head.deleted}")
                                }
                                if (expect["hashIsContentHashOfPayload"] == true) {
                                    val expected = hashOf(step.payload)
                                    if (head.hash != expected) fail("head.hash 与 payload 的规范 contentHash 不一致")
                                }
                            }
                        }

                        "expectChanges" -> {
                            val origin = step.expect["origin"]?.toString().orEmpty()
                            val page = adapter.changesAfter(step.cursor, step.limit)
                            val matched = page.rows.filter { it.origin == origin }
                            val expectedCount = (step.expect["count"] as? Number)?.toInt()
                            if (expectedCount != null && matched.size != expectedCount) {
                                fail("origin=$origin 变更数期望 $expectedCount 实际 ${matched.size}")
                            }
                        }

                        "expectPagedUnionEqualsTotal" -> {
                            val limit = if (step.limit > 0) step.limit else 2
                            val seen = mutableListOf<Long>()
                            var cursor = 0L
                            var guard = 0
                            while (true) {
                                val page = adapter.changesAfter(cursor, limit)
                                if (page.rows.isEmpty()) break
                                if (page.nextCursor < cursor) {
                                    fail("nextCursor 回退")
                                    break
                                }
                                for (row in page.rows) {
                                    if (seen.contains(row.seq)) fail("分页出现重复 seq=${row.seq}")
                                    seen += row.seq
                                }
                                cursor = page.nextCursor
                                if (++guard > 50) {
                                    fail("分页未收敛")
                                    break
                                }
                            }
                            if (seen.size != step.expectTotal) {
                                fail("分页并集大小期望 ${step.expectTotal} 实际 ${seen.size}")
                            }
                        }

                        "expectReadable" -> {
                            val entity = adapter.readEntity(step.entityType, step.entityId)
                            if (entity == null) {
                                fail("实体不可读")
                            } else {
                                for ((key, value) in step.payloadContains) {
                                    if (entity[key]?.toString() != value?.toString()) {
                                        fail("读取内容缺少 $key=$value（实际 ${entity[key]}）")
                                    }
                                }
                            }
                        }

                        "expectNotReadable" -> {
                            if (adapter.readEntity(step.entityType, step.entityId) != null) {
                                fail("实体仍然可读，期望已删除")
                            }
                        }

                        "expectPutRejected" -> {
                            var threw = false
                            try {
                                adapter.put(step.entityType, step.entityId, step.payload)
                            } catch (_: Throwable) {
                                threw = true
                            }
                            if (!threw) fail("非法实体 ID 未被拒绝")
                        }

                        else -> fail("未知操作 ${step.op}")
                    }
                } catch (err: Throwable) {
                    fail("执行抛出异常：${err.message ?: err::class.simpleName}")
                }
            }
        }
        return failures
    }

    /** 与 TS 的 compareVersionVectors 等价（BigInteger 语义，不用 Long）。 */
    fun compareVersionVectors(a: Map<String, String>, b: Map<String, String>): String {
        var aGreater = false
        var bGreater = false
        for (key in a.keys + b.keys) {
            val av = java.math.BigInteger(a[key] ?: "0")
            val bv = java.math.BigInteger(b[key] ?: "0")
            when {
                av > bv -> aGreater = true
                av < bv -> bGreater = true
            }
        }
        return when {
            aGreater && bGreater -> "incomparable"
            aGreater -> "greater"
            bGreater -> "less"
            else -> "equal"
        }
    }
}

/** 契约载荷的公共读法：解析存储的 JSON 并把标量统一成字符串。 */
private fun readContractPayload(json: String?): Map<String, Any?>? {
    if (json == null) return null
    return MiniJson.parseObject(json).mapValues { (_, v) ->
        if (v is Number || v is Boolean || v is String) v.toString() else v
    }
}

/** Room 适配器：通用对象表 + 通用 head/journal 映射到契约接口。 */
class RoomContractAdapter(
    private val store: RoomLocalSyncRepository,
) : ContractRepositoryAdapter {

    override fun put(entityType: String, entityId: String, payload: Map<String, Any?>) {
        kotlinx.coroutines.runBlocking { store.contractPut(entityType, entityId, payload) }
    }

    override fun tombstone(entityType: String, entityId: String) {
        kotlinx.coroutines.runBlocking { store.contractTombstone(entityType, entityId) }
    }

    override fun applyRemote(
        entityType: String,
        entityId: String,
        payload: Map<String, Any?>,
        deviceId: String,
        counter: String,
    ) {
        kotlinx.coroutines.runBlocking { store.contractApplyRemote(entityType, entityId, payload, deviceId, counter) }
    }

    override fun head(entityType: String, entityId: String): ContractHead? = kotlinx.coroutines.runBlocking {
        store.getHead(entityType, entityId)?.let {
            ContractHead(VersionVectorJson.decode(it.versionJson), it.hash, it.deleted)
        }
    }

    override fun changesAfter(cursor: Long, limit: Int): ContractChangePage = kotlinx.coroutines.runBlocking {
        val rows = store.contractChangesAfter(cursor, limit)
        ContractChangePage(rows.map { ContractChangeRow(it.seq, it.origin) }, rows.maxOfOrNull { it.seq } ?: cursor)
    }

    override fun readEntity(entityType: String, entityId: String): Map<String, Any?>? = kotlinx.coroutines.runBlocking {
        readContractPayload(store.contractRead(entityId))
    }

    override fun reset() {
        kotlinx.coroutines.runBlocking {
            store.contractReset()
            CONTRACT_NAMESPACE_TYPES.forEach { store.contractClearNamespace(it) }
        }
    }
}

/** 内存适配器：验证 runner 与被测接口本身（Room 契约测试才是阶段 3 的验收对象）。 */
class FakeContractAdapter : ContractRepositoryAdapter {
    private val store = FakeLocalStore("android-contract")

    override fun put(entityType: String, entityId: String, payload: Map<String, Any?>) {
        kotlinx.coroutines.runBlocking { store.contractPut(entityType, entityId, payload) }
    }

    override fun tombstone(entityType: String, entityId: String) {
        kotlinx.coroutines.runBlocking { store.contractTombstone(entityType, entityId) }
    }

    override fun applyRemote(
        entityType: String,
        entityId: String,
        payload: Map<String, Any?>,
        deviceId: String,
        counter: String,
    ) {
        kotlinx.coroutines.runBlocking { store.contractApplyRemote(entityType, entityId, payload, deviceId, counter) }
    }

    override fun head(entityType: String, entityId: String): ContractHead? = kotlinx.coroutines.runBlocking {
        store.getHead(entityType, entityId)?.let {
            ContractHead(VersionVectorJson.decode(it.versionJson), it.hash, it.deleted)
        }
    }

    override fun changesAfter(cursor: Long, limit: Int): ContractChangePage = kotlinx.coroutines.runBlocking {
        val rows = store.contractChangesAfter(cursor, limit)
        ContractChangePage(rows.map { ContractChangeRow(it.seq, it.origin) }, rows.maxOfOrNull { it.seq } ?: cursor)
    }

    override fun readEntity(entityType: String, entityId: String): Map<String, Any?>? = kotlinx.coroutines.runBlocking {
        readContractPayload(store.contractRead(entityId))
    }

    override fun reset() {
        kotlinx.coroutines.runBlocking {
            store.contractReset()
            CONTRACT_NAMESPACE_TYPES.forEach { store.contractClearNamespace(it) }
        }
    }
}

/**
 * 极简 JSON 读取器：只支持行为表用到的形状
 * （对象、数组、字符串、数字、布尔、null），避免为测试引入额外依赖。
 */
object MiniJson {
    fun parseObject(text: String): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return Parser(text).parseValue() as? Map<String, Any?> ?: error("顶层必须是对象")
    }

    fun encode(value: Any?): String = buildString { write(value, this) }

    private fun write(value: Any?, out: StringBuilder) {
        when (value) {
            null -> out.append("null")
            is Boolean -> out.append(if (value) "true" else "false")
            is Int, is Long -> out.append(value.toString())
            is Double, is Float -> out.append(value.toString())
            is String -> writeString(value, out)
            is Map<*, *> -> {
                out.append('{')
                value.entries.forEachIndexed { index, (k, v) ->
                    if (index > 0) out.append(',')
                    writeString(k.toString(), out)
                    out.append(':')
                    write(v, out)
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { index, item ->
                    if (index > 0) out.append(',')
                    write(item, out)
                }
                out.append(']')
            }
            else -> writeString(value.toString(), out)
        }
    }

    private fun writeString(value: String, out: StringBuilder) {
        out.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> if (ch.code < 0x20) out.append("\\u%04x".format(ch.code)) else out.append(ch)
            }
        }
        out.append('"')
    }

    private class Parser(private val text: String) {
        private var i = 0

        fun parseValue(): Any? {
            skipWs()
            if (i >= text.length) error("意外结束")
            return when (val c = text[i]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) parseNumber() else error("非法字符 '$c' @$i")
            }
        }

        private fun parseObject(): Map<String, Any?> {
            expect('{')
            val result = linkedMapOf<String, Any?>()
            skipWs()
            if (peek() == '}') {
                i++
                return result
            }
            while (true) {
                skipWs()
                val key = parseString()
                skipWs()
                expect(':')
                result[key] = parseValue()
                skipWs()
                when (peek()) {
                    ',' -> i++
                    '}' -> {
                        i++
                        return result
                    }
                    else -> error("对象缺少分隔符 @$i")
                }
            }
        }

        private fun parseArray(): List<Any?> {
            expect('[')
            val result = mutableListOf<Any?>()
            skipWs()
            if (peek() == ']') {
                i++
                return result
            }
            while (true) {
                result += parseValue()
                skipWs()
                when (peek()) {
                    ',' -> i++
                    ']' -> {
                        i++
                        return result
                    }
                    else -> error("数组缺少分隔符 @$i")
                }
            }
        }

        private fun parseString(): String {
            expect('"')
            val sb = StringBuilder()
            while (i < text.length) {
                val c = text[i]
                if (c == '\\') {
                    i++
                    when (val esc = text[i]) {
                        'n' -> sb.append('\n')
                        't' -> sb.append('\t')
                        'r' -> sb.append('\r')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000c')
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'u' -> {
                            sb.append(text.substring(i + 1, i + 5).toInt(16).toChar())
                            i += 4
                        }
                        else -> sb.append(esc)
                    }
                    i++
                    continue
                }
                if (c == '"') {
                    i++
                    return sb.toString()
                }
                sb.append(c)
                i++
            }
            error("字符串未闭合")
        }

        private fun parseNumber(): Any {
            val start = i
            if (peek() == '-') i++
            while (i < text.length &&
                (text[i].isDigit() || text[i] == '.' || text[i] == 'e' || text[i] == 'E' ||
                    text[i] == '+' || text[i] == '-')
            ) {
                i++
            }
            val raw = text.substring(start, i)
            return if (raw.contains('.') || raw.contains('e') || raw.contains('E')) raw.toDouble() else raw.toLong()
        }

        private fun literal(word: String, value: Any?): Any? {
            if (!text.startsWith(word, i)) error("非法字面量 @$i")
            i += word.length
            return value
        }

        private fun expect(c: Char) {
            skipWs()
            if (i >= text.length || text[i] != c) error("期望 '$c' @$i")
            i++
        }

        private fun peek(): Char = if (i < text.length) text[i] else '\u0000'

        private fun skipWs() {
            while (i < text.length && text[i].isWhitespace()) i++
        }
    }

    /** 行为表 -> 用例。 */
    fun parseBehaviorTable(json: String): List<ContractRepositoryCase> {
        val root = parseObject(json)
        @Suppress("UNCHECKED_CAST")
        val cases = root["cases"] as? List<Map<String, Any?>> ?: emptyList()
        return cases.map { raw ->
            @Suppress("UNCHECKED_CAST")
            val steps = (raw["steps"] as? List<Map<String, Any?>>).orEmpty()
            ContractRepositoryCase(
                id = raw["id"]?.toString().orEmpty(),
                steps = steps.map { step ->
                    @Suppress("UNCHECKED_CAST")
                    ContractRepositoryStep(
                        op = step["op"]?.toString().orEmpty(),
                        entityType = step["entityType"]?.toString().orEmpty(),
                        entityId = step["entityId"]?.toString().orEmpty(),
                        payload = (step["payload"] as? Map<String, Any?>).orEmpty(),
                        expect = (step["expect"] as? Map<String, Any?>).orEmpty(),
                        payloadContains = (step["payloadContains"] as? Map<String, Any?>).orEmpty(),
                        `as` = step["as"]?.toString(),
                        earlier = step["earlier"]?.toString(),
                        later = step["later"]?.toString(),
                        left = step["left"]?.toString(),
                        right = step["right"]?.toString(),
                        cursor = (step["cursor"] as? Number)?.toLong() ?: 0L,
                        limit = (step["limit"] as? Number)?.toInt() ?: 1000,
                        expectTotal = (step["expectTotal"] as? Number)?.toInt() ?: 0,
                        deviceId = step["deviceId"]?.toString(),
                        counter = step["counter"]?.toString(),
                    )
                },
            )
        }
    }
}
