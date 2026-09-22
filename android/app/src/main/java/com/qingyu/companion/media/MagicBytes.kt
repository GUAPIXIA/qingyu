package com.qingyu.companion.media

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/**
 * 阶段 6 S6-02：字节签名（magic bytes）嗅探与「声明 MIME ↔ 真实魔数」一致性判定。
 *
 * 为什么不能拿 `PngTextChunks.detectMimeType` 当白名单：它对未知输入**回落到 image/png**
 * （那是与 PC 对齐、供角色卡导出用的行为），拿它判合法性等于不设闸——一份改名叫 `.png`
 * 的 HTML 会一路混到解码那步。这里只认真实签名，认不出就是认不出。
 *
 * 「伪 MIME」是本任务明文要求拦截的攻击面：来源（SAF 的 Content-Type、文件扩展名、
 * data URL 头）都由用户/其他设备可控，**声明值只能用来做一致性比对，绝不能当真值使用**。
 * 判定规则因此是「魔数为准，声明必须与魔数一致」；声明缺失时以魔数为唯一依据。
 */
object MagicBytes {
    const val MIME_PNG = "image/png"
    const val MIME_JPEG = "image/jpeg"
    const val MIME_GIF = "image/gif"
    const val MIME_WEBP = "image/webp"
    const val MIME_PDF = "application/pdf"
    const val MIME_ZIP = "application/zip"
    const val MIME_GZIP = "application/gzip"
    const val MIME_TEXT = "text/plain"

    /** 识图/图片附件允许的四种真实图片格式（与 PC 侧 `adapters/vision.ts` 的 image/＊ 通配约定一致）。
     *  注：注释里的星号用全角——Kotlin 块注释可嵌套，`／*` 序列会吞掉后续全部代码。 */
    val IMAGE_MIME_TYPES: Set<String> = setOf(MIME_PNG, MIME_JPEG, MIME_GIF, MIME_WEBP)

    /** 通用文件附件允许的格式（图片在内；`attachments.file` 矩阵行的「Android 图片为主 + SAF」口径）。 */
    val FILE_MIME_TYPES: Set<String> = IMAGE_MIME_TYPES + setOf(MIME_PDF, MIME_ZIP, MIME_GZIP, MIME_TEXT)

    private val MIME_ALIASES = mapOf(
        "image/jpg" to MIME_JPEG,
        "image/pjpeg" to MIME_JPEG,
        "image/x-png" to MIME_PNG,
        "image/x-gif" to MIME_GIF,
        "application/x-zip-compressed" to MIME_ZIP,
        "application/x-gzip" to MIME_GZIP,
        "application/x-pdf" to MIME_PDF,
    )

    /**
     * 归一化声明的 MIME：去参数、小写、消别名。
     *
     * 来源的 Content-Type 可能带 `; charset=…` 之类的参数，也可能写 `image/jpg`
     * （非标准别名）。这些都不算伪 MIME，比对前先归一化，否则会把正常图片误杀。
     */
    fun normalizeMime(raw: String?): String? {
        val base = raw?.substringBefore(';')?.trim()?.lowercase()?.takeWhile { it != ' ' }
            ?.takeIf { it.isNotEmpty() } ?: return null
        return MIME_ALIASES[base] ?: base
    }

    /** 只认四种真实图片签名；不匹配返回 null。 */
    fun detectImageMime(bytes: ByteArray): String? = when {
        bytes.startsAt(PNG_SIGNATURE) -> MIME_PNG
        bytes.size >= 3 &&
            bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte() -> MIME_JPEG
        bytes.startsAt(GIF87) || bytes.startsAt(GIF89) -> MIME_GIF
        bytes.size >= 12 && bytes.startsAt(RIFF) && bytes.startsAt(WEBP, 8) -> MIME_WEBP
        else -> null
    }

    /** 通用附件嗅探：图片优先，其次 PDF/ZIP/GZIP，最后「确实是文本」回落 text/plain。 */
    fun detectFileMime(bytes: ByteArray): String? = detectImageMime(bytes) ?: when {
        bytes.startsAt(PDF_SIGNATURE) -> MIME_PDF
        bytes.startsAt(ZIP_SIGNATURE) || bytes.startsAt(ZIP_EMPTY) || bytes.startsAt(ZIP_SPANNED) -> MIME_ZIP
        bytes.size >= 2 && bytes[0] == 0x1f.toByte() && bytes[1] == 0x8b.toByte() -> MIME_GZIP
        looksLikeText(bytes) -> MIME_TEXT
        else -> null
    }

    /** MIME 一致性判定结果。 */
    sealed interface MimeVerdict {
        /** [mime] 是魔数判出的真值（声明一致或声明缺失）。 */
        data class Consistent(val mime: String) : MimeVerdict

        /** 声明与魔数不符（伪 MIME）或内容无法识别。 */
        data class Mismatch(val declared: String?, val sniffed: String?) : MimeVerdict
    }

    /**
     * 校验声明 MIME 与真实魔数一致。
     *
     * - 声明缺失：无可欺骗，直接采用魔数结果；
     * - 魔数识别不出：无论声明什么都拒（「声明成图片的未知字节」必须在写盘前死掉）；
     * - 两者都有但不一致：伪 MIME，拒。
     */
    fun verifyDeclaredMime(declaredRaw: String?, bytes: ByteArray): MimeVerdict {
        val sniffed = detectFileMime(bytes) ?: return MimeVerdict.Mismatch(declaredRaw, null)
        val declared = normalizeMime(declaredRaw) ?: return MimeVerdict.Consistent(sniffed)
        return if (declared == sniffed) MimeVerdict.Consistent(sniffed) else MimeVerdict.Mismatch(declared, sniffed)
    }

    /** 文本判定：无 NUL、合法 UTF-8。二进制垃圾不会因为「声明 text/plain」蒙混过关。 */
    fun looksLikeText(bytes: ByteArray): Boolean {
        if (bytes.isEmpty()) return false
        if (bytes.any { it == 0.toByte() }) return false
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return runCatching { decoder.decode(ByteBuffer.wrap(bytes)) }.isSuccess
    }

    internal fun ByteArray.startsAt(prefix: ByteArray, at: Int = 0): Boolean {
        if (size < at + prefix.size) return false
        return prefix.indices.all { this[at + it] == prefix[it] }
    }

    private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    private val GIF87 = "GIF87a".toByteArray(Charsets.US_ASCII)
    private val GIF89 = "GIF89a".toByteArray(Charsets.US_ASCII)
    private val RIFF = "RIFF".toByteArray(Charsets.US_ASCII)
    private val WEBP = "WEBP".toByteArray(Charsets.US_ASCII)
    private val PDF_SIGNATURE = "%PDF-".toByteArray(Charsets.US_ASCII)
    private val ZIP_SIGNATURE = byteArrayOf(0x50, 0x4b, 0x03, 0x04)
    private val ZIP_EMPTY = byteArrayOf(0x50, 0x4b, 0x05, 0x06)
    private val ZIP_SPANNED = byteArrayOf(0x50, 0x4b, 0x07, 0x08)
}
