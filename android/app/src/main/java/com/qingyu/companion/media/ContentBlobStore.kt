package com.qingyu.companion.media

import java.io.File
import java.security.MessageDigest

/**
 * 内容寻址的私有 blob store（阶段 6 S6-02：「原图进入内容寻址私有 blob store」）。
 *
 * 三条硬性质：
 * 1. **内容 hash 寻址 + 去重**：文件名就是 sha256，同一字节只存一份（手机存储经不起
 *    「同一只猫存五遍」）；
 * 2. **私有目录**：根目录由调用方传入应用私有路径（`context.filesDir/…`），
 *    本类不提供任何导出/共享入口；
 * 3. **键不可被输入操纵**：查找/删除只接受 64 位十六进制 hash，路径穿越在构造上就不可能
 *    （`../../etc/passwd` 这类字符串根本不满足键格式，连文件路径都不会拼）。
 *
 * 写入是「临时文件 + rename」：崩溃不会留下半个 blob 被当成有效内容。
 */
class ContentBlobStore(private val root: File) {

    data class StoredBlob(val hash: String, val size: Long, val reused: Boolean)

    private val objectsDir = File(root, "objects")
    private val tmpDir = File(root, "tmp")

    /** 写入（或命中去重）一份 blob；IO 失败返回 null（调用方按「写入失败」拒绝导入）。 */
    fun put(bytes: ByteArray): StoredBlob? {
        if (bytes.isEmpty()) return null
        val hash = ContentHashing.sha256Hex(bytes)
        val target = objectFile(hash) ?: return null // 计算出的 hash 恒合法；防御性保留
        if (target.isFile && target.length() == bytes.size.toLong()) {
            return StoredBlob(hash = hash, size = bytes.size.toLong(), reused = true)
        }
        if (!tmpDir.isDirectory && !tmpDir.mkdirs()) return null
        val temp = File(tmpDir, "$hash.${System.nanoTime()}.tmp")
        try {
            temp.writeBytes(bytes)
            target.parentFile?.mkdirs()
            if (!temp.renameTo(target)) {
                // 并发下可能已被另一路写入：内容寻址保证字节相同，删临时文件即可
                if (target.isFile) {
                    temp.delete()
                    return StoredBlob(hash = hash, size = bytes.size.toLong(), reused = true)
                }
                temp.delete()
                return null
            }
        } catch (e: Exception) {
            temp.delete()
            return null
        }
        return StoredBlob(hash = hash, size = bytes.size.toLong(), reused = false)
    }

    /** 按 hash 读取；非法键/不存在一律 null。 */
    fun read(hash: String): ByteArray? {
        val file = objectFile(hash) ?: return null
        return if (file.isFile) runCatching { file.readBytes() }.getOrNull() else null
    }

    fun has(hash: String): Boolean = objectFile(hash)?.isFile == true

    /** 删除一份 blob；非法键返回 false 且不触碰任何文件。 */
    fun delete(hash: String): Boolean {
        val file = objectFile(hash) ?: return false
        return runCatching { file.isFile && file.delete() }.getOrDefault(false)
    }

    /** 合法 hash → 对象文件；非法键返回 null（这就是路径穿越防线）。 */
    private fun objectFile(hash: String): File? {
        if (!ContentHashing.isHash(hash)) return null
        return File(File(objectsDir, hash.substring(0, 2)), hash)
    }
}

/** sha256 内容哈希（十六进制小写）与键格式判定。 */
object ContentHashing {
    private val HASH_FORMAT = Regex("^[0-9a-f]{64}$")

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** 只有 64 位小写十六进制才是合法 blob 键（大写/过短/含路径字符一律拒）。 */
    fun isHash(value: String?): Boolean = value != null && HASH_FORMAT.matches(value)
}
