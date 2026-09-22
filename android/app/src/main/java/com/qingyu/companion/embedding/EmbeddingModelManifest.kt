package com.qingyu.companion.embedding

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * 阶段 6 S6-05 第 2 档的载体：**本地移动端嵌入模型包清单**
 * （格式与 PC `shared/localModels.ts` 的 `LocalEmbeddingModelManifest` 同一份契约，
 * 校验规则逐条对齐 PC `electron/services/localModels/manifest.ts#validateManifest`）。
 *
 * 清单以**原始字段表**保存而不是拆成 data class 再重组：签名校验必须对
 * 「目录里那份 JSON 对象」逐字段生效（PC 对 `{...manifest}` 去掉 `catalogSignature`
 * 后的 canonical JSON 验签），任何未知字段的丢失或改写都会让合法包验不过。
 *
 * canonical JSON 的两点已知边界（都写进测试注释，避免将来当成 bug 修掉）：
 * 1. 键序对齐 JS `String.prototype.localeCompare` 在纯 ASCII 键上的语义
 *    （忽略大小写主序 + 小写在前的次序），不是 JVM 默认的码元序——
 *    `displayName` 必须排在 `dimensions` 之后、`dtype` 之前；
 * 2. 数字按 JSON.stringify 的整数形态（无 `.0`）输出；清单数值字段全部被校验
 *    限定为整数，非整数只可能出现在未知字段里，按普通十进制近似输出。
 */
