package com.qingyu.companion.content

import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.zip.CRC32

/**
 * 阶段 5 S5-01：PNG 文本段读写（角色卡把 JSON 以 base64 嵌在 `tEXt` 段里）。
 *
 * 与 `electron/services/charCardPng.ts` 行为对齐，但**读块改为按长度正向走**：
 * PC 的 `findIENDOffset` 从尾部倒序做字节搜索找 `IEND` 四个字节，压缩图像数据里
 * 恰好出现这四个字节时会把 chunk 插入到文件中间，产出一张打不开的 PNG。
 * 正向按 `length` 跳块只会停在真正的 `IEND`，且对同一份合法输入给出**相同的插入位置**，
 * 因此不影响与 PC 的往返一致性（共享 fixture 里对同一输入断言输出字节一致）。
 *
 * CRC 直接用 `java.util.zip.CRC32`：PNG 段校验就是标准 CRC-32(IEEE 802.3)，
 * 与 PC 手写的 256 项查表实现同一条多项式，无需复制一份表。
 */
object PngTextChunks {

    private val PNG_SIGNATURE = byteArrayOf(
        0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    )

    /** 1x1 透明 PNG，非 PNG 头像导出时的基底（与 PC 用的是同一段字节）。 */
    const val BLANK_PNG_BASE64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

    fun isPng(bytes: ByteArray): Boolean =
        bytes.size >= 8 && PNG_SIGNATURE.indices.all { bytes[it] == PNG_SIGNATURE[it] }

