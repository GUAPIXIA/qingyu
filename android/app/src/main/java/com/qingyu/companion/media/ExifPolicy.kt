package com.qingyu.companion.media

import java.io.ByteArrayOutputStream

/**
 * 阶段 6 S6-02：EXIF/元数据处理。
 *
 * S6-02 原文：「EXIF 默认剥离；如保留方向，解码后重编码」。落地为两种模式：
 *
 * - [ExifHandling.STRIP_METADATA]（默认）：**字节级无损剥离**元数据段（EXIF/XMP/GPS/
 *   IPTC/PNG 文本块/GIF 注释…），像素数据原样保留。默认走这条的原因是重编码必有画质损失，
 *   而「剥离」本身就能消掉隐私泄露面（GPS 坐标、设备序列号、拍摄时间）。
 * - [ExifHandling.KEEP_ORIENTATION_THEN_REENCODE]：保留「方向」这一项语义（不是保留 EXIF）。
 *   做法是按 EXIF Orientation 把旋转/镜像**烘焙进像素**后再重新编码——重编码产物天然没有
 *   任何元数据，所以「保留方向」与「剥离 EXIF」同时成立。绝不允许「留着 Orientation 标签
 *   了事」：那等于把 EXIF 重新放回去。
 *
 * 剥离白名单是保守的：JPEG 只保留 JFIF(APP0)、ICC(APP2)、Adobe(APP14) 三个**功能性**段，
 * 其余 APPn/COM 全部丢弃；PNG 丢 tEXt/zTXt/iTXt/eXIf；GIF 丢注释与非 NETSCAPE 应用扩展
 * （NETSCAPE 是循环播放控制，属功能性）；WebP 丢 EXIF/XMP 块。
 */
enum class ExifHandling {
    STRIP_METADATA,
    KEEP_ORIENTATION_THEN_REENCODE,
}

/**
 * EXIF Orientation 的执行语义：**先水平镜像（如需要），再顺时针旋转 [rotationDegrees]°**。
 *
 * 用「旋转 + 单一镜像轴」表达全部 8 个方向值，避免每个消费方各自发明矩阵约定。
 */
data class OrientationTransform(
    val rotationDegrees: Int,
    val flipHorizontal: Boolean,
) {
    val isIdentity: Boolean get() = rotationDegrees == 0 && !flipHorizontal
}

object ExifOrientation {
    /** EXIF Orientation(0x0112) 1..8 → 变换；越界返回 null（调用方按「不保留方向」处理）。 */
    fun transformOf(orientation: Int): OrientationTransform? = when (orientation) {
        1 -> OrientationTransform(0, false) // 正常
        2 -> OrientationTransform(0, true) // 水平镜像
        3 -> OrientationTransform(180, false) // 旋转 180
        4 -> OrientationTransform(180, true) // 垂直镜像 = 水平镜像 + 旋转 180
        5 -> OrientationTransform(270, true) // 转置 = 水平镜像 + 顺时针 270
        6 -> OrientationTransform(90, false) // 顺时针 90（手机竖拍最常见的值）
        7 -> OrientationTransform(90, true) // 横向转置 = 水平镜像 + 顺时针 90
        8 -> OrientationTransform(270, false) // 顺时针 270
        else -> null
    }
}

/** 从 JPEG APP1(Exif) / WebP EXIF 块读取 Orientation 标签（纯字节解析，无 Android 依赖）。 */
object ExifOrientationReader {
    /** 按魔数分派；PNG/GIF 无方向概念返回 null。 */
    fun readOrientation(bytes: ByteArray): Int? = when (MagicBytes.detectImageMime(bytes)) {
        MagicBytes.MIME_JPEG -> readJpegOrientation(bytes)
        MagicBytes.MIME_WEBP -> readWebpOrientation(bytes)
        else -> null
    }

