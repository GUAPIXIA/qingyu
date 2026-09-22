package com.qingyu.companion.media

/**
 * 解码/重编码抽象：让「先验证后落盘」「缩略图」「按方向重编码」这三条规则
 * 能在纯 JVM 单测里用假实现钉住行为，生产实现走 `AndroidImageCodec`（BitmapFactory）。
 *
 * 与 `MediaImportGate.Decoder` 同一思路，但刻意独立：附件管线的契约更宽
 * （还要产缩略图与带方向重编码），硬塞进 S5 的接口等于给头像导入加不该有的义务。
 */
interface ImageCodec {
    /** 只读边界的解码探测：拿尺寸/格式，失败返回 null（内容损坏或无法解码）。 */
    fun probe(bytes: ByteArray): ImageProbe?

    /** 生成缩略图（输出本身不含元数据）；失败返回 null。 */
    fun thumbnail(bytes: ByteArray, spec: ThumbnailSpec): Thumbnail?

    /**
     * 按 [transform] 解码→变换→重编码（烘焙方向，产物无任何元数据）。
     * 这是「如保留方向，解码后重编码」的唯一合法实现路径——不允许只改 EXIF 标签。
     */
    fun reencodeWithOrientation(bytes: ByteArray, transform: OrientationTransform): ByteArray?
}

/** 解码探测结果：只取尺寸与格式，不驻留位图。 */
data class ImageProbe(val width: Int, val height: Int, val mime: String)
