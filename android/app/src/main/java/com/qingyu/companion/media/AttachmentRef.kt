package com.qingyu.companion.media

/**
 * 附件引用：消息/实体里存的就是它，而不是任何本地路径。
 *
 * [blobHash] 是内容地址（原图或通用文件），[thumbnailHash] 是缩略图的内容地址。
 * 展示名 [fileName] 已过 `AttachmentValidator.sanitizeFileName`，仅供 UI 显示。
 */
data class AttachmentRef(
    val blobHash: String,
    val mime: String,
    val byteSize: Long,
    val width: Int? = null,
    val height: Int? = null,
    val thumbnailHash: String? = null,
    val fileName: String? = null,
) {
    /** 同步/对外引用的唯一合法形态。 */
    fun syncToken(): String = SyncAttachmentPolicy.tokenOf(blobHash)
}

/**
 * 同步引用纪律（阶段 6 S6-02 最后一条）：
 * 「同步只传加密 blob，不传 `content://`、绝对路径或 PC `/static` URL」。
 *
 * 这条红线防的是两类真实事故：
 * 1. 把 `content://com.android.providers…/1234` 传出去——对端永远解不开，还会把
 *    本机内容提供者 ID 泄露到同步通道；
 * 2. 把 `/data/user/0/…`、`C:\Users\…`、`http://pc:8321/static/…` 当图片引用——
 *    前两者泄露本机文件布局，后者在关掉 PC 后全部变成死链（§0：关闭 PC 后 Android 必须独立可用）。
 *
 * 同时落实总方案 §6.2：单条 payload 解密后上限 2 MiB，更大的二进制**必须**走 blob 传输。
 */
object SyncAttachmentPolicy {
    /** 总方案 §6.2 的实体 payload 上限。 */
    const val MAX_PAYLOAD_BYTES: Long = 2L * 1024 * 1024

    private const val TOKEN_PREFIX = "blob:sha256:"

    fun tokenOf(hash: String): String = TOKEN_PREFIX + hash

    /** 超过 payload 上限的二进制必须走 blob 传输，不能内联进实体 payload。 */
    fun requiresBlob(byteCount: Long): Boolean = byteCount > MAX_PAYLOAD_BYTES

    sealed interface RefVerdict {
        data class Ok(val hash: String) : RefVerdict
        data class Rejected(val token: String, val reason: String) : RefVerdict
    }

    /**
     * 校验一个附件引用是否是合法同步引用。
     *
     * 只接受 `blob:sha256:<64 位十六进制>`；其余一切（`content://`、`file://`、
     * 绝对路径、盘符/UNC、`/static` URL、data URL、穿越片段）都是 Rejected。
     */
    fun validateRef(token: String): RefVerdict {
        val raw = token.trim()
        if (raw.isEmpty()) return RefVerdict.Rejected(token, "引用为空")
        if (raw.startsWith("content://")) {
            return RefVerdict.Rejected(token, "禁止同步 content:// 引用：对端不可解析且泄露本机内容提供者 ID")
        }
        if (raw.startsWith("file://")) {
            return RefVerdict.Rejected(token, "禁止同步 file:// 引用：本地文件路径不得离开设备")
        }
        if (raw.startsWith("data:")) {
            return RefVerdict.Rejected(token, "禁止把 data URL 当同步引用：二进制必须走加密 blob")
        }
        if (raw.startsWith("/") || raw.startsWith("\\")) {
            return RefVerdict.Rejected(token, "禁止同步绝对路径/UNC 路径：本地文件布局不得离开设备")
        }
        if (raw.length >= 2 && raw[1] == ':') {
            return RefVerdict.Rejected(token, "禁止同步盘符路径（C:\\…）：本地文件布局不得离开设备")
        }
        if (raw.contains("..")) {
            return RefVerdict.Rejected(token, "引用包含路径穿越片段")
        }
        if (raw.contains("://")) {
            return if (Regex("^https?://.*/static/", RegexOption.IGNORE_CASE).containsMatchIn(raw) ||
                raw.contains("/static/")
            ) {
                RefVerdict.Rejected(token, "禁止同步 PC /static URL：关闭 PC 后引用即失效（§0 独立可用要求）")
            } else {
                RefVerdict.Rejected(token, "禁止同步网络 URL 引用：附件必须走加密 blob")
            }
        }
        if (!raw.startsWith(TOKEN_PREFIX)) {
            return RefVerdict.Rejected(token, "引用不是 blob:sha256: 形态")
        }
        val hash = raw.removePrefix(TOKEN_PREFIX)
        if (!ContentHashing.isHash(hash)) {
            return RefVerdict.Rejected(token, "blob 引用的 hash 非法（必须是 64 位十六进制）")
        }
        return RefVerdict.Ok(hash)
    }

    /** 批量校验消息里的图片引用；任一非法即整批拒绝（不许「挑好的先发」）。 */
    fun scrubRefs(tokens: List<String>): List<RefVerdict> = tokens.map { validateRef(it) }
}
