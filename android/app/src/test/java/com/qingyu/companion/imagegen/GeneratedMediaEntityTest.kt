package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-04：media entity 数据形状与绑定校验（落库接线由主代理完成）。
 */
class GeneratedMediaEntityTest {

    private fun verifiedImage(): VerifiedImage {
        val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2)
        val sha = ImageResultVerifier.sha256Hex(bytes)
        return VerifiedImage("image/png", bytes, sha, bytes.size.toLong())
    }

    @Test
    fun `valid entity with message binding built`() {
        val result = GeneratedMediaEntityFactory.create(
            entityId = "01JMEDIA000000000000000001",
            image = verifiedImage(),
            sourceProvider = "comfyui",
            prompt = "a cat",
            createdAt = 1789550000000,
            binding = MediaEntityBinding.Message("01JMSG00000000000000000001"),
        )
        result as GeneratedMediaEntityFactory.BuildResult.Ok
        assertEquals("MIME 必须归一化为受支持类型", "image/png", result.entity.mimeType)
        assertEquals("绑定必须保留", MediaEntityBinding.Message("01JMSG00000000000000000001"), result.entity.binding)
        assertEquals("哈希必须随实体保存", ImageResultVerifier.sha256Hex(verifiedImage().bytes), result.entity.sha256)
    }

    @Test
    fun `character binding accepted and no binding allowed`() {
        val charBound = GeneratedMediaEntityFactory.create(
            entityId = "01JMEDIA000000000000000002",
            image = verifiedImage(),
            sourceProvider = "openai",
            prompt = null,
            createdAt = 1,
            binding = MediaEntityBinding.Character("01JCHAR0000000000000000001"),
        )
        assertTrue("角色绑定必须可用", charBound is GeneratedMediaEntityFactory.BuildResult.Ok)
        val unbound = GeneratedMediaEntityFactory.create(
            entityId = "01JMEDIA000000000000000003",
            image = verifiedImage(),
            sourceProvider = "sd-webui",
            prompt = null,
            createdAt = 1,
        )
        assertTrue("允许不绑定", unbound is GeneratedMediaEntityFactory.BuildResult.Ok)
    }

    @Test
    fun `unsafe entity ids rejected`() {
        for (bad in listOf("", "  ", "file://x", "../etc/passwd", "a/b", "a\\b", "id:1")) {
            val result = GeneratedMediaEntityFactory.create(
                entityId = bad,
                image = verifiedImage(),
                sourceProvider = "openai",
                prompt = null,
                createdAt = 1,
            )
            assertTrue("路径/URI 形状的 ID 必须拒绝：$bad", result is GeneratedMediaEntityFactory.BuildResult.Rejected)
        }
    }

    @Test
    fun `unsafe binding id rejected`() {
        val result = GeneratedMediaEntityFactory.create(
            entityId = "01JMEDIA000000000000000004",
            image = verifiedImage(),
            sourceProvider = "openai",
            prompt = null,
            createdAt = 1,
            binding = MediaEntityBinding.Message("file://msg"),
        )
        result as GeneratedMediaEntityFactory.BuildResult.Rejected
        assertEquals("绑定 ID 含 URI 特征必须拒绝", "BAD_BINDING", result.failure.code)
    }

    @Test
    fun `tampered hash and bad timestamp rejected`() {
        val image = verifiedImage()
        val tampered = image.copy(sha256Hex = "0".repeat(64))
        val hashResult = GeneratedMediaEntityFactory.create(
            entityId = "01JMEDIA000000000000000005",
            image = tampered,
            sourceProvider = "openai",
            prompt = null,
            createdAt = 1,
        ) as GeneratedMediaEntityFactory.BuildResult.Rejected
        assertEquals("哈希与内容不一致必须拒绝", "HASH_MISMATCH", hashResult.failure.code)

        val timeResult = GeneratedMediaEntityFactory.create(
            entityId = "01JMEDIA000000000000000006",
            image = image,
            sourceProvider = "openai",
            prompt = null,
            createdAt = 0,
        ) as GeneratedMediaEntityFactory.BuildResult.Rejected
        assertEquals("非法时间戳必须拒绝", "BAD_TIMESTAMP", timeResult.failure.code)
    }

    @Test
    fun `overlong prompt rejected`() {
        val result = GeneratedMediaEntityFactory.create(
            entityId = "01JMEDIA000000000000000007",
            image = verifiedImage(),
            sourceProvider = "openai",
            prompt = "x".repeat(GeneratedMediaEntityFactory.MAX_PROMPT_CHARS + 1),
            createdAt = 1,
        ) as GeneratedMediaEntityFactory.BuildResult.Rejected
        assertEquals("超长提示词必须拒绝", "PROMPT_TOO_LONG", result.failure.code)
    }
}
