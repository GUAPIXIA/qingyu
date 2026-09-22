package com.qingyu.companion.media

import java.util.zip.CRC32

/**
 * 阶段 6 S6-02：图片**结构级**检查（纯逻辑，无 Android 依赖）。
 *
 * 一次走查同时拿两样东西：
 * 1. **真实尺寸**（不分配位图）——解压炸弹「文件几十 KB、解出 3 万 ×3 万像素」必须在
 *    解码之前就按尺寸上限拦掉，否则内存先炸；
 * 2. **结构完整性**——截断/损坏的输入必须在写盘前被拒（S6-02 §3 测试矩阵明文要求）。
 *
 * 与 [MediaImportGate] 的关系：那里靠 `BitmapFactory.inJustDecodeBounds` 探尺寸，
 * 依赖 Android 解码器；这里是**格式级**走查（块长度、必需块、结束标记），既能在纯 JVM
 * 测试里钉住行为，也作为解码前的第一道闸（两道都过才写盘，见 `AttachmentIngestService`）。
 *
 * 刻意的严格点（宁可误杀也不放过）：
 * - PNG 必须以 IEND 精确收尾、IHDR CRC 必须对得上；尾部挂数据视为篡改；
 * - JPEG 必须以 EOI（FFD9）收尾，段长度越界即「截断」；
 * - WebP 的 RIFF 长度必须与文件长度一致；
 * - GIF 必须以 trailer（0x3B）收尾并能完整走完所有块。
 */
sealed interface ImageInspection {
    /** 结构合法：[mime] 为魔数判出的真值，[width]/[height] 为文件头声明的真实像素尺寸。 */
    data class Header(val mime: String, val width: Int, val height: Int) : ImageInspection

    /** 结构非法：[reason] 是给用户看的中文原因。 */
    data class Rejected(val reason: String) : ImageInspection
}

object ImageInspector {
    fun inspect(bytes: ByteArray): ImageInspection {
        val mime = MagicBytes.detectImageMime(bytes)
            ?: return ImageInspection.Rejected("文件魔数不是受支持的图片格式（PNG/JPEG/WebP/GIF）")
        return when (mime) {
            MagicBytes.MIME_PNG -> parsePng(bytes)
            MagicBytes.MIME_JPEG -> parseJpeg(bytes)
            MagicBytes.MIME_GIF -> parseGif(bytes)
            MagicBytes.MIME_WEBP -> parseWebp(bytes)
            else -> ImageInspection.Rejected("不支持的图片格式：$mime")
        }
    }

    // ---------------------------------------------------------------- PNG

    private fun parsePng(bytes: ByteArray): ImageInspection {
        if (bytes.size < 8 + 25) return ImageInspection.Rejected("PNG 头部被截断（文件损坏）")
        var pos = 8
        var width = 0
        var height = 0
        var sawIhdr = false
        var sawIdat = false
        var sawIend = false
        while (pos + 8 <= bytes.size) {
            val length = Binary.u32be(bytes, pos) ?: break
            val dataStart = pos + 8
            // 块 = 4 长度 + 4 类型 + 数据 + 4 CRC；长度越界就是截断/损坏
            if (length > bytes.size - dataStart - 4) {
                return ImageInspection.Rejected("PNG 块长度越界（文件被截断或损坏）")
            }
            val type = Binary.ascii(bytes, pos + 4, 4)
                ?: return ImageInspection.Rejected("PNG 块类型读取失败（文件被截断）")
            if (!type.all { it in 'A'..'Z' || it in 'a'..'z' }) {
                return ImageInspection.Rejected("PNG 块类型非法（文件损坏）")
            }
            when {
                !sawIhdr -> {
                    if (type != "IHDR" || length != 13L) {
                        return ImageInspection.Rejected("PNG 缺少合法 IHDR 块（文件损坏）")
                    }
                    if (!pngChunkCrcOk(bytes, pos, length)) {
                        return ImageInspection.Rejected("PNG IHDR 校验失败（文件头损坏）")
                    }
                    val w = Binary.u32be(bytes, dataStart) ?: 0
                    val h = Binary.u32be(bytes, dataStart + 4) ?: 0
                    if (w <= 0 || h <= 0 || w > Int.MAX_VALUE || h > Int.MAX_VALUE) {
                        return ImageInspection.Rejected("PNG 尺寸非法（$w x $h）")
                    }
                    width = w.toInt()
                    height = h.toInt()
                    sawIhdr = true
                }
                type == "IDAT" -> sawIdat = true
                type == "IEND" -> {
                    if (length != 0L) return ImageInspection.Rejected("PNG IEND 块非法（文件损坏）")
                    if (pos + 12 != bytes.size) {
                        return ImageInspection.Rejected("PNG 尾部存在多余数据（可能被篡改）")
                    }
                    sawIend = true
                }
            }
            pos = dataStart + length.toInt() + 4
            if (sawIend) break
        }
        if (!sawIhdr || !sawIdat || !sawIend) {
            return ImageInspection.Rejected("PNG 缺少必需块（文件被截断或损坏）")
        }
        return header(MagicBytes.MIME_PNG, width, height)
    }