class EmbeddingModelManifest private constructor(
    /** 解析出的原始字段表（保序、保留未知字段，验签与 canonical JSON 的唯一事实源）。 */
    val fields: Map<String, Any?>,
    val id: String,
    val version: String,
    val displayName: String,
    val description: String,
    val languages: List<String>,
    val licenseName: String,
    val licenseUrl: String,
    val runtime: String,
    val architecture: String,
    val dimensions: Int,
    val maxTokens: Int,
    val dtype: String,
    val pooling: String,
    val normalize: Boolean,
    val queryPrefix: String?,
    val passagePrefix: String?,
    val minimumAppVersion: String,
    val recommendedMemoryMb: Long,
    val installedSize: Long,
    val files: List<ModelFile>,
    val catalogSignature: String,
) {
    data class ModelFile(
        val path: String,
        val size: Long,
        val sha256: String,
        val urls: List<String>,
    )

    /** 模型包内全部文件的 sha256 汇总指纹（模型权重变化 → 指纹变化 → 旧索引不可复用）。 */
    fun weightsFingerprint(): String {
        val joined = files.sortedBy { it.path }.joinToString("|") { "${it.path}:${it.sha256}" }
        return ChatHash.fnv1a36(joined)
    }

    /**
     * 验签载荷：移除 `catalogSignature` 后的 canonical JSON
     * （PC `manifestSigningPayload` 同口径）。
     */
    fun signingPayload(): String = canonicalJson(fields.filterKeys { it != CATALOG_SIGNATURE })

    companion object {
        const val CATALOG_SIGNATURE = "catalogSignature"
        const val SCHEMA_VERSION = 1

        private val ID_RE = Regex("^[a-z0-9][a-z0-9._-]{1,63}$")
        private val VERSION_RE = Regex("^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$")
        private val SHA256_RE = Regex("^[a-f0-9]{64}$")
        private val HTTPS_RE = Regex("^https://", RegexOption.IGNORE_CASE)
        private val SAFE_EXTENSIONS = setOf(".json", ".onnx", ".txt", ".model", ".vocab", ".merges")
        private const val MAX_FILE_BYTES = 2L * 1024 * 1024 * 1024
        private const val MAX_INSTALLED_BYTES = 4L * 1024 * 1024 * 1024
        private const val JS_MAX_SAFE_INTEGER = 9007199254740991L

        /** 解析 JSON 文本并**完整校验**（任一规则不满足 → [ModelPackageFormatException]）。 */
        fun parseJson(text: String): EmbeddingModelManifest {
            val raw = try {
                JSONObject(text)
            } catch (error: JSONException) {
                throw ModelPackageFormatException("模型清单不是合法 JSON：${error.message}")
            }
            return parse(jsonObjectToMap(raw))
        }

        fun parse(fields: Map<String, Any?>): EmbeddingModelManifest {
            val manifest = validate(fields)
            return manifest
        }

        // ------------------------------------------------------------ 校验（PC validateManifest 逐条对齐）

        private fun validate(m: Map<String, Any?>): EmbeddingModelManifest {
            if (m.isEmpty()) throw ModelPackageFormatException("模型清单必须是对象")
            val schemaVersion = intOf(m["schemaVersion"]) ?: throw ModelPackageFormatException("不支持的模型清单版本")
            if (schemaVersion != SCHEMA_VERSION) throw ModelPackageFormatException("不支持的模型清单版本")
            val id = stringOf(m["id"]) ?: throw ModelPackageFormatException("模型 id 不合法")
            if (!ID_RE.matches(id)) throw ModelPackageFormatException("模型 id 不合法")
            val version = stringOf(m["version"]) ?: throw ModelPackageFormatException("模型版本必须使用 semver")
            if (!VERSION_RE.matches(version)) throw ModelPackageFormatException("模型版本必须使用 semver")
            val displayName = stringOf(m["displayName"])?.trim().orEmpty()
            val description = stringOf(m["description"])?.trim().orEmpty()
            if (displayName.isEmpty() || description.isEmpty()) throw ModelPackageFormatException("模型名称或说明为空")
            val languages = listOfStrings(m["languages"])
                ?: throw ModelPackageFormatException("模型语言列表不合法")
            if (languages.isEmpty() || languages.any { it.isBlank() }) {
                throw ModelPackageFormatException("模型语言列表不合法")
            }
            val license = m["license"] as? Map<*, *> ?: throw ModelPackageFormatException("模型许可证信息不完整")
            val licenseName = stringOf(license["name"])?.trim().orEmpty()
            val licenseUrl = stringOf(license["url"]).orEmpty()
            if (licenseName.isEmpty() || !HTTPS_RE.containsMatchIn(licenseUrl)) {
                throw ModelPackageFormatException("模型许可证信息不完整")
            }
            val runtime = stringOf(m["runtime"]) ?: throw ModelPackageFormatException("仅支持 ONNX 数据模型")
            if (runtime != "onnx") throw ModelPackageFormatException("仅支持 ONNX 数据模型")
            val architecture = stringOf(m["architecture"]).orEmpty()
            val dimensions = intOf(m["dimensions"]) ?: throw ModelPackageFormatException("向量维度不合法")
            if (dimensions < 8 || dimensions > 8192) throw ModelPackageFormatException("向量维度不合法")
            val maxTokens = intOf(m["maxTokens"]) ?: throw ModelPackageFormatException("最大 token 数不合法")
            if (maxTokens < 8 || maxTokens > 131072) throw ModelPackageFormatException("最大 token 数不合法")
            val dtype = stringOf(m["dtype"]) ?: throw ModelPackageFormatException("模型精度不受支持")
            if (dtype !in setOf("q8", "q4", "fp16", "fp32")) throw ModelPackageFormatException("模型精度不受支持")
            val pooling = stringOf(m["pooling"]) ?: throw ModelPackageFormatException("pooling 不受支持")
            if (pooling !in setOf("mean", "cls")) throw ModelPackageFormatException("pooling 不受支持")
            val normalize = m["normalize"] as? Boolean ?: throw ModelPackageFormatException("模型清单缺少 normalize 字段")
            val queryPrefix = stringOf(m["queryPrefix"])
            val passagePrefix = stringOf(m["passagePrefix"])
            val minimumAppVersion = stringOf(m["minimumAppVersion"])
                ?: throw ModelPackageFormatException("最低应用版本不合法")
            if (!VERSION_RE.matches(minimumAppVersion)) throw ModelPackageFormatException("最低应用版本不合法")
            val recommendedMemoryMb = safeLongOf(m["recommendedMemoryMb"])
                ?: throw ModelPackageFormatException("建议内存不合法")
            if (recommendedMemoryMb <= 0) throw ModelPackageFormatException("建议内存不合法")
            val installedSize = safeLongOf(m["installedSize"]) ?: throw ModelPackageFormatException("安装体积不合法")
            if (installedSize <= 0 || installedSize > MAX_INSTALLED_BYTES) throw ModelPackageFormatException("安装体积不合法")

            val rawFiles = m["files"] as? List<*> ?: throw ModelPackageFormatException("模型文件列表不合法")
            if (rawFiles.isEmpty() || rawFiles.size > 64) throw ModelPackageFormatException("模型文件列表不合法")
            val files = mutableListOf<ModelFile>()
            val seenPaths = mutableSetOf<String>()
            var total = 0L
            for (rawFile in rawFiles) {
                val file = rawFile as? Map<*, *> ?: throw ModelPackageFormatException("模型文件列表不合法")
                val path = stringOf(file["path"]) ?: throw ModelPackageFormatException("模型文件路径不安全: null")
                if (!isSafeModelRelativePath(path)) throw ModelPackageFormatException("模型文件路径不安全: $path")
                val normalizedCase = path.lowercase()
                if (!seenPaths.add(normalizedCase)) throw ModelPackageFormatException("模型文件路径重复: $path")
                val size = safeLongOf(file["size"])
                    ?: throw ModelPackageFormatException("模型文件大小不合法: $path")
                if (size <= 0 || size > MAX_FILE_BYTES) throw ModelPackageFormatException("模型文件大小不合法: $path")
                total += size
                val sha256 = stringOf(file["sha256"]) ?: throw ModelPackageFormatException("模型文件 hash 不合法: $path")
                if (!SHA256_RE.matches(sha256)) throw ModelPackageFormatException("模型文件 hash 不合法: $path")
                val urls = listOfStrings(file["urls"])
                    ?: throw ModelPackageFormatException("模型下载地址不安全: $path")
                if (urls.any { !HTTPS_RE.containsMatchIn(it) }) {
                    throw ModelPackageFormatException("模型下载地址不安全: $path")
                }
                files += ModelFile(path = path, size = size, sha256 = sha256, urls = urls)
            }
            if (total > installedSize) throw ModelPackageFormatException("文件总大小超过清单安装体积")
            val catalogSignature = stringOf(m[CATALOG_SIGNATURE]).orEmpty()
            if (catalogSignature.isEmpty()) throw ModelPackageFormatException("模型清单缺少签名")

            return EmbeddingModelManifest(
                fields = m,
                id = id,
                version = version,
                displayName = displayName,
                description = description,
                languages = languages,
                licenseName = licenseName,
                licenseUrl = licenseUrl,
                runtime = runtime,
                architecture = architecture,
                dimensions = dimensions,
                maxTokens = maxTokens,
                dtype = dtype,
                pooling = pooling,
                normalize = normalize,
                queryPrefix = queryPrefix,
                passagePrefix = passagePrefix,
                minimumAppVersion = minimumAppVersion,
                recommendedMemoryMb = recommendedMemoryMb,
                installedSize = installedSize,
                files = files,
                catalogSignature = catalogSignature,
            )
        }

        /** PC `isSafeModelRelativePath`：拒 绝对路径 / 反斜杠 / NUL / `..` 逃逸 / 非白名单扩展名。 */
        fun isSafeModelRelativePath(input: String): Boolean {
            if (input.isEmpty() || input.contains('\\') || input.contains('\u0000') || input.startsWith("/")) return false
            val normalized = posixNormalize(input)
            if (normalized != input || normalized == "." || normalized.startsWith("../") || normalized.contains("/../")) {
                return false
            }
            return SAFE_EXTENSIONS.contains(posixExtName(normalized).lowercase())
        }

        /** POSIX 路径归一化（JS `path.posix.normalize` 的子集语义，用于安全判定）。 */
        internal fun posixNormalize(input: String): String {
            if (input.isEmpty()) return "."
            val trailingSlash = input.endsWith('/')
            val out = mutableListOf<String>()
            for (part in input.split('/')) {
                when (part) {
                    "", "." -> Unit
                    ".." -> {
                        if (out.isNotEmpty() && out.last() != "..") out.removeAt(out.size - 1) else out += ".."
                    }
                    else -> out += part
                }
            }
            var result = out.joinToString("/")
            if (trailingSlash && result.isNotEmpty()) result += "/"
            if (result.isEmpty()) result = if (trailingSlash) "./" else "."
            return result
        }

        /** POSIX 扩展名（JS `path.posix.extname`）：最后一个 `/` 之后最后一个 `.` 起（含点）。 */
        internal fun posixExtName(input: String): String {
            val name = input.substringAfterLast('/')
            val dot = name.lastIndexOf('.')
            return if (dot <= 0) "" else name.substring(dot)
        }

        // ------------------------------------------------------------ JSON ↔ 内部值

        internal fun jsonObjectToMap(json: JSONObject): Map<String, Any?> {
            val map = linkedMapOf<String, Any?>()
            for (key in json.keys()) {
                map[key] = unwrapJsonValue(json.get(key))
            }
            return map
        }

        private fun unwrapJsonValue(value: Any?): Any? = when (value) {
            JSONObject.NULL, null -> null
            is JSONObject -> jsonObjectToMap(value)
            is JSONArray -> (0 until value.length()).map { unwrapJsonValue(value.get(it)) }
            else -> value
        }

        internal fun stringOf(value: Any?): String? = value as? String

        internal fun listOfStrings(value: Any?): List<String>? {
            val list = value as? List<*> ?: return null
            return list.map { it as? String ?: return null }
        }

        internal fun intOf(value: Any?): Int? {
            val number = safeLongOf(value) ?: return null
            if (number < Int.MIN_VALUE || number > Int.MAX_VALUE) return null
            return number.toInt()
        }

        /** JS `Number.isSafeInteger` 口径：整数且 |v| ≤ 2^53−1（避免 Long 溢出语义混入）。 */
        internal fun safeLongOf(value: Any?): Long? {
            val number = value as? Number ?: return null
            val asDouble = number.toDouble()
            if (!asDouble.isFinite() || asDouble != kotlin.math.floor(asDouble)) return null
            if (kotlin.math.abs(asDouble) > JS_MAX_SAFE_INTEGER.toDouble()) return null
            return asDouble.toLong()
        }
    }
}

