package com.qingyu.companion.media

import android.content.ContentResolver
import android.net.Uri

/**
 * SAF 选图/选文件后的**读取胶水**（阶段 6 S6-02：「使用 SAF 选择图片，读取时校验……大小」）。
 *
 * 选择器（`ActivityResultContracts.GetContent/OpenDocument`）在 UI 层；这里只负责
 * `content://` → 字节，且**边读边封顶**（[CappedByteReader]）：
 * 来源声明的 size 可以说谎，流也可以无限吐字节，「读完再检查」等于先把内存耗光。
 *
 * MIME 与展示名由调用方从选择器结果传入（`intent.type` / `OpenableColumns.DISPLAY_NAME`）：
 * 它们只是**声明值**，真实性由 `AttachmentValidator` 的魔数比对决定——本类不做任何信任。
 */
class SafAttachmentSource(
    private val contentResolver: ContentResolver,
) {
    /**
     * 读取一个 SAF 来源。[maxBytes] 为读取上限（建议取 `AttachmentLimits.maxFileBytes`）。
     * 拒绝原因直接可展示；成功返回的字节仍需过 `AttachmentValidator`。
     */
    fun read(uri: Uri, maxBytes: Long): CappedByteReader.Result {
        val input = runCatching { contentResolver.openInputStream(uri) }.getOrNull()
            ?: return CappedByteReader.Result.Rejected("无法打开所选文件（来源不可读或权限已失效）")
        return input.use { CappedByteReader.read(it, maxBytes) }
    }
}
