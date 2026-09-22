package com.qingyu.companion.media

/**
 * 附件导入编排（阶段 6 S6-02 的「先验后写」主线）。
 *
 * 管线顺序是刻意的：**所有校验与变换先做完，最后才写 blob**：
 *
 * ```
 * 校验(名/MIME/魔数/尺寸/大小/结构) → 解码探测 → EXIF 策略 → 缩略图 → 写原图 blob + 缩略图 blob
 * ```
 *
 * 为什么写盘必须放最后：
 * 1. 恶意输入绝不允许在私有目录留下任何字节（S6-02 §3：恶意图片/伪 MIME/超大像素/损坏输入
 *    必须被拦截）——「拒了但文件已经落盘」就是没拦住；
 * 2. 内容寻址以字节为准，先写后验会让「注定被拒的内容」占用存储并污染去重表；
 * 3. 剥离/重编码会改变字节（hash 随之变化），落盘的必须是**最终产物**，否则缩略图、
 *    同步引用与原图内容对不上。
 */
class AttachmentIngestService(
    private val store: ContentBlobStore,
    private val codec: ImageCodec,
    private val limits: AttachmentLimits = AttachmentLimits(),
    private val thumbnailSpec: ThumbnailSpec = ThumbnailSpec(),
) {

    sealed interface ImportOutcome {
        /** [ref] 是可入库/可同步的引用；[deduplicated] 表示两份 blob 都命中了内容去重。 */
        data class Imported(val ref: AttachmentRef, val deduplicated: Boolean) : ImportOutcome
        data class Rejected(val reason: String) : ImportOutcome
    }

    /**
     * 导入图片附件：校验 → 解码探测 → EXIF 策略 → 缩略图 → 双 blob 落盘。
     *
     * [handling] 默认 [ExifHandling.STRIP_METADATA]（无损剥离元数据）；
     * [ExifHandling.KEEP_ORIENTATION_THEN_REENCODE] 走「解码→烘焙方向→重编码」。
     */
    fun importImage(
        fileName: String?,
        declaredMime: String?,
        bytes: ByteArray,
        handling: ExifHandling = ExifHandling.STRIP_METADATA,
    ): ImportOutcome {
        val accepted = when (val verdict = AttachmentValidator.validateImage(fileName, declaredMime, bytes, limits)) {
            is AttachmentVerdict.Accepted -> verdict
            is AttachmentVerdict.Rejected -> return ImportOutcome.Rejected(verdict.reason)
        }
        // 结构合法 ≠ 可解码：真实解码器探测是第二道闸（截断流/坏 Huffman 表只有它抓得到）
        val probe = codec.probe(bytes)
            ?: return ImportOutcome.Rejected("图片无法解码（损坏输入不得进入 blob store）")
        if (probe.width > limits.maxPixelWidth || probe.height > limits.maxPixelHeight ||
            probe.width.toLong() * probe.height.toLong() > limits.maxPixelCount
        ) {
            // 解码器报出的尺寸是真值；与文件头不一致时以更严者为准（解压炸弹双保险）
            return ImportOutcome.Rejected(
                "图片实际尺寸 ${probe.width}x${probe.height} 超过限制（解压炸弹在写盘前被拦截）",
            )
        }

        val finalBytes = when (handling) {
            ExifHandling.STRIP_METADATA -> MetadataStripper.strip(bytes, accepted.mime)
                ?: return ImportOutcome.Rejected("元数据剥离失败（结构异常，拒绝写入）")
            ExifHandling.KEEP_ORIENTATION_THEN_REENCODE -> {
                val orientation = ExifOrientationReader.readOrientation(bytes) ?: 1
                val transform = ExifOrientation.transformOf(orientation)
                if (transform == null || transform.isIdentity) {
                    // 没有方向信息（或本就正常）：剥离即等价，无需重编码损画质
                    MetadataStripper.strip(bytes, accepted.mime)
                        ?: return ImportOutcome.Rejected("元数据剥离失败（结构异常，拒绝写入）")
                } else {
                    codec.reencodeWithOrientation(bytes, transform)
                        ?: return ImportOutcome.Rejected("按方向重编码失败（解码后重编码是保留方向的唯一合法路径）")
                }
            }
        }

        // 缩略图是必选产物：消息列表只加载缩略图，缺图的「成功导入」会把滚动性能拖垮
        val thumb = codec.thumbnail(finalBytes, thumbnailSpec)
            ?: return ImportOutcome.Rejected("缩略图生成失败（拒绝写入：附件必须带缩略图）")
        if (thumb.bytes.isEmpty() || thumb.width <= 0 || thumb.height <= 0) {
            return ImportOutcome.Rejected("缩略图产物非法（拒绝写入）")
        }

        val original = store.put(finalBytes)
            ?: return ImportOutcome.Rejected("写入失败：blob store 不可用（磁盘故障）")
        val thumbBlob = store.put(thumb.bytes)
            ?: return ImportOutcome.Rejected("写入失败：blob store 不可用（磁盘故障）")
        val finalMime = MagicBytes.detectImageMime(finalBytes) ?: accepted.mime
        val finalProbe = codec.probe(finalBytes) ?: ImageProbe(accepted.width ?: 0, accepted.height ?: 0, finalMime)
        return ImportOutcome.Imported(
            ref = AttachmentRef(
                blobHash = original.hash,
                mime = finalMime,
                byteSize = original.size,
                width = finalProbe.width,
                height = finalProbe.height,
                thumbnailHash = thumbBlob.hash,
                fileName = (AttachmentValidator.sanitizeFileName(fileName) as? AttachmentValidator.NameVerdict.Safe)?.base,
            ),
            deduplicated = original.reused && thumbBlob.reused,
        )
    }

    /** 通用文件附件（`attachments.file`）：同一红线，只是没有尺寸/缩略图概念。 */
    fun importFile(
        fileName: String?,
        declaredMime: String?,
        bytes: ByteArray,
    ): ImportOutcome {
        // 图片必须走图片通道（缩略图 + EXIF 策略），在这里放行等于绕过 S6-02 的一半要求
        if (MagicBytes.detectImageMime(bytes) != null) {
            return ImportOutcome.Rejected("图片附件请走图片通道导入（需生成缩略图并处理 EXIF）")
        }
        val accepted = when (val verdict = AttachmentValidator.validateFile(fileName, declaredMime, bytes, limits)) {
            is AttachmentVerdict.Accepted -> verdict
            is AttachmentVerdict.Rejected -> return ImportOutcome.Rejected(verdict.reason)
        }
        val stored = store.put(bytes)
            ?: return ImportOutcome.Rejected("写入失败：blob store 不可用（磁盘故障）")
        return ImportOutcome.Imported(
            ref = AttachmentRef(
                blobHash = stored.hash,
                mime = accepted.mime,
                byteSize = stored.size,
                fileName = (AttachmentValidator.sanitizeFileName(fileName) as? AttachmentValidator.NameVerdict.Safe)?.base,
            ),
            deduplicated = stored.reused,
        )
    }

    /** 按魔数自动分流：图片走 [importImage]，其余走 [importFile]。 */
    fun importAny(
        fileName: String?,
        declaredMime: String?,
        bytes: ByteArray,
        handling: ExifHandling = ExifHandling.STRIP_METADATA,
    ): ImportOutcome = if (MagicBytes.detectImageMime(bytes) != null) {
        importImage(fileName, declaredMime, bytes, handling)
    } else {
        importFile(fileName, declaredMime, bytes)
    }
}
