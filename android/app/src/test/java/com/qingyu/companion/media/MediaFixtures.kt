package com.qingyu.companion.media

import java.io.ByteArrayOutputStream
import java.util.zip.CRC32

/**
 * 测试用的**合成**图片字节（纯 JVM 可构造，不依赖 Android 资源）。
 *
 * 为什么全部手写字节而不是放图片资源：
 * 1. 安全红线测试要的是「结构精确可控」——截断到第 N 字节、IHDR CRC 改坏、声明 46340×46340
 *    的解压炸弹，这些没有现成资源可用；
 * 2. EXIF/GPS/注释块要精确构造才好断言「剥离后一定不存在」；
 * 3. 合成字节让「损坏输入」的定义可复现（真实损坏图片每张都不一样，测不出确定性）。
 */
object MediaFixtures {

    /** 1×1 透明 PNG（真实可解码，来自 MediaImportGateTest 的同一常量）。 */
    val realPng1x1: ByteArray = java.util.Base64.getMimeDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    )

    fun writeU32be(out: ByteArrayOutputStream, value: Long) {
        out.write(((value shr 24) and 0xFF).toInt())
        out.write(((value shr 16) and 0xFF).toInt())
        out.write(((value shr 8) and 0xFF).toInt())
        out.write((value and 0xFF).toInt())
    }

    fun writeU32le(out: ByteArrayOutputStream, value: Long) {
        out.write((value and 0xFF).toInt())
        out.write(((value shr 8) and 0xFF).toInt())
        out.write(((value shr 16) and 0xFF).toInt())
        out.write(((value shr 24) and 0xFF).toInt())
    }

    fun writeU16be(out: ByteArrayOutputStream, value: Int) {
        out.write((value shr 8) and 0xFF)
        out.write(value and 0xFF)
    }

    /** PNG 块：长度 + 类型 + 数据 + CRC32（类型与数据）。 */
    fun pngChunk(type: String, data: ByteArray): ByteArray {
        val typeBytes = type.toByteArray(Charsets.US_ASCII)
        val out = ByteArrayOutputStream()
        writeU32be(out, data.size.toLong())
        out.write(typeBytes)
        out.write(data)
        val crc = CRC32()
        crc.update(typeBytes)
        crc.update(data)
        writeU32be(out, crc.value)
        return out.toByteArray()
    }

    /**
     * 合成 PNG：签名 + IHDR + [extraChunks] + IDAT + IEND。
     * 宽高任意（含 46340×46340 这种「几十字节文件、解出 21 亿像素」的炸弹形状）。
     */
    fun png(
        width: Int,
        height: Int,
        extraChunks: List<ByteArray> = emptyList(),
        includeIdat: Boolean = true,
        includeIend: Boolean = true,
    ): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
        val ihdr = ByteArrayOutputStream()
        writeU32be(ihdr, width.toLong())
        writeU32be(ihdr, height.toLong())
        ihdr.write(byteArrayOf(8, 6, 0, 0, 0)) // 位深 8、真彩色+alpha、压缩 0、滤波 0、隔行 0
        out.write(pngChunk("IHDR", ihdr.toByteArray()))
        extraChunks.forEach { out.write(it) }
        if (includeIdat) out.write(pngChunk("IDAT", byteArrayOf(0x78, 0x9c.toByte(), 0x03, 0x00, 0x00, 0x00, 0x00, 0x01)))
        if (includeIend) out.write(pngChunk("IEND", ByteArray(0)))
        return out.toByteArray()
    }

    /** tEXt 元数据块（模拟 EXIF 之外的隐私泄漏：作者/设备串常藏在这里）。 */
    fun pngTextChunk(text: String = "Author=phone;GPS=31.23,121.47"): ByteArray =
        pngChunk("tEXt", text.toByteArray(Charsets.ISO_8859_1))

    /** eXIf 块（PNG 版 EXIF）。 */
    fun pngExifChunk(): ByteArray = pngChunk("eXIf", tiffOrientation(6))

    /** 合成最小 JPEG：SOI + APP0(JFIF) + [app1]? + SOF0 + SOS + 熵数据 + EOI?（纯结构，不需可解码）。 */
    fun jpeg(
        width: Int = 16,
        height: Int = 8,
        app1: ByteArray? = null,
        app2: ByteArray? = null,
        comment: ByteArray? = null,
        withEoi: Boolean = true,
    ): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0xff.toByte(), 0xd8.toByte())) // SOI
        out.write(byteArrayOf(0xff.toByte(), 0xe0.toByte()))
        writeU16be(out, 16)
        out.write("JFIF\u0000".toByteArray(Charsets.US_ASCII))
        out.write(byteArrayOf(1, 1, 0, 0, 1, 0, 1, 0, 0))
        app1?.let { out.write(segment(0xe1, it)) }
        app2?.let { out.write(segment(0xe2, it)) }
        comment?.let { out.write(segment(0xfe, it)) }
        // SOF0：精度 + 高 + 宽 + 1 分量（3 字节分量表）
        val sof = ByteArrayOutputStream()
        sof.write(8)
        writeU16be(sof, height)
        writeU16be(sof, width)
        sof.write(1)
        sof.write(byteArrayOf(1, 0x11, 0))
        out.write(segment(0xc0, sof.toByteArray()))
        // SOS + 假熵数据
        val sos = ByteArrayOutputStream()
        sos.write(1)
        sos.write(byteArrayOf(1, 0x00))
        sos.write(byteArrayOf(0, 63, 0))
        out.write(segment(0xda, sos.toByteArray()))
        out.write(byteArrayOf(0x00, 0x01, 0x02, 0x03))
        if (withEoi) out.write(byteArrayOf(0xff.toByte(), 0xd9.toByte()))
        return out.toByteArray()
    }

    private fun segment(marker: Int, payload: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0xff)
        out.write(marker)
        writeU16be(out, payload.size + 2)
        out.write(payload)
        return out.toByteArray()
    }

    /** TIFF IFD0 内联一个 Orientation(0x0112) SHORT（可选再塞一个 GPS IFD 指针标签）。 */
    fun tiffOrientation(orientation: Int, bigEndian: Boolean = true, withGpsTag: Boolean = false): ByteArray {
        val out = ByteArrayOutputStream()
        if (bigEndian) {
            out.write("MM".toByteArray(Charsets.US_ASCII))
            writeU16be(out, 42)
            writeU32be(out, 8)
            val count = if (withGpsTag) 2 else 1
            writeU16be(out, count)
            writeU16be(out, 0x0112) // Orientation
            writeU16be(out, 3) // SHORT
            writeU32be(out, 1)
            writeU16be(out, orientation)
            writeU16be(out, 0)
            if (withGpsTag) {
                writeU16be(out, 0x8825) // GPSInfo IFD 指针（模拟定位数据存在）
                writeU16be(out, 4)
                writeU32be(out, 1)
                writeU32be(out, 8)
            }
            writeU32be(out, 0)
        } else {
            out.write("II".toByteArray(Charsets.US_ASCII))
            out.write(byteArrayOf(42, 0))
            writeU32le(out, 8)
            val count = if (withGpsTag) 2 else 1
            out.write(byteArrayOf((count and 0xFF).toByte(), (count shr 8).toByte()))
            out.write(byteArrayOf(0x12, 0x01)) // tag 0x0112 LE
            out.write(byteArrayOf(3, 0))
            writeU32le(out, 1)
            out.write(byteArrayOf((orientation and 0xFF).toByte(), 0, 0, 0))
            if (withGpsTag) {
                out.write(byteArrayOf(0x25, 0x88.toByte())) // 0x8825 LE
                out.write(byteArrayOf(4, 0))
                writeU32le(out, 1)
                writeU32le(out, 8)
            }
            writeU32le(out, 0)
        }
        return out.toByteArray()
    }

    /** Exif APP1 载荷：`Exif\0\0` + TIFF。 */
    fun exifApp1Payload(orientation: Int = 1, bigEndian: Boolean = true, withGpsTag: Boolean = false): ByteArray {
        val tiff = tiffOrientation(orientation, bigEndian, withGpsTag)
        val out = ByteArrayOutputStream()
        out.write("Exif\u0000\u0000".toByteArray(Charsets.ISO_8859_1))
        out.write(tiff)
        return out.toByteArray()
    }

    /**
     * 合成最小 GIF：GIF89a + 逻辑屏幕描述符 + 可选注释/应用扩展 + 一个图像块 + trailer。
     */
    fun gif(
        width: Int = 2,
        height: Int = 3,
        comment: String? = null,
        appExtensionId: String? = null,
        withTrailer: Boolean = true,
    ): ByteArray {
        val out = ByteArrayOutputStream()
        out.write("GIF89a".toByteArray(Charsets.US_ASCII))
        out.write(byteArrayOf((width and 0xFF).toByte(), (width shr 8).toByte()))
        out.write(byteArrayOf((height and 0xFF).toByte(), (height shr 8).toByte()))
        out.write(byteArrayOf(0, 0, 0)) // 无全局色表
        comment?.let {
            out.write(byteArrayOf(0x21, 0xfe.toByte()))
            writeSubBlock(out, it.toByteArray(Charsets.US_ASCII))
            out.write(0)
        }
        appExtensionId?.let {
            out.write(byteArrayOf(0x21, 0xff.toByte()))
            val id = it.padEnd(11, '\u0000').toByteArray(Charsets.ISO_8859_1).copyOf(11)
            writeSubBlock(out, id)
            writeSubBlock(out, byteArrayOf(1, 1, 0)) // NETSCAPE 循环子块形状
            out.write(0)
        }
        // 图像块
        out.write(0x2c)
        out.write(ByteArray(4)) // x, y
        out.write(byteArrayOf((width and 0xFF).toByte(), (width shr 8).toByte()))
        out.write(byteArrayOf((height and 0xFF).toByte(), (height shr 8).toByte()))
        out.write(0) // 无局部色表
        out.write(8) // LZW 最小码长
        writeSubBlock(out, byteArrayOf(0x00, 0x01))
        out.write(0)
        if (withTrailer) out.write(0x3b)
        return out.toByteArray()
    }

    private fun writeSubBlock(out: ByteArrayOutputStream, data: ByteArray) {
        out.write(data.size)
        out.write(data)
    }

    /**
     * 合成最小 WebP（VP8L 无损头 + 可选 EXIF 块）。
     * 尺寸走 VP8L 的 14bit 字段（宽-1/高-1）。
     */
    fun webp(width: Int = 2, height: Int = 3, exifPayload: ByteArray? = null, xmpPayload: ByteArray? = null): ByteArray {
        val body = ByteArrayOutputStream()
        exifPayload?.let { writeRiffChunk(body, "EXIF", it) }
        xmpPayload?.let { writeRiffChunk(body, "XMP ", it) }
        val vp8l = ByteArrayOutputStream()
        vp8l.write(0x2f) // VP8L 签名
        val bits = ((width - 1) and 0x3fff) or (((height - 1) and 0x3fff) shl 14)
        writeU32le(vp8l, bits.toLong())
        writeRiffChunk(body, "VP8L", vp8l.toByteArray())

        val bodyBytes = body.toByteArray()
        val out = ByteArrayOutputStream()
        out.write("RIFF".toByteArray(Charsets.US_ASCII))
        writeU32le(out, (bodyBytes.size + 4).toLong())
        out.write("WEBP".toByteArray(Charsets.US_ASCII))
        out.write(bodyBytes)
        return out.toByteArray()
    }

    private fun writeRiffChunk(out: ByteArrayOutputStream, fourCc: String, payload: ByteArray) {
        out.write(fourCc.toByteArray(Charsets.US_ASCII))
        writeU32le(out, payload.size.toLong())
        out.write(payload)
        if (payload.size % 2 == 1) out.write(0) // RIFF 对齐填充
    }
}
