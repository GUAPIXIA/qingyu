package com.qingyu.companion.media

import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * 读取上限（阶段 6 S6-02：「读取时校验……大小」）。
 *
 * SAF 来源是 `content://` 流：`openFileDescriptor` 的 size 可以说谎，流也可以无限吐字节。
 * 「读完再检查大小」等于让攻击者先耗光内存——所以必须**边读边封顶**，
 * 超过上限立即放弃，已读部分直接丢弃。
 */
object CappedByteReader {
    sealed interface Result {
        data class Ok(val bytes: ByteArray) : Result {
            override fun equals(other: Any?): Boolean =
                other is Ok && bytes.contentEquals(other.bytes)

            override fun hashCode(): Int = bytes.contentHashCode()
        }

        data class Rejected(val reason: String) : Result
    }

    /**
     * 从 [input] 最多读取 [maxBytes] 字节；恰好等于上限允许，超过即拒。
     * 调用方负责关闭 [input]（这里不持有生命周期约定）。
     */
    fun read(input: InputStream, maxBytes: Long): Result {
        require(maxBytes >= 0) { "读取上限不能为负：$maxBytes" }
        val buffer = ByteArray(64 * 1024)
        val out = ByteArrayOutputStream(minOf(maxBytes, 64L * 1024).toInt() + 1)
        var total = 0L
        while (true) {
            val n = runCatching { input.read(buffer) }.getOrDefault(-1)
            if (n < 0) break
            total += n
            if (total > maxBytes) {
                return Result.Rejected("附件超过读取上限 ${maxBytes / 1024 / 1024} MiB：超限内容不得进入内存或 blob store")
            }
            out.write(buffer, 0, n)
        }
        val bytes = out.toByteArray()
        if (bytes.isEmpty()) return Result.Rejected("附件为空文件")
        return Result.Ok(bytes)
    }
}
