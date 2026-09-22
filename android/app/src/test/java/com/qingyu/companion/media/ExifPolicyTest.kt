package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * EXIF 默认剥离 + 保留方向必须重编码（S6-02：「EXIF 默认剥离；如保留方向，解码后重编码」）。
 */
class ExifPolicyTest {

    @Test
    fun `JPEG 的 EXIF、XMP、IPTC、注释被剥离，JFIF、ICC、Adobe 与像素数据保留`() {
        val jpeg = MediaFixtures.jpeg(
            app1 = MediaFixtures.exifApp1Payload(orientation = 6, withGpsTag = true),
            app2 = "ICC_PROFILE\u0000fake".toByteArray(),
            comment = "Shot on EvilPhone SN=12345".toByteArray(),
        )
        val stripped = assertNotNull(MetadataStripper.strip(jpeg, MagicBytes.MIME_JPEG), "合法 JPEG 剥离不得失败：用户会丢图")
        val text = String(stripped, Charsets.ISO_8859_1)
        assertTrue(!text.contains("Exif"), "EXIF 剥离失败：GPS/设备串会随同步泄露到其他设备")
        assertTrue(!text.contains("Shot on EvilPhone"), "注释剥离失败：拍摄设备信息会泄露")
        assertTrue(text.contains("ICC_PROFILE"), "ICC 段是功能性数据（色彩），剥掉会让图片偏色")
        assertTrue(text.contains("JFIF"), "JFIF APP0 是功能性头部，剥掉会让部分解码器拒解")
        assertTrue(stripped[0] == 0xff.toByte() && stripped[1] == 0xd8.toByte(), "剥离产物必须仍是合法 JPEG（SOI 起始）")
        assertTrue(
            stripped[stripped.size - 2] == 0xff.toByte() && stripped[stripped.size - 1] == 0xd9.toByte(),
            "剥离产物必须保留 EOI：否则截断检查会把它自己拒掉",
        )
    }

    @Test
    fun `PNG 的 tEXt／zTXt／iTXt／eXIf 被剥离，图像块保留`() {
        val png = MediaFixtures.png(
            8, 8,
            extraChunks = listOf(
                MediaFixtures.pngTextChunk(),
                MediaFixtures.pngExifChunk(),
                MediaFixtures.pngChunk("pHYs", ByteArray(9) { 1 }),
            ),
        )
        val stripped = assertNotNull(MetadataStripper.strip(png, MagicBytes.MIME_PNG), "合法 PNG 剥离不得失败：用户会丢图")
        val text = String(stripped, Charsets.ISO_8859_1)
        assertTrue(!text.contains("tEXt"), "PNG 文本块剥离失败：作者/GPS 常藏在这里")
        assertTrue(!text.contains("eXIf"), "PNG eXIf 块剥离失败：EXIF 会重新回到文件里")
        assertTrue(text.contains("pHYs"), "pHYs 是功能性块（物理尺寸），不该被剥")
        assertTrue(text.contains("IDAT") && text.contains("IEND"), "图像数据块必须原样保留")
        assertIs<ImageInspection.Header>(
            ImageInspector.inspect(stripped),
            "剥离产物必须仍能通过结构检查，否则等于把可用图片删成了坏图",
        )
    }

    @Test
    fun `GIF 注释与非 NETSCAPE 应用扩展被剥离，循环控制保留`() {
        val gif = MediaFixtures.gif(
            comment = "GPS=31.23,121.47",
            appExtensionId = "XMP DataXMP",
        )
        val stripped = assertNotNull(MetadataStripper.strip(gif, MagicBytes.MIME_GIF), "合法 GIF 剥离不得失败：用户会丢图")
        val text = String(stripped, Charsets.ISO_8859_1)
        assertTrue(!text.contains("GPS="), "GIF 注释剥离失败：位置信息会泄露")
        assertTrue(!text.contains("XMP"), "GIF XMP 应用扩展剥离失败：元数据会回流")

        val animated = MediaFixtures.gif(appExtensionId = "NETSCAPE2.0")
        val kept = assertNotNull(MetadataStripper.strip(animated, MagicBytes.MIME_GIF), "NETSCAPE 剥离不得失败")
        assertTrue(String(kept, Charsets.ISO_8859_1).contains("NETSCAPE2.0"), "NETSCAPE 是循环播放控制（功能性），剥掉会毁掉动图播放")
    }