    /** 嗅探图片类型（与 PC `detectMimeType` 同一组魔数，默认 `image/png`）。 */
    fun detectMimeType(bytes: ByteArray): String = when {
        isPng(bytes) -> "image/png"
        bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte() -> "image/jpeg"
        bytes.size >= 4 && ascii(bytes, 0, 4) == "GIF8" -> "image/gif"
        bytes.size >= 12 && ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 12) == "WEBP" -> "image/webp"
        else -> "image/png"
    }

    /**
     * 按块遍历，返回依次遇到的 chunk 类型；一旦某段的长度字段与后续字节对不上，
     * 就把 `DESYNC` 追加进去并停止——结构自检和测试都用它。
     *
     * 为什么暴露出来：角色卡 PNG 的「能不能读回 chara」完全取决于 chunk 链是否自洽，
     * 而 PC 曾经用一个 IDAT 长度写错的 1x1 基底导出了读不回来的卡（见阶段 5 报告）。
     * 有一个可断言的形状，这类问题才不会只在运行时暴露。
     */
    fun chunkTypes(bytes: ByteArray): List<String> {
        if (!isPng(bytes)) return listOf("NOT_PNG")
        val types = ArrayList<String>()
        var offset = 8
        while (offset + 8 <= bytes.size) {
            val length = readUInt32BE(bytes, offset)
            val type = ascii(bytes, offset + 4, offset + 8)
            if (length < 0 || !type.all { it in 'A'..'z' }) {
                types += "DESYNC"
                return types
            }
            types += type
            val next = offset + 8 + length + 4
            if (next > bytes.size) {
                types += "DESYNC"
                return types
            }
            offset = next
            if (type == "IEND") break
        }
        return types
    }

    /**
     * 读取所有 `tEXt` / `iTXt` 文本段，键为 keyword。
     *
     * 损坏/截断的 PNG 返回**已解析到的部分**而不是抛异常：角色卡导入要能对
     * 「尾部被截断但仍含 chara 段」的社区卡给出结果或明确报错，不能在解析层崩。
     */
    fun read(bytes: ByteArray): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        if (!isPng(bytes)) return out
        var offset = 8
        while (offset + 8 <= bytes.size) {
            val length = readUInt32BE(bytes, offset)
            if (length < 0) break
            val type = ascii(bytes, offset + 4, offset + 8)
            val dataStart = offset + 8
            val dataEnd = dataStart + length
            if (dataEnd > bytes.size) break
            when (type) {
                "tEXt" -> readTextPair(bytes, dataStart, length)?.let { (k, v) -> out[k] = v }
                "iTXt" -> readITxtPair(bytes, dataStart, length)?.let { (k, v) -> out[k] = v }
                "IEND" -> return out
            }
            // 跳过 data + 4 字节 CRC
            offset = dataEnd + 4
        }
        return out
    }

    /**
     * 这张 PNG 里**带上了、但 [read] 没能取回来**的文本段清单（`zTXt`、压缩过的 `iTXt`、坏段）。
     *
     * 为什么要单独有这一个读数：导入报告的五类里有一类叫「近似映射」，而角色卡导入唯一的
     * 近似就是这些段——卡本身导入成功了，内容却比作者写的少。这件事原先只钉在 fixture
     * `itxt-compressed-skipped` 里（记录「PC 也读不到」，两端一致所以不算缺陷），
     * 界面上一个字都没有：用户分不清「这张卡本来就没写」和「写了但被我丢了」。
     *
     * 与 [read] 分开写、不改 [read] 的返回形状：`read` 的调用点多，报告只是旁路读数
     * （同 [PresetCodec.approximateNotes] 的取舍）。
     */
    fun unreadTextChunkKeys(bytes: ByteArray): List<String> {
        if (!isPng(bytes)) return emptyList()
        val taken = read(bytes)
        val out = ArrayList<String>()
        var offset = 8
        while (offset + 8 <= bytes.size) {
            val length = readUInt32BE(bytes, offset)
            if (length < 0) break
            val type = ascii(bytes, offset + 4, offset + 8)
            val dataStart = offset + 8
            val dataEnd = dataStart + length
            if (dataEnd > bytes.size) break
            when (type) {
                "tEXt", "iTXt", "zTXt" -> {
                    val key = keywordOf(bytes, dataStart, length)
                    if (key == null || !taken.containsKey(key)) out += "$type:${key ?: "<无可用关键字>"}"
                }
                "IEND" -> return out
            }
            offset = dataEnd + 4
        }
        return out
    }

    /**
     * 在 `IEND` 之前插入一个 `tEXt` 段。
     *
     * 找不到 `IEND` 时**原样返回**（PC 同行为）：宁可不嵌入，也不要产出一张结构损坏的图。
     */
    fun writeTextChunk(bytes: ByteArray, key: String, value: String): ByteArray {
        if (!isPng(bytes)) return bytes
        val iend = findIendOffset(bytes)
        if (iend < 0) return bytes
        val chunkData = ByteArrayOutputStream().apply {
            write(key.toByteArray(Charsets.US_ASCII))
            write(0)
            write(value.toByteArray(Charsets.UTF_8))
        }.toByteArray()
        val typeBytes = "tEXt".toByteArray(Charsets.US_ASCII)
        val crc = CRC32().apply { update(typeBytes); update(chunkData) }.value

        val out = ByteArrayOutputStream(bytes.size + chunkData.size + 16)
        out.write(bytes, 0, iend)
        writeUInt32BE(out, chunkData.size.toLong())
        out.write(typeBytes)
        out.write(chunkData)
        writeUInt32BE(out, crc)
        out.write(bytes, iend, bytes.size - iend)
        return out.toByteArray()
    }

    // ------------------------------------------------------------ 内部实现

    private fun findIendOffset(bytes: ByteArray): Int {
        if (!isPng(bytes)) return -1
        var offset = 8
        while (offset + 8 <= bytes.size) {
            val length = readUInt32BE(bytes, offset)
            if (length < 0) return -1
            val type = ascii(bytes, offset + 4, offset + 8)
            if (type == "IEND") return offset
            val next = offset + 8 + length + 4
            if (next <= offset || next > bytes.size) return -1
            offset = next
        }
        return -1
    }

    /** 段的 keyword（三种文本段都是 keyword\0 开头）；空关键字或找不到结束符返回 null。 */
    private fun keywordOf(bytes: ByteArray, start: Int, length: Int): String? {
        val nullIdx = indexOfZero(bytes, start, start + length) ?: return null
        if (nullIdx == start) return null
        return ascii(bytes, start, nullIdx)
    }

    /** `tEXt`：keyword\0 text。keyword 必须非空，与 PC 的 `nullIdx > 0` 一致。 */
    private fun readTextPair(bytes: ByteArray, start: Int, length: Int): Pair<String, String>? {
        val nullIdx = indexOfZero(bytes, start, start + length) ?: return null
        if (nullIdx == start) return null
        val key = ascii(bytes, start, nullIdx)
        val value = String(bytes, nullIdx + 1, start + length - nullIdx - 1, Charsets.UTF_8)
        return key to value
    }

    /**
     * `iTXt`：keyword\0 compression_flag compression_method language\0 translated_keyword\0 text。
     *
     * **压缩标志不影响这里读什么**：PC（oracle）从不解压，直接按 UTF-8 取 text 段，
     * fixture 的 `itxt-compressed-skipped` 用例记录了这一点。Android 若在此 `return null`，
     * 同一张卡在 PC 上能取到 `chara`、在 Android 上取不到——导入结果两端不一致，
     * 这比「两边都得到同一段乱码并按非法卡片报错」更难排查。
     * 所以这里与 PC 逐字节对齐，把「真压缩」当成两端共同的显式失败，而不是本机静默跳过。
     */
    private fun readITxtPair(bytes: ByteArray, start: Int, length: Int): Pair<String, String>? {
        val end = start + length
        val keywordEnd = indexOfZero(bytes, start, end) ?: return null
        if (keywordEnd == start) return null
        if (keywordEnd + 2 >= end) return null
        val languageEnd = indexOfZero(bytes, keywordEnd + 3, end) ?: return null
        val translatedEnd = indexOfZero(bytes, languageEnd + 1, end) ?: return null
        val textStart = translatedEnd + 1
        if (textStart >= end) return null
        val key = ascii(bytes, start, keywordEnd)
        val value = String(bytes, textStart, end - textStart, Charsets.UTF_8)
        return key to value
    }

    private fun indexOfZero(bytes: ByteArray, from: Int, until: Int): Int? {
        for (i in from until until) if (bytes[i] == 0.toByte()) return i
        return null
    }

    private fun ascii(bytes: ByteArray, from: Int, until: Int): String =
        String(bytes, from, until - from, Charsets.US_ASCII)

    /** 返回 0..Int.MAX_VALUE 范围内的长度，超界（>2GiB）视为损坏返回 -1。 */
    private fun readUInt32BE(bytes: ByteArray, offset: Int): Int {
        val value = ((bytes[offset].toLong() and 0xff) shl 24) or
            ((bytes[offset + 1].toLong() and 0xff) shl 16) or
            ((bytes[offset + 2].toLong() and 0xff) shl 8) or
            (bytes[offset + 3].toLong() and 0xff)
        return if (value > Int.MAX_VALUE) -1 else value.toInt()
    }

    private fun writeUInt32BE(out: OutputStream, value: Long) {
        out.write(((value shr 24) and 0xff).toInt())
        out.write(((value shr 16) and 0xff).toInt())
        out.write(((value shr 8) and 0xff).toInt())
        out.write((value and 0xff).toInt())
    }
}
