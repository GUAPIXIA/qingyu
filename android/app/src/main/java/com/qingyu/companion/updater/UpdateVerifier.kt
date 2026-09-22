package com.qingyu.companion.updater

import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * S6-07 更新包校验（纯 JVM，JVM 可测）：
 * - **hash 校验**（SHA-256；缺失可信 checksum 一律拒绝，fail closed）；
 * - **损坏包识别**（APK 即 ZIP：PK 魔数 + EOCD 结构尾；损坏/截断一律拒绝）。
 */
object UpdateVerifier {

    /** ZIP 本地文件头魔数 "PK" */
    private const val ZIP_MAGIC_0 = 0x50
    private const val ZIP_MAGIC_1 = 0x4B

    /** ZIP EOCD 签名 0x06054b50（小端字节序 50 4B 05 06） */
    private const val EOCD_SIG_0 = 0x50
    private const val EOCD_SIG_1 = 0x4B
    private const val EOCD_SIG_2 = 0x05
    private const val EOCD_SIG_3 = 0x06

    /** EOCD 固定长度 22 + 最大注释 65535 */
    private const val EOCD_MIN_LEN = 22
    private const val ZIP_MAX_COMMENT = 65535
    private const val EOCD_SCAN_MAX = EOCD_MIN_LEN + ZIP_MAX_COMMENT

    /** APK 最小尺寸（低于此必为残包） */
    private const val MIN_APK_BYTES = 32L

    /** 内存字节形态校验（小样本测试用；大文件走 [verifyFile]） */
    fun verifyBytes(bytes: ByteArray, expectedSha256: String?): VerificationResult {
        if (expectedSha256.isNullOrBlank()) return VerificationResult.MissingChecksum
        val actual = sha256(bytes)
        if (!actual.equals(expectedSha256.trim(), ignoreCase = true)) {
            return VerificationResult.HashMismatch(expected = expectedSha256.trim().lowercase(), actual = actual)
        }
        if (!looksLikeZip(bytes)) return VerificationResult.Corrupt("not_zip_apk")
        return VerificationResult.Ok(actual)
    }

    /** 文件形态校验：流式 hash + 结构魔数（不整包读入内存） */
    fun verifyFile(file: File, expectedSha256: String?): VerificationResult {
        if (expectedSha256.isNullOrBlank()) return VerificationResult.MissingChecksum
        if (!file.isFile || file.length() < MIN_APK_BYTES) return VerificationResult.Corrupt("too_small")
        val actual = sha256OfFile(file)
        if (!actual.equals(expectedSha256.trim(), ignoreCase = true)) {
            return VerificationResult.HashMismatch(expected = expectedSha256.trim().lowercase(), actual = actual)
        }
        if (!looksLikeZipFile(file)) return VerificationResult.Corrupt("not_zip_apk")
        return VerificationResult.Ok(actual)
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

    fun sha256OfFile(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().toHex()
    }

    /** APK/ZIP 形态识别：头部 PK 魔数 + 尾部 EOCD 签名 */
    fun looksLikeZip(bytes: ByteArray): Boolean {
        if (bytes.size < EOCD_MIN_LEN) return false
        if ((bytes[0].toInt() and 0xFF) != ZIP_MAGIC_0 || (bytes[1].toInt() and 0xFF) != ZIP_MAGIC_1) return false
        return hasEocd(bytes, 0, bytes.size)
    }

    fun looksLikeZipFile(file: File): Boolean {
        val length = file.length()
        if (length < EOCD_MIN_LEN) return false
        RandomAccessFile(file, "r").use { raf ->
            val head = ByteArray(2)
            raf.seek(0)
            raf.readFully(head)
            if ((head[0].toInt() and 0xFF) != ZIP_MAGIC_0 || (head[1].toInt() and 0xFF) != ZIP_MAGIC_1) return false
            val scanLen = minOf(length, EOCD_SCAN_MAX.toLong()).toInt()
            val tail = ByteArray(scanLen)
            raf.seek(length - scanLen)
            raf.readFully(tail)
            return hasEocd(tail, 0, tail.size)
        }
    }

    /** 在 [from, from+len) 区间内查找 EOCD 签名 */
    private fun hasEocd(bytes: ByteArray, from: Int, len: Int): Boolean {
        val end = from + len
        var i = end - EOCD_MIN_LEN
        while (i >= from) {
            if ((bytes[i].toInt() and 0xFF) == EOCD_SIG_0 &&
                (bytes[i + 1].toInt() and 0xFF) == EOCD_SIG_1 &&
                (bytes[i + 2].toInt() and 0xFF) == EOCD_SIG_2 &&
                (bytes[i + 3].toInt() and 0xFF) == EOCD_SIG_3
            ) {
                return true
            }
            i--
        }
        return false
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
