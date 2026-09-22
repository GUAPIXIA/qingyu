package com.qingyu.companion.embedding

import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * 阶段 6 S6-05 模型包的**签名/hash 校验**（下载包必须有签名/hash 的硬要求之一）。
 *
 * 契约对齐 PC `electron/services/localModels/manifest.ts`：
 * - 签名算法 **Ed25519**，签名内容为 `manifestSigningPayload` 的 canonical JSON 字节；
 * - 每个模型文件校验 **sha256**（小写十六进制）。
 *
 * hash（`MessageDigest("SHA-256")`）在 Android/JVM 全版本可用；
 * Ed25519 走 JCA `Signature.getInstance("Ed25519")`——Android 13（API 33）起标准 JCA
 * 才提供该算法，因此 [ManifestSignatureVerifier.isSupported] 做能力探测：
 * **不能验签的设备必须拒绝安装模型包**（不能退化成「只信 hash」——hash 就写在清单里，
 * 清单本身不被签名背书时 hash 自证不了来源），随后按不支持设备降级到词法/关键词档。
 */
interface ManifestSignatureVerifier {
    /** 当前运行环境能否执行 Ed25519 验签。 */
    fun isSupported(): Boolean

    /** 验证 `signatureBase64` 是否为 [payload] 在 [publicKeyPem]（SPKI/DER、PEM 编码）下的合法签名。 */
    fun verify(payload: ByteArray, signatureBase64: String, publicKeyPem: String): Boolean
}

/** JCA Ed25519 实现（PC `node:crypto#verify(null, …)` 同算法）。 */
class Ed25519ManifestSignatureVerifier : ManifestSignatureVerifier {

    override fun isSupported(): Boolean = try {
        Signature.getInstance(SIGNATURE_ALGORITHM)
        true
    } catch (error: Exception) {
        false
    }

    override fun verify(payload: ByteArray, signatureBase64: String, publicKeyPem: String): Boolean {
        return try {
            val signatureBytes = Base64.getDecoder().decode(signatureBase64)
            val publicKey = decodePemPublicKey(publicKeyPem) ?: return false
            val verifier = Signature.getInstance(SIGNATURE_ALGORITHM)
            verifier.initVerify(publicKey)
            verifier.update(payload)
            verifier.verify(signatureBytes)
        } catch (error: Exception) {
            // 与 PC `verifyManifestSignature` 的 catch→false 同口径：坏 key / 坏签名 / 坏编码都不是异常路径
            false
        }
    }

    private fun decodePemPublicKey(publicKeyPem: String): java.security.PublicKey? {
        val base64 = publicKeyPem
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("-----") }
            .joinToString("")
        if (base64.isEmpty()) return null
        val der = try {
            Base64.getDecoder().decode(base64)
        } catch (error: IllegalArgumentException) {
            return null
        }
        val keySpec = X509EncodedKeySpec(der)
        return KeyFactory.getInstance(KEY_ALGORITHM).generatePublic(keySpec)
    }

    companion object {
        const val SIGNATURE_ALGORITHM = "Ed25519"
        const val KEY_ALGORITHM = "Ed25519"
    }
}

/** sha256 → 小写十六进制（与 PC `sha256File` 的 digest('hex') 同口径）。 */
fun sha256Hex(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return buildString(digest.size * 2) {
        for (byte in digest) append((byte.toInt() and 0xFF).toString(16).padStart(2, '0'))
    }
}

/** 签名校验结论（拒装理由要能区分「签名不对」与「设备验不了签」）。 */
sealed class SignatureCheck {
    object Valid : SignatureCheck()
    data class Invalid(val message: String) : SignatureCheck()
    data class Unsupported(val message: String) : SignatureCheck()
}

/** 逐文件校验结论（大小/hash 要分开报，用户看到的下一步不同）。 */
sealed class FileVerification {
    object Ok : FileVerification()
    data class Rejected(val reason: Reason, val message: String) : FileVerification() {
        enum class Reason { MISSING, SIZE_MISMATCH, HASH_MISMATCH }
    }
}

/** 模型包校验器：清单验签 + 逐文件大小/sha256。 */
object ModelPackageVerifier {

    /** 清单验签（签名内容 = [EmbeddingModelManifest.signingPayload]）。 */
    fun verifyManifestSignature(
        manifest: EmbeddingModelManifest,
        publicKeyPem: String,
        verifier: ManifestSignatureVerifier,
    ): SignatureCheck {
        if (!verifier.isSupported()) {
            return SignatureCheck.Unsupported(
                "本设备无法验证模型包签名（缺少 Ed25519 支持），已拒绝安装：不验签的模型包不能信任其 hash",
            )
        }
        val payload = manifest.signingPayload().toByteArray(Charsets.UTF_8)
        val valid = verifier.verify(payload, manifest.catalogSignature, publicKeyPem)
        return if (valid) SignatureCheck.Valid
        else SignatureCheck.Invalid("模型清单签名无效: ${manifest.id}@${manifest.version}")
    }

    /**
     * 逐文件校验（PC `verifyFiles`）：先大小后 hash。
     * [fileContents] 是暂存区内 path → 字节。
     */
    fun verifyFiles(
        manifest: EmbeddingModelManifest,
        fileContents: Map<String, ByteArray>,
    ): FileVerification {
        for (file in manifest.files) {
            val bytes = fileContents[file.path]
                ?: return FileVerification.Rejected(
                    FileVerification.Rejected.Reason.MISSING,
                    "模型文件缺失: ${file.path}",
                )
            if (bytes.size.toLong() != file.size) {
                return FileVerification.Rejected(
                    FileVerification.Rejected.Reason.SIZE_MISMATCH,
                    "模型文件大小不匹配: ${file.path}",
                )
            }
            if (sha256Hex(bytes) != file.sha256) {
                return FileVerification.Rejected(
                    FileVerification.Rejected.Reason.HASH_MISMATCH,
                    "模型文件 hash 不匹配: ${file.path}",
                )
            }
        }
        return FileVerification.Ok
    }
}
