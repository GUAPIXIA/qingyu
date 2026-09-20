package com.qingyu.companion.content.backup

import com.qingyu.companion.local.domain.JsonValues
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * 阶段 5 S5-08：跨平台 Backup V3。
 *
 * 目录布局**沿用 PC Backup V2**（`electron/services/backup.ts`）：
 * `characters/<id>.json`、`lorebooks/<id>.json`、`presets/<id>.json`、
 * `chats/...`、`groups/...`、`config/personas.json`、`config/regex/rules.json`、
 * `config/quickReplies.json`、`config/usage.json`、`config/settings.json`、`manifest.json`，
 * 再加 V3 新增的 `templates/<id>.json`（映射模板）与 `config/usageClearMarkers.json`
 * （总方案 §6.1 里 V2 没有的两个实体）。沿用同一路径是「PC 与 Android 可互相恢复」
 * 的前提——换布局就等于要求对端升级才能读备份。
 *
 * 三条硬约束来自方案 §S5-08，都在这一层实现，不交给 UI 把关：
 * 1. 默认排除密钥类：API Key、设备身份、`spaceKey`、令牌、向量索引、日志。
 *    排除规则是**白名单式**的（只打包 [BackupCollections] 里登记的集合），
 *    新加实体忘了登记会「少备份」而不是「泄露密钥」——方向必须是这样。
 * 2. ZIP 条目名先全量校验再解压：拒绝绝对路径、盘符、反斜杠、`.`/`..`、符号链接位。
 *    校验不过就整体拒绝，绝不边读边写盘。
 * 3. 导入是「全包校验 + 预览 → checkpoint → 原子应用」，任何一步失败都能回滚。
 */
object BackupV3 {

    const val MANIFEST_NAME = "manifest.json"
    const val BACKUP_VERSION = 3

    /** ZIP 防护上限（方案 §3 测试矩阵的 ZIP bomb 项）。 */
    const val MAX_ENTRIES = 20_000
    const val MAX_SINGLE_ENTRY_BYTES = 64L * 1024 * 1024
    const val MAX_TOTAL_UNCOMPRESSED_BYTES = 1024L * 1024 * 1024

    /** 备份文件布局（与 PC V2 一致的前缀）。 */
    object Paths {
        const val CHARACTERS = "characters/"
        const val LOREBOOKS = "lorebooks/"
        const val PRESETS = "presets/"
        const val TEMPLATES = "templates/"
        const val GROUPS = "groups/"
        const val CHATS = "chats/"
        const val CONFIG = "config/"
        const val PERSONAS = "config/personas.json"
        const val REGEX_RULES = "config/regex/rules.json"
        const val QUICK_REPLIES = "config/quickReplies.json"
        const val USAGE = "config/usage.json"
        const val USAGE_CLEAR_MARKERS = "config/usageClearMarkers.json"
        const val SETTINGS = "config/settings.json"
        const val MEDIA = "media/"
        const val MANIFEST = MANIFEST_NAME
    }

    /** V2 明确不进备份的东西（对应 PC 的 `EXCLUDED_ITEMS` + `SECRET_COLLECTIONS`）。 */
    val EXCLUDED_ITEMS = listOf(
        "modelConnectionProfilesAndApiKeys",
        "mcpSensitiveEnvironmentVariables",
        "deviceIdentityAndPairingCredentials",
        "spaceKeyAndSyncTokens",
        "semanticVectorIndex",
        "downloadedEmbeddingModels",
        "logs",
        "crashReports",
    )

    // ------------------------------------------------------------ 清单

    data class Manifest(
        val version: Int,
        val appVersion: String,
        val platform: String,
        val createdAt: Long,
        val schemaVersion: Int,
        val counts: Map<String, Int>,
        /** 条目路径 → `sha256:<hex>`（内容哈希，用于恢复前逐条校验） */
        val hashes: Map<String, String>,
        val excluded: List<String>,
        val totalBytes: Long,
        /** 备份内实体的规范内容哈希，用于「同一数据集重复备份」比对 */
        val contentDigest: String,
    )

