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

    /**
     * 契约层的解压总量上限（1 GiB）。
     *
     * 2026-09-20 起它的角色变了：[inspect] 与 [streamEntries] 都是**逐条目流式**的
     * （一次只持有一个条目的字节，条目哈希只留 71 字节的小字符串），
     * 所以「解压总量」不再与内存挂钩，这条上限回到它本来的用途——
     * **防 ZIP bomb 的契约闸门**（两端与 §3 测试矩阵都按它说话）。
     * 内存约束改由 [residentBudgetBytes] 描述，见 [inspect] 的 `budgetBytes`。
     */
    const val MAX_TOTAL_UNCOMPRESSED_BYTES = 1024L * 1024 * 1024

    /**
     * 单条目预算占「可用堆」的比例。
     *
     * 留一半给解压缓冲、JSON 解析对象与源包本身：同一时刻还在内存里的是
     * 「源包 + **一个**条目字节 + 解析出来的 JSONObject」。
     * 取 0.5 是刻意保守——宁可早一点给出可读的拒绝，也不要撞上 OOM 再兜。
     */
    private const val RESIDENT_HEAP_FRACTION = 0.5

    private const val MIB = 1024L * 1024L

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
     * 本进程真正放得下的**单条目**预算：`MAX_SINGLE_ENTRY_BYTES`（64 MiB，契约）与
     * 「可用堆的一半」取小。
     *
     * 纯函数（堆大小可注入）是为了可测：设备上的真实堆值不该成为断言的一部分。
     * `sourceBytes` 是源包自身的字节数——它此刻已经在内存里，所以要从堆里先扣掉；
     * 扣完不够就返回 0，调用方据此直接拒绝，而不是等 OOM。
     *
     * **语义变化（2026-09-20）**：以前它约束的是「所有条目解压后**之和**」（因为 `inspect`
     * 把整包条目都留在内存里，大备份必然 OOM）。现在读写都是逐条目流式的，
     * 于是约束只剩「**最大的那一个条目**」——同一台设备因此能处理大得多的备份，
     * 而解压总量由 [MAX_TOTAL_UNCOMPRESSED_BYTES] 单独把关。
     */
    fun residentBudgetBytes(
        sourceBytes: Long,
        heapMaxBytes: Long = Runtime.getRuntime().maxMemory(),
    ): Long {
        val headroom = heapMaxBytes - sourceBytes
        if (headroom <= 0) return 0
        return minOf(MAX_SINGLE_ENTRY_BYTES, (headroom * RESIDENT_HEAP_FRACTION).toLong())
    }

    /**
     * 预检失败时的**如实**文案。
     *
     * `inspect` 里那句 `runCatching` 会把 `OutOfMemoryError` 一起吞掉，
     * 于是「本机内存不够」被报成「ZIP 解析失败：Java heap space」——用户看到的是
     * 「这个包坏了」，于是重导一遍、或者去怀疑文件来源，而真正该做的是换到 PC 上恢复。
     * 这条分支把两种失败分开，并且都给出下一步动作。
     */
    fun describeInspectFailure(error: Throwable, uncompressedBytes: Long): String =
        if (error is OutOfMemoryError) {
            "本机内存不足，无法校验这个备份（已解压约 ${uncompressedBytes / MIB} MB）：" +
                "请改在 PC 上恢复，或分批导出后分别恢复。"
        } else {
            "ZIP 解析失败：${error.message}"
        }

    /**
     * 恢复前预检：**只读不写**，且**逐条目流式**。
     *
     * 一次遍历同时完成条目名校验、单条上限、条目数上限、解压总量（契约）与 SHA-256 比对。
     * 任一条不通过就整包拒绝——半包应用比不应用危险得多（会留下部分覆盖的数据）。
     *
     * **流式的关键**：每个条目的字节只在这一层短暂存在（读完即算哈希、即丢），
     * 留在 [Preview] 里的只有路径与 71 字节的哈希字符串。此前 `Preview.entries`
     * 把整包解压结果全留在内存里，于是「备份比堆还大」只能被拒（见 §5-P1-d）。
     *
     * `budgetBytes` 缺省取 [residentBudgetBytes]（单条目预算）；显式传入是为了让
     * 「单条目超出预算」这条分支能在**不真的分配几百 MB** 的前提下被测到。
     * 传进来的值仍会被契约上限 [MAX_SINGLE_ENTRY_BYTES] 夹住，契约不因注入而放宽。
     */
    fun inspect(
        bytes: ByteArray,
        budgetBytes: Long = residentBudgetBytes(bytes.size.toLong()),
    ): InspectResult {
        val perEntryBudget = minOf(budgetBytes, MAX_SINGLE_ENTRY_BYTES)
        if (perEntryBudget <= 0) {
            return InspectResult.Rejected(
                "本机可用内存不足以校验这个备份（源包 ${bytes.size / MIB} MB）：请改在 PC 上恢复。",
            )
        }
        val seen = LinkedHashSet<String>()
        // 只留「路径 → 内容哈希」：20k 条上限下最坏也就 ~1.4 MB，与条目体积无关
        val hashes = LinkedHashMap<String, String>()
        var total = 0L
        var manifest: Manifest? = null
        var rejection: String? = null
        runCatching {
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: return@use
                    if (seen.size >= MAX_ENTRIES) {
                        rejection = "条目数超过上限 $MAX_ENTRIES"
                        return@use
                    }
                    rejectReasonForEntryName(entry.name)?.let { reason ->
                        rejection = "${entry.name}：$reason"
                        return@use
                    }
                    if (isSymbolicLink(entry)) {
                        rejection = "${entry.name}：符号链接条目"
                        return@use
                    }
                    // 同名条目必须直接拒：后写覆盖前写会让「恢复的是哪一份」取决于 ZIP 内部顺序，
                    // 而清单哈希校验只按路径取最后一个哈希比对——两个不同内容同名时
                    // 恢复结果与用户看到的条目数根本对不上。§3 测试矩阵点名的就是这一条。
                    if (!seen.add(entry.name)) {
                        rejection = "${entry.name}：备份内出现重复条目"
                        return@use
                    }
                    val payload = readLimited(zip, perEntryBudget)
                    if (payload == null) {
                        // 措辞被 instrumented 用例钉着（`backup:oversizedSingleEntry…`）：
                        // 必须同时说清「单条目过大」「上限」「不是堆崩」，并给出下一步
                        rejection = "${entry.name}：单条目过大（超过本机可校验上限" +
                            " ${perEntryBudget / MIB} MB）：请改在 PC 上恢复。"
                        return@use
                    }
                    total += payload.size
                    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
                        rejection = "备份解压后合计超过契约上限 ${MAX_TOTAL_UNCOMPRESSED_BYTES / MIB} MB（疑似 ZIP bomb）"
                        return@use
                    }
                    if (entry.name == MANIFEST_NAME) {
                        val parsed = parseManifest(payload.toString(Charsets.UTF_8))
                        if (parsed == null) {
                            rejection = "manifest.json 无法解析"
                            return@use
                        }
                        manifest = parsed
                    } else {
                        hashes[entry.name] = sha256(payload)
                    }
                    zip.closeEntry()
                }
            }
        }.onFailure { return InspectResult.Rejected(describeInspectFailure(it, total)) }
        rejection?.let { return InspectResult.Rejected(it) }

        val manifestValue = manifest ?: return InspectResult.Rejected("缺少 manifest.json")
        hashes.forEach { (path, actual) ->
            val expected = manifestValue.hashes[path] ?: return InspectResult.Rejected("$path 不在清单中")
            if (!sameHash(expected, actual)) {
                return InspectResult.Rejected("$path 内容哈希不匹配（疑似篡改）")
            }
        }
        val missing = manifestValue.hashes.keys - hashes.keys
        if (missing.isNotEmpty()) {
            return InspectResult.Rejected("缺少条目：${missing.sorted().take(5).joinToString()}")
        }
        return InspectResult.Ok(
            Preview(
                manifest = manifestValue,
                entryPaths = hashes.keys.toList(),
                duplicateFreeCount = hashes.size,
            ),
        )
    }

    /**
     * 逐条目流式读取（**一次只持有一个条目的字节**）：恢复端按路径分发时用这个，
     * 而不是先 `inspect` 拿到一整张 `Map<路径, 字节>`。
     *
     * 安全护栏与 [inspect] 同源（条目名、重复、单条上限、条目数、解压总量），
     * 因为它是公开入口，不能假设调用方一定先跑过预检。
     * `manifest.json` 不交给回调——它由 [inspect] 负责解析与校验。
     *
     * 返回 `null` 表示成功，否则是拒绝原因（调用方必须据此失败，不能继续写库）。
     */
    suspend fun streamEntries(
        bytes: ByteArray,
        budgetBytes: Long = residentBudgetBytes(bytes.size.toLong()),
        onEntry: suspend (path: String, payload: ByteArray) -> Unit,
    ): String? {
        val perEntryBudget = minOf(budgetBytes, MAX_SINGLE_ENTRY_BYTES)
        if (perEntryBudget <= 0) {
            return "本机可用内存不足以读取这个备份（源包 ${bytes.size / MIB} MB）：请改在 PC 上恢复。"
        }
        val seen = HashSet<String>()
        var total = 0L
        var rejection: String? = null
        runCatching {
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: return@use
                    if (seen.size >= MAX_ENTRIES) {
                        rejection = "条目数超过上限 $MAX_ENTRIES"
                        return@use
                    }
                    rejectReasonForEntryName(entry.name)?.let { reason ->
                        rejection = "${entry.name}：$reason"
                        return@use
                    }
                    if (isSymbolicLink(entry)) {
                        rejection = "${entry.name}：符号链接条目"
                        return@use
                    }
                    if (!seen.add(entry.name)) {
                        rejection = "${entry.name}：备份内出现重复条目"
                        return@use
                    }
                    val payload = readLimited(zip, perEntryBudget)
                    if (payload == null) {
                        rejection = "${entry.name}：单条目过大（超过本机可校验上限" +
                            " ${perEntryBudget / MIB} MB）：请改在 PC 上恢复。"
                        return@use
                    }
                    total += payload.size
                    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
                        rejection = "备份解压后合计超过契约上限 ${MAX_TOTAL_UNCOMPRESSED_BYTES / MIB} MB（疑似 ZIP bomb）"
                        return@use
                    }
                    if (entry.name != MANIFEST_NAME) onEntry(entry.name, payload)
                    zip.closeEntry()
                }
            }
        }.onFailure { return describeInspectFailure(it, total) }
        return rejection
    }

    sealed interface InspectResult {
        data class Ok(val preview: Preview) : InspectResult
        data class Rejected(val reason: String) : InspectResult
    }

    /**
     * 预览：UI 在用户确认前展示 counts/excluded/条目数/版本。
     *
     * **不持有条目字节**（2026-09-20 起）：只留路径与清单。
     * 恢复时由 [streamEntries] 按路径重读——这是「多大的备份都能恢复」的前提。
     */
    data class Preview(
        val manifest: Manifest,
        /** 校验通过的非 manifest 条目路径，按 ZIP 内顺序 */
        val entryPaths: List<String>,
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

    private fun readLimited(input: InputStream, limit: Long = MAX_SINGLE_ENTRY_BYTES): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        var written = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            written += read
            if (written > limit) return null
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