    @Test
    fun `WebP 的 EXIF／XMP 块被剥离，尺寸与图像块保留`() {
        val webp = MediaFixtures.webp(
            width = 12, height = 34,
            exifPayload = MediaFixtures.exifApp1Payload(orientation = 6),
            xmpPayload = "<x:xmpmeta>GPS</x:xmpmeta>".toByteArray(),
        )
        val stripped = assertNotNull(MetadataStripper.strip(webp, MagicBytes.MIME_WEBP), "合法 WebP 剥离不得失败：用户会丢图")
        val text = String(stripped, Charsets.ISO_8859_1)
        assertTrue(!text.contains("EXIF"), "WebP EXIF 块剥离失败：方向/定位元数据会回流")
        assertTrue(!text.contains("GPS"), "WebP XMP 块剥离失败：定位元数据会回流")
        val inspected = assertIs<ImageInspection.Header>(
            ImageInspector.inspect(stripped),
            "剥离产物必须仍能通过结构检查（RIFF 长度要重算），否则等于把可用图片删成了坏图",
        )
        assertEquals(12 to 34, inspected.width to inspected.height, "剥离不得改动像素尺寸")
    }

    @Test
    fun `方向标签解析覆盖大小端与 WebP`() {
        val cases = mapOf(
            "BE 6" to (MediaFixtures.jpeg(app1 = MediaFixtures.exifApp1Payload(orientation = 6)) to 6),
            "BE 8" to (MediaFixtures.jpeg(app1 = MediaFixtures.exifApp1Payload(orientation = 8)) to 8),
            "LE 3" to (MediaFixtures.jpeg(app1 = MediaFixtures.exifApp1Payload(orientation = 3, bigEndian = false)) to 3),
            "WebP 6" to (MediaFixtures.webp(exifPayload = MediaFixtures.exifApp1Payload(orientation = 6)) to 6),
        )
        for ((label, pair) in cases) {
            assertEquals(pair.second, ExifOrientationReader.readOrientation(pair.first), "$label：方向解析错误，保留方向会转错角度")
        }
        assertNull(
            ExifOrientationReader.readOrientation(MediaFixtures.jpeg()),
            "无 EXIF 的 JPEG 必须解析为「无方向」，否则会白白重编码损画质",
        )
    }

    @Test
    fun `方向值到变换的映射表：1．．8 全覆盖，越界不给变换`() {
        val expected = mapOf(
            1 to (0 to false),
            2 to (0 to true),
            3 to (180 to false),
            4 to (180 to true),
            5 to (270 to true),
            6 to (90 to false),
            7 to (90 to true),
            8 to (270 to false),
        )
        for ((orientation, pair) in expected) {
            val transform = assertNotNull(ExifOrientation.transformOf(orientation), "方向 $orientation 必须有变换定义")
            assertEquals(pair.first, transform.rotationDegrees, "方向 $orientation 的旋转角错误：竖拍照片会横着显示")
            assertEquals(pair.second, transform.flipHorizontal, "方向 $orientation 的镜像错误：照片会左右颠倒")
        }
        for (bad in listOf(0, 9, -1, 255)) {
            assertNull(ExifOrientation.transformOf(bad), "非法方向值 $bad 不得给出变换，否则会按垃圾值旋转图片")
        }
        assertTrue(ExifOrientation.transformOf(1)!!.isIdentity, "方向 1 必须是恒等变换：否则正常图片被白白重编码")
    }
}