    fun readJpegOrientation(bytes: ByteArray): Int? {
        if (bytes.size < 4 || bytes[0] != 0xff.toByte() || bytes[1] != 0xd8.toByte()) return null
        var pos = 2
        while (pos + 4 <= bytes.size) {
            if (bytes[pos] != 0xff.toByte()) return null
            var markerAt = pos + 1
            while (markerAt < bytes.size && bytes[markerAt] == 0xff.toByte()) markerAt++
            if (markerAt >= bytes.size) return null
            val marker = bytes[markerAt].toInt() and 0xFF
            if (marker == 0xda || marker == 0xd9) return null // 到 SOS/EOI 还没见到 EXIF
            if (marker in 0xd0..0xd7 || marker == 0x01) {
                pos = markerAt + 1
                continue
            }
            val segStart = markerAt + 1
            val segLen = Binary.u16be(bytes, segStart) ?: return null
            if (segLen < 2 || segStart + segLen > bytes.size) return null
            if (marker == 0xe1) {
                val payload = Binary.bytesAt(bytes, segStart + 2, segLen - 2) ?: return null
                parseExifApp1(payload)?.let { return it }
            }
            pos = segStart + segLen
        }
        return null
    }

    /** WebP 的方向标签在 EXIF 块里（XMP 块不含 Orientation）。 */
    internal fun readWebpOrientation(bytes: ByteArray): Int? {
        if (bytes.size < 16) return null
        var pos = 12
        while (pos + 8 <= bytes.size) {
            val fourCc = Binary.ascii(bytes, pos, 4) ?: return null
            val chunkSize = Binary.u32le(bytes, pos + 4) ?: return null
            val payloadStart = pos + 8
            if (payloadStart + chunkSize > bytes.size) return null
            if (fourCc == "EXIF") {
                val payload = Binary.bytesAt(bytes, payloadStart, chunkSize.toInt()) ?: return null
                val tiffAt = if (payload.startsExifPrefix()) 6 else 0
                return parseTiffOrientation(payload, tiffAt)
            }
            pos = (payloadStart + chunkSize + (chunkSize and 1L)).toInt()
        }
        return null
    }

    /** APP1 载荷以 `Exif\0\0` 开头时解析 TIFF IFD0 的 Orientation(0x0112)。 */
    internal fun parseExifApp1(payload: ByteArray): Int? {
        if (!payload.startsExifPrefix()) return null
        return parseTiffOrientation(payload, 6)
    }

    private fun ByteArray.startsExifPrefix(): Boolean =
        size >= 6 && this[0] == 'E'.code.toByte() && this[1] == 'x'.code.toByte() &&
            this[2] == 'i'.code.toByte() && this[3] == 'f'.code.toByte() &&
            this[4] == 0.toByte() && this[5] == 0.toByte()

    /** TIFF IFD0 的 Orientation(0x0112)；[tiff] 是 TIFF 头（II/MM 字节序标记）偏移。 */
    internal fun parseTiffOrientation(payload: ByteArray, tiff: Int): Int? {
        if (tiff < 0 || payload.size < tiff + 14) return null
        val bigEndian = when {
            payload[tiff] == 'M'.code.toByte() && payload[tiff + 1] == 'M'.code.toByte() -> true
            payload[tiff] == 'I'.code.toByte() && payload[tiff + 1] == 'I'.code.toByte() -> false
            else -> return null
        }
        fun u16(at: Int): Int? = if (bigEndian) Binary.u16be(payload, at) else Binary.u16le(payload, at)
        fun u32(at: Int): Long? = if (bigEndian) Binary.u32be(payload, at) else Binary.u32le(payload, at)
        if (u16(tiff + 2) != 42) return null
        val ifd0 = (u32(tiff + 4) ?: return null).toInt()
        val dir = tiff + ifd0
        val count = u16(dir) ?: return null
        for (i in 0 until count) {
            val entry = dir + 2 + i * 12
            val tag = u16(entry) ?: return null
            if (tag != 0x0112) continue
            val type = u16(entry + 2) ?: return null
            if (type != 3) return null // SHORT
            val value = u16(entry + 8) ?: return null // SHORT 值内联在 value/offset 前 2 字节
            return value.takeIf { it in 1..8 }
        }
        return null
    }
}

