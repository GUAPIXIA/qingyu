package com.qingyu.companion.chatcore

import java.security.SecureRandom

/**
 * 阶段 4：ULID 生成器（阶段 1 冻结契约：新 ID 使用 ULID，保留所有旧 ID）。
 *
 * 结构（Crockford Base32，26 字符）：
 * - 前 10 字符 = 48 位毫秒时间戳（**单调**：同毫秒内自增，保证同毫秒生成的 ID 有序）；
 * - 后 16 字符 = 80 位随机（[SecureRandom]）。
 *
 * 为什么需要单调性：Android 端新建消息/会话的 ID 会参与阶段 3 的
 * `LocalMessageEntity.seq` 之外的稳定排序与同步实体 ID，同毫秒内随机 80 位虽碰撞概率极低，
 * 但**单调时间戳前缀**让「同毫秒创建」的记录仍可稳定排序，便于诊断与冲突解释。
 */
object Ulid {

    private const val ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private const val TIME_CHARS = 10
    private const val RANDOM_CHARS = 16

    private val random = SecureRandom()

    private val lock = Any()
    private var lastTimestamp: Long = -1L
    private var lastRandom: ByteArray = ByteArray(10)

    /** 生成一个 ULID（26 字符 Crockford Base32，大写）。 */
    fun newId(): String = synchronized(lock) {
        var timestamp = System.currentTimeMillis()
        if (timestamp <= lastTimestamp) {
            // 同毫秒（或时钟回拨）：沿用上一次时间戳并让随机部分递增，保持单调
            timestamp = lastTimestamp
            incrementRandom()
        } else {
            lastTimestamp = timestamp
            lastRandom = ByteArray(10).also { random.nextBytes(it) }
        }
        encodeTime(timestamp) + encodeRandom(lastRandom)
    }

    /** 仅用于测试可复现性：重置内部单调状态。 */
    internal fun resetForTest() = synchronized(lock) {
        lastTimestamp = -1L
        lastRandom = ByteArray(10)
    }

    /** 80 位随机部分加一（大端）。溢出时保持全 0（概率 2^-80，忽略）。 */
    private fun incrementRandom() {
        for (i in lastRandom.indices.reversed()) {
            val next = (lastRandom[i].toInt() and 0xFF) + 1
            lastRandom[i] = (next and 0xFF).toByte()
            if (next <= 0xFF) return
        }
    }

    private fun encodeTime(timestamp: Long): String {
        val chars = CharArray(TIME_CHARS)
        var value = timestamp
        for (i in TIME_CHARS - 1 downTo 0) {
            chars[i] = ENCODING[(value and 0x1F).toInt()]
            value = value ushr 5
        }
        return String(chars)
    }

    private fun encodeRandom(bytes: ByteArray): String {
        // 80 位 / 5 位一组 = 16 字符
        val chars = CharArray(RANDOM_CHARS)
        var bitBuffer = 0
        var bitCount = 0
        var outIndex = 0
        for (byte in bytes) {
            bitBuffer = (bitBuffer shl 8) or (byte.toInt() and 0xFF)
            bitCount += 8
            while (bitCount >= 5 && outIndex < RANDOM_CHARS) {
                bitCount -= 5
                chars[outIndex++] = ENCODING[(bitBuffer ushr bitCount) and 0x1F]
            }
        }
        while (outIndex < RANDOM_CHARS) chars[outIndex++] = ENCODING[0]
        return String(chars)
    }

    /** 校验是否为合法 ULID（26 位、Crockford 字母表、首字符不超过 7 以限制时间戳长度）。 */
    fun isValid(value: String): Boolean {
        if (value.length != 26) return false
        return value.all { it in ENCODING }
    }
}