/** 模型清单不合法（格式 / 字段 / 路径安全），文案与 PC `validateManifest` 对齐。 */
class ModelPackageFormatException(message: String) : Exception(message)

/**
 * FNV-1a 32 位哈希（与 `ChatLorebookRetrieval.hashText` 同实现的算法族）。
 * 用于**派生指纹**（权重指纹 / 失效键），不用于安全校验——安全校验一律 sha256。
 */
internal object ChatHash {
    fun fnv1a36(value: String): String {
        var hash = 2166136261L
        for (ch in value) {
            hash = hash xor ch.code.toLong()
            hash = (hash * 16777619L) and 0xFFFFFFFFL
        }
        return java.lang.Long.toString(hash, 36)
    }
}

// ---------------------------------------------------------------- canonical JSON（PC `canonicalJson` 对齐）

/** PC `canonicalJson`：对象键排序（JS localeCompare 的纯 ASCII 语义）、数组保序、undefined 缺席、null 保留。 */
internal fun canonicalJson(value: Any?): String = when (value) {
    null -> "null"
    is String -> jsonQuote(value)
    is Boolean -> value.toString()
    is Number -> jsonNumber(value)
    is Map<*, *> -> value.entries
        .filter { it.key is String }
        .sortedWith(compareBy(asciiCollation) { it.key as String })
        .joinToString(",", "{", "}") { (key, item) -> "${jsonQuote(key as String)}:${canonicalJson(item)}" }
    is List<*> -> value.joinToString(",", "[", "]") { canonicalJson(it) }
    else -> jsonQuote(value.toString())
}