/**
 * 元数据剥离器（纯字节级，不重编码）。
 *
 * 返回 null 表示输入结构异常（不许「剥不动就原样放行」——那等于把 GPS 留在了库里）。
 * 正常输入永远返回新字节数组；调用方（`AttachmentIngestService`）对 null 拒绝写入。
 */
object MetadataStripper {
    fun strip(bytes: ByteArray, mime: String): ByteArray? = when (mime) {
        MagicBytes.MIME_JPEG -> stripJpeg(bytes)
        MagicBytes.MIME_PNG -> stripPng(bytes)
        MagicBytes.MIME_GIF -> stripGif(bytes)
        MagicBytes.MIME_WEBP -> stripWebp(bytes)
        else -> null
    }

    // ---------------------------------------------------------------- JPEG

    /** 保留的 APPn 段：APP0(JFIF)、APP2(ICC 配置)、APP14(Adobe 颜色变换) —— 都是功能性的。 */
    private val JPEG_KEEP_MARKERS = setOf(0xe0, 0xe2, 0xee)

    internal fun stripJpeg(bytes: ByteArray): ByteArray? {
        if (bytes.size < 4) return null
        val out = ByteArrayOutputStream(bytes.size)
        out.write(bytes, 0, 2) // SOI
        var pos = 2
        while (pos < bytes.size) {
            if (bytes[pos] != 0xff.toByte()) return null
            var markerAt = pos + 1
            while (markerAt < bytes.size && bytes[markerAt] == 0xff.toByte()) markerAt++
            if (markerAt >= bytes.size) return null
            val marker = bytes[markerAt].toInt() and 0xFF
            if (marker == 0xda) {
                // SOS 起是熵编码数据（含 EOI）：整体保留，其中不会再有可剥离的元数据段
                out.write(bytes, pos, bytes.size - pos)
                return out.toByteArray()
            }
            if (marker == 0xd8 || marker == 0xd9 || marker in 0xd0..0xd7 || marker == 0x01) {
                // 无长度段（SOI/EOI/RSTn/TEM）：原样保留
                out.write(0xff)
                out.write(marker)
                pos = markerAt + 1
                continue
            }
            val segStart = markerAt + 1
            val segLen = Binary.u16be(bytes, segStart) ?: return null
            if (segLen < 2 || segStart + segLen > bytes.size) return null
            val keep = marker in JPEG_KEEP_MARKERS
            if (keep) {
                out.write(bytes, pos, segStart + segLen - pos)
            }
            pos = segStart + segLen
        }
        return out.toByteArray()
    }

    // ---------------------------------------------------------------- PNG

    /** PNG 里的元数据块：文本(tEXt/zTXt/iTXt) 与 eXIf；其余（含 tRNS/pHYs 等功能性块）保留。 */
    private val PNG_METADATA_CHUNKS = setOf("tEXt", "zTXt", "iTXt", "eXIf")

    internal fun stripPng(bytes: ByteArray): ByteArray? {
        if (bytes.size < 8 + 12) return null
        val out = ByteArrayOutputStream(bytes.size)
        out.write(bytes, 0, 8) // 签名
        var pos = 8
        while (pos + 8 <= bytes.size) {
            val length = Binary.u32be(bytes, pos) ?: return null
            val total = 12 + length
            if (pos + total > bytes.size) return null
            val type = Binary.ascii(bytes, pos + 4, 4) ?: return null
            if (type !in PNG_METADATA_CHUNKS) {
                out.write(bytes, pos, total.toInt())
            }
            pos += total.toInt()
        }
        return out.toByteArray()
    }

    // ---------------------------------------------------------------- GIF