    internal fun pngChunkCrcOk(bytes: ByteArray, chunkStart: Int, length: Long): Boolean {
        val crcOffset = chunkStart + 8 + length.toInt()
        val expected = Binary.u32be(bytes, crcOffset) ?: return false
        val crc = CRC32()
        crc.update(bytes, chunkStart + 4, 4 + length.toInt())
        return crc.value == expected
    }

    // ---------------------------------------------------------------- JPEG

    private val SOF_MARKERS = setOf(0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf)

    private fun parseJpeg(bytes: ByteArray): ImageInspection {
        var pos = 2
        var width = 0
        var height = 0
        var sawSof = false
        while (pos < bytes.size) {
            if (bytes[pos] != 0xff.toByte()) {
                return ImageInspection.Rejected("JPEG 段标记损坏（文件损坏）")
            }
            var markerAt = pos + 1
            while (markerAt < bytes.size && bytes[markerAt] == 0xff.toByte()) markerAt++
            if (markerAt >= bytes.size) return ImageInspection.Rejected("JPEG 被截断（段标记未闭合）")
            val marker = bytes[markerAt].toInt() and 0xFF
            when {
                marker == 0xd8 -> pos = markerAt + 1 // 游离 SOI：跳过
                marker in 0xd0..0xd7 || marker == 0x01 -> pos = markerAt + 1 // 无长度段
                marker == 0xd9 -> {
                    // SOS 之前出现 EOI：没有图像数据
                    return ImageInspection.Rejected("JPEG 缺少图像数据（文件损坏）")
                }
                marker == 0xda -> {
                    // SOS：其后是熵编码数据直到文件末尾的 EOI
                    if (!sawSof) return ImageInspection.Rejected("JPEG 缺少 SOF 尺寸段（文件损坏）")
                    val segStart = markerAt + 1
                    val segLen = Binary.u16be(bytes, segStart)
                        ?: return ImageInspection.Rejected("JPEG 被截断（SOS 段缺失）")
                    if (segLen < 2 || segStart + segLen > bytes.size) {
                        return ImageInspection.Rejected("JPEG 段长度越界（文件被截断或损坏）")
                    }
                    if (bytes.size < 4 || bytes[bytes.size - 2] != 0xff.toByte() ||
                        bytes[bytes.size - 1] != 0xd9.toByte()
                    ) {
                        return ImageInspection.Rejected("JPEG 被截断（缺少结束标记 EOI）")
                    }
                    return header(MagicBytes.MIME_JPEG, width, height)
                }
                else -> {
                    val segStart = markerAt + 1
                    val segLen = Binary.u16be(bytes, segStart)
                        ?: return ImageInspection.Rejected("JPEG 被截断（段长度缺失）")
                    if (segLen < 2 || segStart + segLen > bytes.size) {
                        return ImageInspection.Rejected("JPEG 段长度越界（文件被截断或损坏）")
                    }
                    if (marker in SOF_MARKERS && !sawSof) {
                        // SOF 载荷：精度 1 字节、高 2 字节、宽 2 字节
                        if (segLen < 8) return ImageInspection.Rejected("JPEG SOF 尺寸段非法（文件损坏）")
                        val h = Binary.u16be(bytes, segStart + 3) ?: 0
                        val w = Binary.u16be(bytes, segStart + 5) ?: 0
                        if (w <= 0 || h <= 0) return ImageInspection.Rejected("JPEG 尺寸非法（${w}x$h）")
                        width = w
                        height = h
                        sawSof = true
                    }
                    pos = segStart + segLen
                }
            }
        }
        return ImageInspection.Rejected("JPEG 被截断（缺少 SOS/EOI）")
    }

    // ---------------------------------------------------------------- GIF

    private fun parseGif(bytes: ByteArray): ImageInspection {
        if (bytes.size < 14) return ImageInspection.Rejected("GIF 头部被截断（文件损坏）")
        val width = Binary.u16le(bytes, 6) ?: 0
        val height = Binary.u16le(bytes, 8) ?: 0
        if (width <= 0 || height <= 0) return ImageInspection.Rejected("GIF 尺寸非法（${width}x$height）")
        val packed = bytes[10].toInt() and 0xFF
        var pos = 13
        if (packed and 0x80 != 0) pos += 3 * (1 shl ((packed and 0x07) + 1)) // 全局色表
        var sawImage = false
        var blocks = 0
        while (true) {
            if (pos >= bytes.size) return ImageInspection.Rejected("GIF 被截断（缺少结束块）")
            if (blocks++ > 100_000) return ImageInspection.Rejected("GIF 块数量异常（文件损坏）")
            when (bytes[pos].toInt() and 0xFF) {
                0x3b -> {
                    if (pos + 1 != bytes.size) {
                        return ImageInspection.Rejected("GIF 尾部存在多余数据（可能被篡改）")
                    }
                    if (!sawImage) return ImageInspection.Rejected("GIF 不含图像块（文件损坏）")
                    return header(MagicBytes.MIME_GIF, width, height)
                }
                0x21 -> {
                    // 扩展块：引导 + 标签 + 若干子块，0 长度子块收尾
                    if (pos + 2 > bytes.size) return ImageInspection.Rejected("GIF 被截断（扩展块不完整）")
                    pos = skipSubBlocks(bytes, pos + 2)
                        ?: return ImageInspection.Rejected("GIF 被截断（扩展块不完整）")
                }
                0x2c -> {
                    // 图像描述符 9 字节 + 可选局部色表 + LZW 最小码长 + 子块链
                    if (pos + 10 > bytes.size) return ImageInspection.Rejected("GIF 被截断（图像块不完整）")
                    val localPacked = bytes[pos + 9].toInt() and 0xFF
                    var cursor = pos + 10
                    if (localPacked and 0x80 != 0) cursor += 3 * (1 shl ((localPacked and 0x07) + 1))
                    cursor += 1 // LZW 最小码长
                    pos = skipSubBlocks(bytes, cursor)
                        ?: return ImageInspection.Rejected("GIF 被截断（图像数据不完整）")
                    sawImage = true
                }
                else -> return ImageInspection.Rejected("GIF 块标记非法（文件损坏）")
            }
        }
    }

