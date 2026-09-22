package com.qingyu.companion.media

/**
 * 小端/大端字节读写工具（纯 JVM，无 Android 依赖）。
 *
 * 图片头解析、EXIF 定向标签、RIFF/GIF 块走查都要按字节序读整数；
 * 各自内联一份 `((a.toInt() and 0xFF) shl 8) or …` 是本仓历史上的出错大户，
 * 所以收敛到一处并统一「越界返回 null」的语义（解析器对损坏输入只能拒，不能抛）。
 */
object Binary {
    fun u8(bytes: ByteArray, at: Int): Int? =
        if (at in bytes.indices) bytes[at].toInt() and 0xFF else null

    fun u16be(bytes: ByteArray, at: Int): Int? {
        if (at < 0 || at + 2 > bytes.size) return null
        return ((bytes[at].toInt() and 0xFF) shl 8) or (bytes[at + 1].toInt() and 0xFF)
    }

    fun u16le(bytes: ByteArray, at: Int): Int? {
        if (at < 0 || at + 2 > bytes.size) return null
        return ((bytes[at + 1].toInt() and 0xFF) shl 8) or (bytes[at].toInt() and 0xFF)
    }

    /** 32 位无符号以 Long 返回（Int 会把 0x80000000 变负数，块长度判断会全错）。 */
    fun u32be(bytes: ByteArray, at: Int): Long? {
        if (at < 0 || at + 4 > bytes.size) return null
        return ((bytes[at].toLong() and 0xFF) shl 24) or
            ((bytes[at + 1].toLong() and 0xFF) shl 16) or
            ((bytes[at + 2].toLong() and 0xFF) shl 8) or
            (bytes[at + 3].toLong() and 0xFF)
    }

    fun u32le(bytes: ByteArray, at: Int): Long? {
        if (at < 0 || at + 4 > bytes.size) return null
        return ((bytes[at + 3].toLong() and 0xFF) shl 24) or
            ((bytes[at + 2].toLong() and 0xFF) shl 16) or
            ((bytes[at + 1].toLong() and 0xFF) shl 8) or
            (bytes[at].toLong() and 0xFF)
    }

    fun u24le(bytes: ByteArray, at: Int): Long? {
        if (at < 0 || at + 3 > bytes.size) return null
        return ((bytes[at + 2].toLong() and 0xFF) shl 16) or
            ((bytes[at + 1].toLong() and 0xFF) shl 8) or
            (bytes[at].toLong() and 0xFF)
    }

    fun ascii(bytes: ByteArray, at: Int, length: Int): String? {
        if (at < 0 || at + length > bytes.size) return null
        return String(bytes, at, length, Charsets.US_ASCII)
    }

    fun bytesAt(bytes: ByteArray, at: Int, length: Int): ByteArray? {
        if (at < 0 || length < 0 || at + length > bytes.size) return null
        return bytes.copyOfRange(at, at + length)
    }
}