    internal fun stripGif(bytes: ByteArray): ByteArray? {
        if (bytes.size < 14) return null
        val packed = bytes[10].toInt() and 0xFF
        var pos = 13
        if (packed and 0x80 != 0) pos += 3 * (1 shl ((packed and 0x07) + 1))
        val out = ByteArrayOutputStream(bytes.size)
        out.write(bytes, 0, pos) // 头 + 逻辑屏幕描述符 + 全局色表
        while (true) {
            if (pos >= bytes.size) return null
            when (bytes[pos].toInt() and 0xFF) {
                0x3b -> {
                    out.write(0x3b)
                    return out.toByteArray()
                }
                0x21 -> {
                    if (pos + 2 > bytes.size) return null
                    val label = bytes[pos + 1].toInt() and 0xFF
                    val end = ImageInspector.skipSubBlocks(bytes, pos + 2) ?: return null
                    val keep = when (label) {
                        0xfe -> false // 注释扩展：元数据
                        0xff -> netscapeApplicationExtension(bytes, pos + 2) // 只留 NETSCAPE 循环控制
                        else -> true // 图形控制/纯文本扩展是渲染语义，保留
                    }
                    if (keep) out.write(bytes, pos, end - pos)
                    pos = end
                }
                0x2c -> {
                    // 图像块整块保留（像素数据）
                    if (pos + 10 > bytes.size) return null
                    val localPacked = bytes[pos + 9].toInt() and 0xFF
                    var cursor = pos + 10
                    if (localPacked and 0x80 != 0) cursor += 3 * (1 shl ((localPacked and 0x07) + 1))
                    cursor += 1
                    val end = ImageInspector.skipSubBlocks(bytes, cursor) ?: return null
                    out.write(bytes, pos, end - pos)
                    pos = end
                }
                else -> return null
            }
        }
    }

    /** 应用扩展的首个子块是 11 字节标识码；NETSCAPE2.0/ANIMEXTS1.0 是动画循环控制（功能性）。 */
    private fun netscapeApplicationExtension(bytes: ByteArray, subBlockAt: Int): Boolean {
        val len = Binary.u8(bytes, subBlockAt) ?: return false
        if (len < 11) return false
        val id = Binary.bytesAt(bytes, subBlockAt + 1, 11) ?: return false
        val text = String(id, Charsets.US_ASCII)
        return text.startsWith("NETSCAPE2.0") || text.startsWith("ANIMEXTS1.0")
    }

    // ---------------------------------------------------------------- WebP

    /** WebP 的元数据块四字符码：EXIF、XMP（含尾随空格）。 */
    private val WEBP_METADATA_CHUNKS = setOf("EXIF", "XMP ")

    internal fun stripWebp(bytes: ByteArray): ByteArray? {
        if (bytes.size < 16) return null
        val payload = ByteArrayOutputStream(bytes.size)
        var pos = 12
        while (pos + 8 <= bytes.size) {
            val fourCc = Binary.ascii(bytes, pos, 4) ?: return null
            val chunkSize = Binary.u32le(bytes, pos + 4) ?: return null
            val total = 8 + chunkSize + (chunkSize and 1L) // 含对齐填充字节
            if (pos + total > bytes.size) return null
            if (fourCc !in WEBP_METADATA_CHUNKS) {
                Binary.bytesAt(bytes, pos, total.toInt())?.let { payload.write(it) }
            }
            pos += total.toInt()
        }
        val body = payload.toByteArray()
        val out = ByteArrayOutputStream(body.size + 12)
        out.write("RIFF".toByteArray(Charsets.US_ASCII))
        writeU32le(out, (body.size + 4).toLong())
        out.write("WEBP".toByteArray(Charsets.US_ASCII))
        out.write(body)
        return out.toByteArray()
    }

    private fun writeU32le(out: ByteArrayOutputStream, value: Long) {
        out.write((value and 0xFF).toInt())
        out.write(((value shr 8) and 0xFF).toInt())
        out.write(((value shr 16) and 0xFF).toInt())
        out.write(((value shr 24) and 0xFF).toInt())
    }
}
