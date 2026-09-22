package com.qingyu.companion.media

/**
 * 阶段 6 S6-02：附件读取时的校验闸口（纯逻辑）。
 *
 * S6-02 原文：「使用 SAF 选择图片，读取时校验 MIME、magic bytes、尺寸和大小」，
 * 且 §3 要求「恶意图片、伪 MIME、超大像素、损坏输入必须被拦截」。本文件把这五项
 * 收敛成一个**先验后写**的判定序列：任何一步不过，字节就没有资格进入 blob store。
 *
 * 判定顺序是刻意的（便宜且决定性的检查在前）：
 * 空文件 → 大小上限 → 文件名安全（路径穿越）→ 伪 MIME → 结构/尺寸解析 → 像素上限。
 */
data class AttachmentLimits(
    /** 单张图片字节上限（blob store 之外的传输/解码保护）。 */
    val maxImageBytes: Long = 10L * 1024 * 1024,
    /** 单个通用文件字节上限。 */
    val maxFileBytes: Long = 25L * 1024 * 1024,
    val maxPixelWidth: Int = 4096,
    val maxPixelHeight: Int = 4096,
    /** 像素总量上限（单边合规但 4000x4000 = 1600 万像素的形状最容易漏）。 */
    val maxPixelCount: Long = 20L * 1024 * 1024,
)

sealed interface AttachmentVerdict {
    /** 校验通过：[mime] 是魔数判出的真值；图片附带真实尺寸。 */
    data class Accepted(val mime: String, val width: Int? = null, val height: Int? = null) : AttachmentVerdict

    /** 校验失败：[reason] 是中文原因，直接进 UI 提示。 */
    data class Rejected(val reason: String) : AttachmentVerdict
}

object AttachmentValidator {

    /** 文件名判定：安全名保留（供展示），危险名直接拒而不是「悄悄改名」。 */
    sealed interface NameVerdict {
        /** [base] 为 null 表示来源没有提供文件名（不阻断导入，只是不留展示名）。 */
        data class Safe(val base: String?) : NameVerdict
        data class Unsafe(val reason: String) : NameVerdict
    }

    /**
     * 文件名安全判定。
     *
     * 展示名来自 SAF 的 `OpenableColumns.DISPLAY_NAME`，完全由来源控制：
     * `../../etc/passwd`、`C:\evil.png`、含 NUL 的名字都是现实存在的攻击形状。
     * 这里**拒绝**而不是清洗——悄悄改名会让用户以为导入的是 A，库里存的是 B。
     */
    fun sanitizeFileName(raw: String?): NameVerdict {
        val name = raw?.trim()
        if (name.isNullOrEmpty()) return NameVerdict.Safe(null)
        if (name.any { it.code < 0x20 || it == '\u007f' }) {
            return NameVerdict.Unsafe("文件名包含控制字符")
        }
        if (name.contains('/') || name.contains('\\')) {
            return NameVerdict.Unsafe("文件名包含路径分隔符")
        }
        if (name == "." || name == ".." || name.contains("..")) {
            return NameVerdict.Unsafe("文件名包含路径穿越片段")
        }
        if (name.startsWith(".")) {
            return NameVerdict.Unsafe("文件名以点开头（隐藏/相对路径风险）")
        }
        if (name.length > 255) {
            return NameVerdict.Unsafe("文件名过长")
        }
        return NameVerdict.Safe(name)
    }

    /** 图片附件全量校验（MIME、magic bytes、尺寸、大小、结构完整性）。 */
    fun validateImage(
        fileName: String?,
        declaredMime: String?,
        bytes: ByteArray,
        limits: AttachmentLimits = AttachmentLimits(),
    ): AttachmentVerdict {
        if (bytes.isEmpty()) return AttachmentVerdict.Rejected("附件为空文件")
        if (bytes.size.toLong() > limits.maxImageBytes) {
            return AttachmentVerdict.Rejected("图片超过大小上限 ${limits.maxImageBytes / 1024 / 1024} MiB（实际 ${bytes.size / 1024 / 1024} MiB）")
        }
        when (val name = sanitizeFileName(fileName)) {
            is NameVerdict.Unsafe -> return AttachmentVerdict.Rejected("文件名不安全（${name.reason}）：路径穿越/伪造名不得进入 blob store")
            is NameVerdict.Safe -> Unit
        }
        val mime = when (val verdict = MagicBytes.verifyDeclaredMime(declaredMime, bytes)) {
            is MagicBytes.MimeVerdict.Consistent -> verdict.mime
            is MagicBytes.MimeVerdict.Mismatch ->
                return AttachmentVerdict.Rejected(
                    "伪 MIME：声明 ${verdict.declared ?: "(未声明)"} 与真实格式 ${verdict.sniffed ?: "无法识别"} 不符，恶意图片不得进入 blob store",
                )
        }
        if (mime !in MagicBytes.IMAGE_MIME_TYPES) {
            return AttachmentVerdict.Rejected("不是受支持的图片格式（PNG/JPEG/WebP/GIF）")
        }
        val header = when (val inspection = ImageInspector.inspect(bytes)) {
            is ImageInspection.Header -> inspection
            is ImageInspection.Rejected -> return AttachmentVerdict.Rejected(inspection.reason)
        }
        if (header.width > limits.maxPixelWidth || header.height > limits.maxPixelHeight) {
            return AttachmentVerdict.Rejected(
                "图片尺寸 ${header.width}x${header.height} 超过 ${limits.maxPixelWidth}x${limits.maxPixelHeight}（超大像素解压炸弹拦截）",
            )
        }
        if (header.width.toLong() * header.height.toLong() > limits.maxPixelCount) {
            return AttachmentVerdict.Rejected(
                "图片像素数过大（${header.width}x${header.height}）：解压炸弹在解码前被拦截",
            )
        }
        return AttachmentVerdict.Accepted(mime = header.mime, width = header.width, height = header.height)
    }

    /** 通用文件附件校验（`attachments.file`：无尺寸概念，其余红线一致）。 */
    fun validateFile(
        fileName: String?,
        declaredMime: String?,
        bytes: ByteArray,
        limits: AttachmentLimits = AttachmentLimits(),
    ): AttachmentVerdict {
        if (bytes.isEmpty()) return AttachmentVerdict.Rejected("附件为空文件")
        if (bytes.size.toLong() > limits.maxFileBytes) {
            return AttachmentVerdict.Rejected("文件超过大小上限 ${limits.maxFileBytes / 1024 / 1024} MiB（实际 ${bytes.size / 1024 / 1024} MiB）")
        }
        when (val name = sanitizeFileName(fileName)) {
            is NameVerdict.Unsafe -> return AttachmentVerdict.Rejected("文件名不安全（${name.reason}）：路径穿越/伪造名不得进入 blob store")
            is NameVerdict.Safe -> Unit
        }
        return when (val verdict = MagicBytes.verifyDeclaredMime(declaredMime, bytes)) {
            is MagicBytes.MimeVerdict.Consistent ->
                if (verdict.mime in MagicBytes.FILE_MIME_TYPES) {
                    AttachmentVerdict.Accepted(mime = verdict.mime)
                } else {
                    AttachmentVerdict.Rejected("不支持的文件类型：${verdict.mime}")
                }
            is MagicBytes.MimeVerdict.Mismatch ->
                AttachmentVerdict.Rejected(
                    "伪 MIME：声明 ${verdict.declared ?: "(未声明)"} 与真实格式 ${verdict.sniffed ?: "无法识别"} 不符，恶意文件不得进入 blob store",
                )
        }
    }
}