    /** 子块链：`u8 长度 + 数据` 直到 0 长度；越界返回 null。 */
    internal fun skipSubBlocks(bytes: ByteArray, from: Int): Int? {
        var pos = from
        while (true) {
            val len = Binary.u8(bytes, pos) ?: return null
            pos += 1
            if (len == 0) return pos
            if (pos + len > bytes.size) return null
            pos += len
        }
    }

    // ---------------------------------------------------------------- WebP

    private fun parseWebp(bytes: ByteArray): ImageInspection {
        if (bytes.size < 16) return ImageInspection.Rejected("WebP 头部被截断（文件损坏）")
        val riffSize = Binary.u32le(bytes, 4) ?: return ImageInspection.Rejected("WebP 头部损坏")
        when {
            riffSize + 8 > bytes.size -> return ImageInspection.Rejected("WebP 被截断（RIFF 长度与文件长度不符）")
            riffSize + 8 < bytes.size -> return ImageInspection.Rejected("WebP 尾部存在多余数据（可能被篡改）")
        }
        var pos = 12
        var width = 0
        var height = 0
        while (pos + 8 <= bytes.size) {
            val fourCc = Binary.ascii(bytes, pos, 4)
                ?: return ImageInspection.Rejected("WebP 块头损坏")
            val chunkSize = Binary.u32le(bytes, pos + 4) ?: return ImageInspection.Rejected("WebP 块长度损坏")
            val payload = pos + 8
            if (payload + chunkSize > bytes.size) {
                return ImageInspection.Rejected("WebP 块越界（文件被截断或损坏）")
            }
            when (fourCc) {
                "VP8X" -> {
                    if (chunkSize < 10L) return ImageInspection.Rejected("WebP VP8X 块非法（文件损坏）")
                    width = ((Binary.u24le(bytes, payload + 4) ?: 0) + 1).toInt()
                    height = ((Binary.u24le(bytes, payload + 7) ?: 0) + 1).toInt()
                }
                "VP8 " -> {
                    // 有损帧头：3 字节帧标记 + 3 字节同步码 9D 01 2A + 宽 14bit + 高 14bit
                    if (chunkSize < 10L) return ImageInspection.Rejected("WebP VP8 块非法（文件损坏）")
                    if (bytes[payload + 3] != 0x9d.toByte() || bytes[payload + 4] != 0x01.toByte() ||
                        bytes[payload + 5] != 0x2a.toByte()
                    ) {
                        return ImageInspection.Rejected("WebP VP8 同步码错误（文件损坏）")
                    }
                    if (width == 0) {
                        width = (Binary.u16le(bytes, payload + 6) ?: 0) and 0x3fff
                        height = (Binary.u16le(bytes, payload + 8) ?: 0) and 0x3fff
                    }
                }
                "VP8L" -> {
                    // 无损头：1 字节签名 2F + 14bit 宽-1 + 14bit 高-1
                    if (chunkSize < 5L) return ImageInspection.Rejected("WebP VP8L 块非法（文件损坏）")
                    if (bytes[payload] != 0x2f.toByte()) {
                        return ImageInspection.Rejected("WebP VP8L 签名错误（文件损坏）")
                    }
                    if (width == 0) {
                        val bits = Binary.u32le(bytes, payload + 1) ?: 0
                        width = ((bits and 0x3fff) + 1).toInt()
                        height = (((bits shr 14) and 0x3fff) + 1).toInt()
                    }
                }
            }
            pos = (payload + chunkSize + (chunkSize and 1L)).toInt()
        }
        if (width <= 0 || height <= 0) {
            return ImageInspection.Rejected("WebP 缺少图像数据块（文件损坏）")
        }
        return header(MagicBytes.MIME_WEBP, width, height)
    }

    private fun header(mime: String, width: Int, height: Int): ImageInspection =
        if (width <= 0 || height <= 0) {
            ImageInspection.Rejected("图片尺寸非法（${width}x$height）")
        } else {
            ImageInspection.Header(mime = mime, width = width, height = height)
        }
}