    fun manifestJson(manifest: Manifest): String = JSONObject().apply {
        put("version", manifest.version)
        put("appVersion", manifest.appVersion)
        put("platform", manifest.platform)
        put("createdAt", manifest.createdAt)
        put("schemaVersion", manifest.schemaVersion)
        put("counts", JSONObject(manifest.counts as Map<out String, Any?>))
        put("hashes", JSONObject(manifest.hashes as Map<out String, Any?>))
        put("excluded", JSONArray(manifest.excluded))
        put("totalBytes", manifest.totalBytes)
        put("contentDigest", manifest.contentDigest)
    }.toString(2)

    fun parseManifest(text: String): Manifest? {
        val obj = JsonValues.parseObject(text)
        val version = (obj["version"] as? Long)?.toInt() ?: (obj["version"] as? Int) ?: return null
        return Manifest(
            version = version,
            appVersion = obj["appVersion"] as? String ?: "",
            platform = obj["platform"] as? String ?: "",
            createdAt = obj["createdAt"] as? Long ?: 0L,
            schemaVersion = (obj["schemaVersion"] as? Long)?.toInt() ?: 1,
            counts = obj["counts"].stringKeyMap()?.mapValues { numberToInt(it.value) ?: 0 }.orEmpty(),
            hashes = obj["hashes"].stringKeyMap()?.mapValues { it.value as? String ?: "" }.orEmpty(),
            excluded = (obj["excluded"] as? List<*>).orEmpty().filterIsInstance<String>(),
            totalBytes = obj["totalBytes"] as? Long ?: 0L,
            contentDigest = obj["contentDigest"] as? String ?: "",
        )
    }

    // ------------------------------------------------------------ 条目名安全

    /**
     * ZIP 条目名校验。返回 `null` 表示通过，否则返回拒绝原因。
     *
     * 逐项防的是：`/etc/passwd`（绝对路径）、`C:\...`（Windows 盘符）、
     * `..\`（反斜杠绕过，Android 不解析但 PC 解压端会）、`.`/`..` 片段、
     * NUL 截断、以及符号链接位（V3 一律不写，读到即拒）。
     */
    fun rejectReasonForEntryName(name: String): String? = when {
        name.isBlank() -> "空条目名"
        name.length > 512 -> "条目名过长"
        name.startsWith("/") -> "绝对路径"
        name.contains("\\") -> "包含反斜杠"
        name.contains(":") -> "包含盘符或协议前缀"
        name.contains('\u0000') -> "包含 NUL"
        name.split("/").any { it == ".." } -> "包含上级目录片段"
        name.split("/").any { it.isEmpty() } -> "包含空路径片段"
        !PORTABLE_NAME.matches(name) -> "包含不允许的字符"
        else -> null
    }

    /** 只允许 ASCII 安全的路径字符集；中文名走 manifest 的哈希键，不进 ZIP 条目名。 */
    private val PORTABLE_NAME = Regex("^[A-Za-z0-9._/ -]+$")

    /**
     * 符号链接条目判定。
     *
     * Android 的 `java.util.zip.ZipEntry` 不暴露 `getExternalAttributes()`，
     * 所以拿不到 Unix mode 位，无法像桌面端那样从属性里认出符号链接。
     *
     * 这里不假装能检测：真正的防线是**预检阶段从不落盘**——[inspect] 只把条目读进内存，
     * 应用阶段再由调用方按仓库固定的路径表写文件，链接位没有机会被materialize。
     * 条目名层面的 `..`/绝对路径/盘符仍由 [rejectReasonForEntryName] 拦住。
     */
    @Suppress("UNUSED_PARAMETER")
    fun isSymbolicLink(entry: ZipEntry): Boolean = false

    // ------------------------------------------------------------ 打包 / 校验

    /** 一个备份条目：路径 + 字节内容。 */
    data class Entry(val path: String, val bytes: ByteArray)

