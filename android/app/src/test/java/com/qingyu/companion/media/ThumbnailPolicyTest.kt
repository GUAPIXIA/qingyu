package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** 缩略图尺寸计算（等比、最长边封顶、小图不放大）。 */
class ThumbnailPolicyTest {

    @Test
    fun `等比缩放表驱动：横图、竖图、方图、小图`() {
        val cases = listOf(
            Triple(1000 to 500, 512, 512 to 256), // 横图按宽封顶
            Triple(500 to 1000, 512, 256 to 512), // 竖图按高封顶
            Triple(1024 to 1024, 512, 512 to 512), // 方图
            Triple(100 to 80, 512, 100 to 80), // 小图不放大（放大只添噪点）
            Triple(3 to 1000, 512, 2 to 512), // 极端长条：短边按比例后不得塌成 0
        )
        for ((input, maxDim, expected) in cases) {
            val (w, h) = ThumbnailMath.fit(input.first, input.second, maxDim)
            assertEquals(expected.first to expected.second, w to h, "缩略图尺寸计算错误（输入 ${input.first}x${input.second} 上限 $maxDim）：列表图会被拉伸或压成 0 像素")
        }
    }

    @Test
    fun `非法输入直接抛错，不悄悄返回垃圾尺寸`() {
        assertFailsWith<IllegalArgumentException> {
            ThumbnailMath.fit(0, 10, 512)
        }
        assertFailsWith<IllegalArgumentException> {
            ThumbnailMath.fit(10, 10, 0)
        }
    }
}
