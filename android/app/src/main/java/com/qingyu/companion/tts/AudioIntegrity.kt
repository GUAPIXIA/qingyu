package com.qingyu.companion.tts

import java.io.File

/**
 * 损坏音频输入拦截（阶段 6 §3 矩阵「损坏音频……被拦截」）。
 *
 * 纯逻辑：魔数嗅探 + 大小边界，不依赖 Android。合成产物、缓存文件、下载落盘文件
 * 都必须先过这道闸门才能进入播放路径，避免把截断/乱码/伪音频喂给解码器。
 */
enum class AudioContainerFormat {
    MP3, WAV, OGG_OPUS, MP4_M4A, AAC_ADTS, FLAC,
}

sealed class AudioCheck {
    data class Ok(val format: AudioContainerFormat) : AudioCheck()

    data class Rejected(val reason: String) : AudioCheck()
}

object AudioIntegrity {

    /** 小于该长度必然是截断/占位文件（最短的合法 WAV 头也有 44 字节）。 */
    const val MIN_BYTES = 32L

    /** TTS 片段的合理上限；超限按异常输入拦截（低存储保护）。 */
    const val MAX_BYTES = 32L * 1024 * 1024

    private const val HEAD_BYTES = 64

    /** 校验音频头部 + 总大小。[head] 为文件起始字节（不足 64 可传实际读到的长度）。 */
    fun verify(head: ByteArray, totalSize: Long): AudioCheck {
        if (totalSize < MIN_BYTES) {
            return AudioCheck.Rejected("音频过小（$totalSize 字节），疑似损坏或截断")
        }
        if (totalSize > MAX_BYTES) {
            return AudioCheck.Rejected("音频超过大小上限（$MAX_BYTES 字节），拒绝接收")
        }
        if (head.size < 12) {
            return AudioCheck.Rejected("音频头部不完整（仅 ${head.size} 字节），疑似截断")
        }
        val format = sniff(head)
            ?: return AudioCheck.Rejected("无法识别的音频格式（魔数校验失败），已拦截")
        return AudioCheck.Ok(format)
    }

    /** 文件级校验（缓存入库 / 命中复核共用）。 */
    fun verifyFile(file: File): AudioCheck {
        if (!file.isFile) return AudioCheck.Rejected("音频文件不存在")
        val total = file.length()
        val head = file.inputStream().use { input ->
            val buf = ByteArray(HEAD_BYTES)
            var read = 0
            while (read < buf.size) {
                val n = input.read(buf, read, buf.size - read)
                if (n < 0) break
                read += n
            }
            buf.copyOf(read)
        }
        return verify(head, total)
    }

    /** 魔数嗅探：识别不了就返回 null（= 拒绝），不做「大概像 MP3」的猜测。 */
    fun sniff(head: ByteArray): AudioContainerFormat? {
        if (head.size < 12) return null
        when {
            tagAt(head, 0, "ID3") -> return AudioContainerFormat.MP3
            tagAt(head, 0, "RIFF") && tagAt(head, 8, "WAVE") -> return AudioContainerFormat.WAV
            tagAt(head, 0, "OggS") -> return AudioContainerFormat.OGG_OPUS
            tagAt(head, 0, "fLaC") -> return AudioContainerFormat.FLAC
            tagAt(head, 4, "ftyp") -> return AudioContainerFormat.MP4_M4A
        }
        if (head[0] == 0xFF.toByte()) {
            val b1 = head[1].toInt() and 0xFF
            // ADTS 同步头与 MP3 同步头有重叠，必须先判 ADTS（layer 恒为 00）
            if ((b1 and 0xF6) == 0xF0) return AudioContainerFormat.AAC_ADTS
            if ((b1 and 0xE0) == 0xE0) return AudioContainerFormat.MP3
        }
        return null
    }

    private fun tagAt(head: ByteArray, offset: Int, tag: String): Boolean {
        if (offset + tag.length > head.size) return false
        for (i in tag.indices) {
            if (head[offset + i] != tag[i].code.toByte()) return false
        }
        return true
    }
}
