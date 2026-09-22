package com.qingyu.companion.media

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Android 解码/重编码胶水（Robolectric：真实的 BitmapFactory/Bitmap.compress 路径）。
 *
 * 这里测的是「真的把像素解出来再压回去」的三条契约：
 * 1. probe 报真实尺寸；
 * 2. 缩略图按最长边封顶且仍可解码；
 * 3. 保留方向必须是解码→变换→重编码（产物尺寸交换、无任何 EXIF）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class AndroidImageCodecTest {

    private val codec = AndroidImageCodec()

    private fun realJpeg(width: Int = 200, height: Int = 100): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val out = ByteArrayOutputStream()
        assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out), "测试前置：合成 JPEG 失败")
        bitmap.recycle()
        return out.toByteArray()
    }

    @Test
    fun probe报出真实尺寸与格式() {
        val probe = assertNotNull(codec.probe(realJpeg(200, 100)), "真实 JPEG 探测失败：附件导入会全线拒绝")
        assertEquals(200 to 100, probe.width to probe.height, "尺寸读数错误：像素上限与缩略图都会算错")
        assertEquals(MagicBytes.MIME_JPEG, probe.mime, "格式读数错误")
    }

    @Test
    fun 缩略图按最长边封顶且仍可解码() {
        val thumb = assertNotNull(codec.thumbnail(realJpeg(200, 100), ThumbnailSpec(maxDimension = 64)), "缩略图生成失败：S6-02 要求必产缩略图")
        assertEquals(64 to 32, thumb.width to thumb.height, "缩略图尺寸错误：列表图会被拉伸")
        val inspected = assertIs<ImageInspection.Header>(
            ImageInspector.inspect(thumb.bytes),
            "缩略图产物必须是可解析的图片，否则列表会显示坏图",
        )
        assertEquals(64 to 32, inspected.width to inspected.height, "缩略图实际尺寸与声明不符")
    }

    @Test
    fun `保留方向是解码重编码：尺寸交换且产物无 EXIF`() {
        val transformed = assertNotNull(
            codec.reencodeWithOrientation(realJpeg(200, 100), OrientationTransform(rotationDegrees = 90, flipHorizontal = false)),
            "旋转重编码失败：竖拍照片会横着显示",
        )
        val inspected = assertIs<ImageInspection.Header>(
            ImageInspector.inspect(transformed),
            "重编码产物必须可解析",
        )
        assertEquals(100 to 200, inspected.width to inspected.height, "旋转 90° 后宽高必须交换")
        assertTrue(
            !String(transformed, Charsets.ISO_8859_1).contains("Exif"),
            "重编码产物不得带 EXIF：保留方向只能靠烘焙进像素，不能靠留标签",
        )
    }

    @Test
    fun 镜像变换产物仍可解码() {
        val flipped = assertNotNull(
            codec.reencodeWithOrientation(realJpeg(200, 100), OrientationTransform(rotationDegrees = 0, flipHorizontal = true)),
            "镜像重编码失败",
        )
        val probe = assertNotNull(codec.probe(flipped), "镜像产物必须可解码")
        assertEquals(200 to 100, probe.width to probe.height, "纯镜像不得改变尺寸")
    }

    @Test
    fun 损坏输入探测返回null而不是抛异常() {
        assertEquals(null, codec.probe("<html>不是图片</html>".toByteArray()), "损坏输入必须探测为失败并返回 null")
    }
}