/**
 * JS `JSON.stringify` 的字符串转义：控制字符走 `\b \f \n \r \t` 或小写十六进制 `\u00xx`，
 * 其余（含非 ASCII）原样输出；`/` 不转义（JS 不转义，Android 的 `JSONObject` 会转义——
 * 因此这里不能用 `JSONObject.toString()` 生成验签载荷）。
 */
internal fun jsonQuote(value: String): String = buildString(value.length + 2) {
    append('"')
    for (ch in value) {
        when (ch) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000C' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (ch.code < 0x20) {
                append("\\u")
                append(ch.code.toString(16).padStart(4, '0'))
            } else {
                append(ch)
            }
        }
    }
    append('"')
}

/** 整数值按 JSON.stringify 形态（无小数点）；其余按普通十进制近似（见类注释边界 2）。 */
internal fun jsonNumber(value: Number): String {
    val asDouble = value.toDouble()
    if (!asDouble.isFinite()) return "null"
    if (asDouble == kotlin.math.floor(asDouble) && kotlin.math.abs(asDouble) < 1e21) {
        return asDouble.toLong().toString()
    }
    return value.toString()
}

/**
 * JS `localeCompare` 在纯 ASCII 键上的 en-US 语义：先忽略大小写比较，再小写在前，最后按码元。
 * `String.compareTo`（码元序）会把 `displayName` 排到 `description` 前面，与 PC 签名载荷不一致。
 */
internal val asciiCollation: Comparator<String> = object : Comparator<String> {
    override fun compare(a: String, b: String): Int {
        val lower = a.lowercase().compareTo(b.lowercase())
        if (lower != 0) return lower
        // 忽略大小写相等：小写在前（en-US collation 的次序）
        for (index in 0 until minOf(a.length, b.length)) {
            val ca = a[index]
            val cb = b[index]
            if (ca == cb) continue
            val lowerA = ca.isLowerCase()
            val lowerB = cb.isLowerCase()
            if (lowerA != lowerB) return if (lowerA) -1 else 1
            return ca.code - cb.code
        }
        return a.length - b.length
    }
}