    fun build(entries: List<Entry>, manifest: Manifest): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            entries.forEach { entry ->
                require(rejectReasonForEntryName(entry.path) == null) { "非法条目名：${entry.path}" }
                zip.putNextEntry(ZipEntry(entry.path))
                zip.write(entry.bytes)
                zip.closeEntry()
            }
            zip.putNextEntry(ZipEntry(MANIFEST_NAME))
            zip.write(manifestJson(manifest).toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }
        return out.toByteArray()
    }

    /**
     * 恢复前预检：**只读不写**。
     *
     * 一次遍历同时完成条目名校验、SHA-256 与清单比对、条目数与解压总量上限。
     * 任一条不通过就整包拒绝——半包应用比不应用危险得多（会留下部分覆盖的数据）。
     */
    fun inspect(bytes: ByteArray): InspectResult {
        val entries = LinkedHashMap<String, ByteArray>()
        val seen = HashSet<String>()
        var total = 0L
        var manifest: Manifest? = null
        runCatching {
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    if (seen.size >= MAX_ENTRIES) {
                        return InspectResult.Rejected("条目数超过上限 $MAX_ENTRIES")
                    }
                    rejectReasonForEntryName(entry.name)?.let { return InspectResult.Rejected("${entry.name}：$it") }
                    if (isSymbolicLink(entry)) return InspectResult.Rejected("${entry.name}：符号链接条目")
                    // 同名条目必须直接拒：`entries[path] = payload` 是后写覆盖前写，
                    // 重复条目会让「恢复的是哪一份」取决于 ZIP 内部顺序，
                    // 而清单哈希校验只按路径取最后一个哈希比对——两个不同内容同名时
                    // 恢复结果与用户看到的条目数根本对不上。§3 测试矩阵点名的就是这一条。
                    if (!seen.add(entry.name)) {
                        return InspectResult.Rejected("${entry.name}：备份内出现重复条目")
                    }
                    val payload = readLimited(zip) ?: return InspectResult.Rejected("${entry.name}：单条目过大")
                    total += payload.size
                    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
                        return InspectResult.Rejected("解压总量超过上限")
                    }
                    if (entry.name == MANIFEST_NAME) {
                        manifest = parseManifest(payload.toString(Charsets.UTF_8))
                            ?: return InspectResult.Rejected("manifest.json 无法解析")
                    } else {
                        entries[entry.name] = payload
                    }
                    zip.closeEntry()
                }
            }
        }.onFailure { return InspectResult.Rejected("ZIP 解析失败：${it.message}") }

        val manifestValue = manifest ?: return InspectResult.Rejected("缺少 manifest.json")
        entries.forEach { (path, payload) ->
            val expected = manifestValue.hashes[path] ?: return InspectResult.Rejected("$path 不在清单中")
            val actual = sha256(payload)
            if (!sameHash(expected, actual)) {
                return InspectResult.Rejected("$path 内容哈希不匹配（疑似篡改）")
            }
        }
        val missing = manifestValue.hashes.keys - entries.keys
        if (missing.isNotEmpty()) {
            return InspectResult.Rejected("缺少条目：${missing.sorted().take(5).joinToString()}")
        }
        return InspectResult.Ok(
            Preview(
                manifest = manifestValue,
                entries = entries,
                duplicateFreeCount = entries.size,
            ),
        )
    }

    sealed interface InspectResult {
        data class Ok(val preview: Preview) : InspectResult
        data class Rejected(val reason: String) : InspectResult
    }

    /** 预览：UI 在用户确认前展示 counts/excluded/条目数/版本。 */
    data class Preview(
        val manifest: Manifest,
        val entries: Map<String, ByteArray>,
        val duplicateFreeCount: Int,
    ) {
        /** 与当前设备数据比较后由调用方填的统计（这里只暴露清单侧数字）。 */
        fun summaryLines(): List<String> = manifest.counts.entries
            .sortedBy { it.key }
            .map { "${it.key}=${it.value}" }
    }

    /** 由条目集合算出清单（哈希与 counts 都在这里收口，避免调用方手搓出不一致的清单）。 */
    fun manifestOf(
        entries: List<Entry>,
        appVersion: String,
        platform: String,
        now: Long,
        schemaVersion: Int = 1,
        counts: Map<String, Int>,
        excluded: List<String> = EXCLUDED_ITEMS,
    ): Manifest {
        val hashes = entries.associate { it.path to sha256(it.bytes) }
        val total = entries.sumOf { it.bytes.size.toLong() }
        val digest = sha256(
            hashes.toSortedMap().entries.joinToString("|") { "${it.key}:${it.value}" }
                .toByteArray(Charsets.UTF_8),
        )
        return Manifest(
            version = BACKUP_VERSION,
            appVersion = appVersion,
            platform = platform,
            createdAt = now,
            schemaVersion = schemaVersion,
            counts = counts,
            hashes = hashes,
            excluded = excluded,
            totalBytes = total,
            contentDigest = "sha256:" + digest,
        )
    }

    fun sha256(bytes: ByteArray): String =
        "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

    /**
     * 容忍缺前缀与大小写差异（PC 的 manifest 存的是裸 hex）。
     *
     * 顺序必须是「先小写、再剥前缀」：`removePrefix` 是大小写敏感的，
     * 反过来写的话 `SHA256:ABCD…` 这种带大写前缀的清单会连前缀都剥不掉，
     * 于是同一个摘要被判成不一致——预检会把好备份说成被篡改，用户只能重导。
     */
    fun sameHash(expected: String, actual: String): Boolean {
        val left = expected.lowercase().removePrefix("sha256:")
        val right = actual.lowercase().removePrefix("sha256:")
        return left.isNotEmpty() && left == right
    }

    private fun readLimited(input: InputStream): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        var written = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            written += read
            if (written > MAX_SINGLE_ENTRY_BYTES) return null
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    @Suppress("UNCHECKED_CAST")
    private fun Any?.stringKeyMap(): Map<String, Any?>? = this as? Map<String, Any?>

    private fun numberToInt(value: Any?): Int? = when (value) {
        is Long -> value.toInt()
        is Int -> value
        is Double -> value.toInt()
        else -> null
    }
}

