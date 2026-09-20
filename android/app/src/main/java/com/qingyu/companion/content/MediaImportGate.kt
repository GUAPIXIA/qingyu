package com.qingyu.companion.content

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import java.security.MessageDigest

/**
 * 阶段 5 S5-01：角色头像 / 聊天背景 / 封面的导入落盘。
 *
 * 方案的原话是「导入文件走 Storage Access Framework，限制数量、单文件和总大小；
 * **媒体先解码验证再进入私有目录**」。这里实现后半句和限制部分，
 * 前半句（SAF 选择器）在 UI 层，它只负责把字节交进来。
 *
 * 为什么必须「先解码验证」再落盘：
 * 1. 改名的 PNG（实为 HTML/EXIF 缩略图/截断流）在社区卡里非常常见。直接落盘的话，
 *    导入时看起来成功，等到聊天页加载头像才失败，用户已经找不回来源文件；
 * 2. 解码尺寸上限同时挡住「4 万像素宽图把渲染层 OOM」这一类攻击面；
 * 3. 内容寻址文件名（sha256）要求字节本身可信——验不过就不该占用存储。
 */
class MediaImportGate(
    private val mediaRoot: File,
    private val decoder: Decoder = AndroidBitmapDecoder,
    private val limits: Limits = Limits(),
) {

    data class Limits(
        val maxBytesPerFile: Long = 10L * 1024 * 1024,
        val maxTotalBytesPerBatch: Long = 60L * 1024 * 1024,
        val maxFilesPerBatch: Int = 50,
        val maxPixelWidth: Int = 4096,
        val maxPixelHeight: Int = 4096,
        val maxPixelCount: Long = 20L * 1024 * 1024,
    )

    /** 解码结果：只取尺寸与格式，不驻留位图（大图在解码阶段就拒）。 */
    data class ImageInfo(val width: Int, val height: Int, val mimeType: String)

    sealed interface Outcome {
        /** [relPath] 是相对 `mediaRoot` 的路径，直接写进 `LocalCharacterEntity.avatarPath`。 */
        data class Accepted(val relPath: String, val bytes: Long, val reused: Boolean) : Outcome
        data class Rejected(val reason: String) : Outcome
    }

    private var batchBytes = 0L
    private var batchFiles = 0

    /** 一批导入开始时调用；批次上限是「一批一共吃多少磁盘」，不是单文件上限。 */
    fun beginBatch() {
        batchBytes = 0L
        batchFiles = 0
    }

    /**
     * 校验并落盘一个媒体文件。
     *
     * 顺序是刻意的：数量上限 → 单文件大小 → 魔数 → 解码尺寸 → 批次总量 → 写盘。
     * 把「解码」放在写盘之前是本任务的核心要求；把批次总量放在最后，
     * 是因为只有确定要落盘的字节才该占用配额。
     */
    fun accept(kind: String, fileName: String?, bytes: ByteArray): Outcome {
        if (kind !in ALLOWED_KINDS) {
            return Outcome.Rejected("不支持的媒体类别：$kind")
        }
        if (batchFiles >= limits.maxFilesPerBatch) {
            return Outcome.Rejected("单次导入最多 ${limits.maxFilesPerBatch} 个文件")
        }
        if (bytes.isEmpty()) {
            return Outcome.Rejected("文件为空")
        }
        if (bytes.size.toLong() > limits.maxBytesPerFile) {
            return Outcome.Rejected("单个文件超过 ${limits.maxBytesPerFile / 1024 / 1024} MiB")
        }
        // `detectMimeType` 与 PC 一致地对未知输入**回落到 image/png**，所以它不能用来判非法；
        // 这里显式要求命中四种真实签名之一，否则「改名 HTML」能一路混到解码那步。
        val mime = sniffedSupportedMagic(bytes)
            ?: return Outcome.Rejected("文件魔数不是受支持的图片格式（PNG/JPEG/WebP/GIF）")

        // 只读边界的解码：拿到尺寸即可，避免为一张注定被拒的图分配位图内存。
        val info = decoder.probe(bytes)
            ?: return Outcome.Rejected("图片无法解码（扩展名或数据已损坏）")
        if (info.width > limits.maxPixelWidth || info.height > limits.maxPixelHeight) {
            return Outcome.Rejected("图片尺寸 ${info.width}x${info.height} 超过 ${limits.maxPixelWidth}x${limits.maxPixelHeight}")
        }
        if (info.width.toLong() * info.height.toLong() > limits.maxPixelCount) {
            return Outcome.Rejected("图片像素数过大（${info.width}x${info.height}）")
        }
        if (batchBytes + bytes.size > limits.maxTotalBytesPerBatch) {
            return Outcome.Rejected("本批媒体总量将超过 ${limits.maxTotalBytesPerBatch / 1024 / 1024} MiB")
        }

        val digest = sha256(bytes)
        val folder = File(mediaRoot, kind).apply { mkdirs() }
        val target = File(folder, "$digest.${extensionOf(mime)}")
        val reused = target.exists()
        if (!reused) {
            // 先写 .tmp 再 rename：崩溃不会留下半个头像文件被当成有效引用。
            val temp = File(folder, "${digest}.tmp")
            runCatching { temp.writeBytes(bytes) }
                .onFailure { return Outcome.Rejected("写入失败：${it.message ?: "磁盘不可用"}") }
            if (!temp.renameTo(target)) {
                temp.delete()
                return Outcome.Rejected("写入失败：无法完成文件替换")
            }
        }
        batchBytes += bytes.size
        batchFiles += 1
        return Outcome.Accepted(relPath = "$kind/${target.name}", bytes = bytes.size.toLong(), reused = reused)
    }

    /** 读取已落盘的媒体；越权路径一律返回 null（引用来自数据库，仍不信任它）。 */
    fun read(relPath: String?): ByteArray? {
        if (relPath.isNullOrBlank()) return null
        val normalized = relPath.replace('\\', '/')
        if (normalized.contains("..") || normalized.startsWith("/")) return null
        val file = File(mediaRoot, normalized)
        val canonicalRoot = runCatching { mediaRoot.canonicalFile.path + File.separator }.getOrNull() ?: return null
        val canonicalFile = runCatching { file.canonicalFile }.getOrNull() ?: return null
        if (!canonicalFile.path.startsWith(canonicalRoot)) return null
        return if (canonicalFile.isFile) runCatching { canonicalFile.readBytes() }.getOrNull() else null
    }

    /** 删除引用不再需要的媒体（角色删除/换头像后调用）。 */
    fun delete(relPath: String?) {
        val bytes = relPath ?: return
        val normalized = bytes.replace('\\', '/')
        if (normalized.contains("..") || normalized.startsWith("/")) return
        runCatching { File(mediaRoot, normalized).takeIf { it.isFile }?.delete() }
    }

    /** 解码出位图供裁剪 UI 使用；失败返回 null 由 UI 显示明确错误。 */
    fun decodeBitmap(bytes: ByteArray): Bitmap? = decoder.decode(bytes)

    /**
     * 只认四种真实图片签名；不匹配返回 null。
     *
     * 故意不复用 `PngTextChunks.detectMimeType` 的返回值做判定：它对未知输入回落到
     * `image/png`（那是与 PC 对齐、供角色卡导出用的行为），拿它当白名单等于不设闸——
     * 一份改名叫 `.png` 的 HTML 会一路混到解码那步。
     */
    private fun sniffedSupportedMagic(bytes: ByteArray): String? = when {
        bytes.startsInto(PNG_SIGNATURE) -> "image/png"
        bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte() -> "image/jpeg"
        bytes.size >= 12 && bytes.startsInto(RIFF, 0) && bytes.startsInto(WEBP, 8) -> "image/webp"
        bytes.size >= 6 && bytes.startsInto(GIF, 0) -> "image/gif"
        else -> null
    }

    private fun ByteArray.startsInto(prefix: ByteArray, at: Int = 0): Boolean {
        if (size < at + prefix.size) return false
        return prefix.indices.all { this[at + it] == prefix[it] }
    }

    private fun extensionOf(mime: String): String = when (mime) {
        "image/png" -> "png"
        "image/jpeg" -> "jpg"
        "image/gif" -> "gif"
        "image/webp" -> "webp"
        else -> "bin"
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** 解码抽象：让「先验证再落盘」这条规则能在纯 JVM 测试里跑。 */
    interface Decoder {
        fun probe(bytes: ByteArray): ImageInfo?
        fun decode(bytes: ByteArray): Bitmap?
    }

    companion object {
        val ALLOWED_KINDS = setOf("character-avatar", "character-background", "character-cover", "persona-avatar")

        private val PNG_SIGNATURE = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        )
        private val RIFF = "RIFF".toByteArray(Charsets.US_ASCII)
        private val WEBP = "WEBP".toByteArray(Charsets.US_ASCII)
        private val GIF = "GIF8".toByteArray(Charsets.US_ASCII)
    }
}

/** 生产实现：用 `BitmapFactory` 的两段式解码（先边界后位图）。 */
private object AndroidBitmapDecoder : MediaImportGate.Decoder {
    override fun probe(bytes: ByteArray): MediaImportGate.ImageInfo? {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        val width = options.outWidth
        val height = options.outHeight
        if (width <= 0 || height <= 0) return null
        val mime = PngTextChunks.detectMimeType(bytes)
        return MediaImportGate.ImageInfo(width = width, height = height, mimeType = mime)
    }

    override fun decode(bytes: ByteArray): Bitmap? =
        runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull()
}
