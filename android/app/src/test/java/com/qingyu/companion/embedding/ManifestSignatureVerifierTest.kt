package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-05 模型包「签名/hash 校验」硬要求：
 * 签名（Ed25519，与 PC `node:crypto#verify(null, …)` 同算法）+ 逐文件 sha256。
 * 关键边界：**验不了签的设备必须拒装**，不能退化成只信 hash。
 */
class ManifestSignatureVerifierTest {

    private val verifier = Ed25519ManifestSignatureVerifier()

    @Test
    fun jcaEd25519IsAvailableOnTheJvmUnderTest() {
        assertTrue(
            "JVM 单测环境应能做 Ed25519 验签（真机 API<33 的能力探测与拒装策略见同文件用例）",
            verifier.isSupported(),
        )
    }

    @Test
    fun realEd25519SignatureOverCanonicalPayloadVerifies() {
        val keyPair = generateEd25519KeyPair()
        val fields = signManifestFields(manifestFields(mapOf("model.onnx" to "权重".toByteArray())), keyPair.private)
        val manifest = EmbeddingModelManifest.parse(fields)

        val check = ModelPackageVerifier.verifyManifestSignature(manifest, publicKeyPem(keyPair.public), verifier)
        assertTrue("合法签名必须通过，否则所有模型包都装不上", check is SignatureCheck.Valid)
    }

    @Test
    fun tamperedManifestIsRejectedBySignature() {
        val keyPair = generateEd25519KeyPair()
        val fields = signManifestFields(manifestFields(mapOf("model.onnx" to "权重".toByteArray())), keyPair.private)
        val manifest = EmbeddingModelManifest.parse(fields)
        // 篡改载荷内容（换 hash）但保留原签名：篡改后验签必须失败
        val tamperedFields = fields.toMutableMap()
        tamperedFields["installedSize"] = 999999L
        val tampered = EmbeddingModelManifest.parse(tamperedFields)

        val check = ModelPackageVerifier.verifyManifestSignature(tampered, publicKeyPem(keyPair.public), verifier)
        assertTrue("清单被篡改后签名必须验不过，否则攻击者可换权重骗过校验", check is SignatureCheck.Invalid)
        // 原件仍然有效（证明失败来自篡改而不是密钥/算法问题）
        assertTrue(
            "原清单必须仍然验得过，否则说明验签实现本身有问题",
            ModelPackageVerifier.verifyManifestSignature(manifest, publicKeyPem(keyPair.public), verifier) is SignatureCheck.Valid,
        )
    }

    @Test
    fun garbageSignatureAndWrongKeyAreRejectedWithoutThrowing() {
        val keyPair = generateEd25519KeyPair()
        val otherKeyPair = generateEd25519KeyPair()
        val fields = signManifestFields(manifestFields(mapOf("model.onnx" to "权重".toByteArray())), keyPair.private)
        val manifest = EmbeddingModelManifest.parse(fields)

        assertFalse("坏 base64 不是异常路径而是校验失败（PC 同款 catch→false）", verifier.verify(manifest.signingPayload().toByteArray(), "!!!", publicKeyPem(keyPair.public)))
        assertFalse("随机签名不能通过", verifier.verify(manifest.signingPayload().toByteArray(), "AAAA", publicKeyPem(keyPair.public)))
        assertFalse(
            "换公钥必须验不过（同名模型包不能冒用别家签名）",
            verifier.verify(manifest.signingPayload().toByteArray(), manifest.catalogSignature, publicKeyPem(otherKeyPair.public)),
        )
    }

    @Test
    fun unsupportedDeviceRefusesInstallInsteadOfTrustingHash() {
        val fake = FakeManifestSignatureVerifier(supported = false)
        val manifest = EmbeddingModelManifest.parse(manifestFields(mapOf("model.onnx" to "权重".toByteArray())))
        val check = ModelPackageVerifier.verifyManifestSignature(manifest, "任意公钥", fake)
        assertTrue("验不了签的设备必须给出 Unsupported 结论（拒装并降级），而不是跳过验签", check is SignatureCheck.Unsupported)
        val message = (check as SignatureCheck.Unsupported).message
        assertTrue("拒装理由要说明为什么（用户要知道是设备能力问题）：$message", message.contains("无法验证模型包签名"))
    }

    @Test
    fun fileHashAndSizeVerificationRejectsWithDistinctReasons() {
        val good = "权重字节内容".toByteArray()
        val manifest = EmbeddingModelManifest.parse(
            manifestFields(mapOf("model.onnx" to good)),
        )
        assertTrue("字节与清单一致时必须通过", ModelPackageVerifier.verifyFiles(manifest, mapOf("model.onnx" to good)) is FileVerification.Ok)

        val corrupted = good.copyOf().also { it[0] = (it[0] + 1).toByte() }
        val hashCheck = ModelPackageVerifier.verifyFiles(manifest, mapOf("model.onnx" to corrupted))
        assertEquals(
            "内容被改（大小不变）必须报 hash 不匹配——这是防篡改的最后一道，不能混进大小错误里",
            FileVerification.Rejected.Reason.HASH_MISMATCH,
            (hashCheck as FileVerification.Rejected).reason,
        )
        assertTrue("错误文案要带文件名", hashCheck.message.contains("model.onnx"))

        val truncated = good.copyOf(good.size - 1)
        val sizeCheck = ModelPackageVerifier.verifyFiles(manifest, mapOf("model.onnx" to truncated))
        assertEquals(
            "缺字节要报大小不匹配（下载不完整），用户该重下而不是怀疑包被篡改",
            FileVerification.Rejected.Reason.SIZE_MISMATCH,
            (sizeCheck as FileVerification.Rejected).reason,
        )

        val missingCheck = ModelPackageVerifier.verifyFiles(manifest, emptyMap())
        assertEquals(
            "文件缺失要单独报，否则会和下载失败混为一谈",
            FileVerification.Rejected.Reason.MISSING,
            (missingCheck as FileVerification.Rejected).reason,
        )
    }
}