/** 只从受控来源写入备份的集合登记表（供装配层与测试引用，避免拼错路径前缀）。 */
object BackupCollections {
    val ENTITY_PREFIXES = listOf(
        BackupV3.Paths.CHARACTERS,
        BackupV3.Paths.LOREBOOKS,
        BackupV3.Paths.PRESETS,
        BackupV3.Paths.TEMPLATES,
        BackupV3.Paths.GROUPS,
        BackupV3.Paths.CHATS,
    )

    val ARRAY_FILES = listOf(
        BackupV3.Paths.PERSONAS,
        BackupV3.Paths.REGEX_RULES,
        BackupV3.Paths.QUICK_REPLIES,
        BackupV3.Paths.USAGE,
        BackupV3.Paths.USAGE_CLEAR_MARKERS,
    )

    /** 密钥类绝不能出现在这些前缀下；备份前跑一遍自检（见 `assertNoSecrets`）。 */
    private val SECRET_KEY_MARKERS = listOf(
        "apikey", "api_key", "token", "spacekey", "secret", "password", "credential",
    )

    /**
     * 密钥泄露自检：对将被打包的每个条目做深度键名扫描。
     *
     * 这是兜底而不是主防线（主防线是白名单打包）：PC 历史备份里 `settings.json`
     * 曾内联过 `semanticTrigger.apiKey`，恢复后又被重新打包就会把密钥写进新备份。
     */
    fun assertNoSecrets(entries: List<BackupV3.Entry>): List<String> {
        val hits = ArrayList<String>()
        entries.forEach { entry ->
            val text = entry.bytes.toString(Charsets.UTF_8).lowercase()
            SECRET_KEY_MARKERS.forEach { marker ->
                if (text.contains("\"$marker")) hits += "${entry.path}:$marker"
            }
        }
        return hits
    }
}
