package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * S6-05 模型包清单：校验规则逐条对齐 PC `validateManifest`，
 * canonical JSON 对齐 PC `manifestSigningPayload` 的载荷构造（验签的唯一事实源）。
 */
class EmbeddingModelManifestTest {

    private val payload = mapOf("model.onnx" to "权重字节".toByteArray())

    private fun expectInvalid(fields: Map<String, Any?>, expectedMessagePart: String) {
        try {
            EmbeddingModelManifest.parse(fields)
            fail("不合法清单必须拒绝：$expectedMessagePart")
        } catch (error: ModelPackageFormatException) {
            assertTrue(
                "拒绝理由要说清是哪条规则（用户/日志据此定位），实际：${error.message}",
                error.message.orEmpty().contains(expectedMessagePart),
            )
        }
    }

    @Test
    fun validManifestParsesWithTypedViews() {
        val manifest = EmbeddingModelManifest.parse(manifestFields(payload))
        assertEquals("bge-m3", manifest.id)
        assertEquals(1, manifest.files.size)
        assertEquals("model.onnx", manifest.files[0].path)
        assertEquals(payload.getValue("model.onnx").size.toLong(), manifest.files[0].size)
    }

    @Test
    fun pathTraversalAndUnsafePathsAreRejected() {
        for (bad in listOf("../evil.onnx", "/etc/passwd.onnx", "a/../../evil.onnx", "sub\\evil.onnx", "model.exe", "no-ext", "dir/./model.onnx")) {
            val fields = manifestFields(mapOf(bad to "x".toByteArray()))
            expectInvalid(fields, "模型文件路径不安全")
        }
    }

    @Test
    fun duplicateCaseInsensitivePathsAndBadHashAndBadUrlsAreRejected() {
        // 大小写重复：Windows/部分文件系统会当成同一文件，后写的会覆盖先写的
        expectInvalid(
            manifestFields(mapOf("model.onnx" to "a".toByteArray(), "MODEL.ONNX" to "b".toByteArray())),
            "模型文件路径重复",
        )
        val badHash = manifestFields(payload).toMutableMap()
        badHash["files"] = listOf(
            mapOf("path" to "model.onnx", "size" to 3L, "sha256" to "not-a-hash", "urls" to listOf("https://x.example/a")),
        )
        expectInvalid(badHash, "模型文件 hash 不合法")
        val badUrl = manifestFields(payload).toMutableMap()
        badUrl["files"] = listOf(
            mapOf("path" to "model.onnx", "size" to 3L, "sha256" to "a".repeat(64), "urls" to listOf("http://x.example/a")),
        )
        expectInvalid(badUrl, "模型下载地址不安全")
    }

    @Test
    fun missingSignatureAndBadEnvelopeFieldsAreRejected() {
        expectInvalid(manifestFields(payload, signature = ""), "模型清单缺少签名")
        expectInvalid(manifestFields(payload).toMutableMap().apply { put("schemaVersion", 2) }, "不支持的模型清单版本")
        expectInvalid(manifestFields(payload).toMutableMap().apply { put("id", "Bad ID") }, "模型 id 不合法")
        expectInvalid(manifestFields(payload).toMutableMap().apply { put("version", "v1") }, "模型版本必须使用 semver")
        expectInvalid(manifestFields(payload).toMutableMap().apply { put("runtime", "tflite") }, "仅支持 ONNX 数据模型")
        expectInvalid(
            manifestFields(payload, installedSizeOverride = 1),
            "文件总大小超过清单安装体积",
        )
    }

    @Test
    fun canonicalJsonSortsKeysLikeJsLocaleCompareNotCodeUnit() {
        // `displayName` 在忽略大小写序里排在 `dimensions` 之后（'s' > 'i'），
        // 但 JVM 码元序会把大写 D 的 displayName 排最前——那会让验签载荷与 PC 不一致、合法包验不过
        val json = canonicalJson(mapOf("displayName" to "甲", "dimensions" to 1, "dtype" to "q8", "description" to "乙"))
        assertEquals(
            "{\"description\":\"乙\",\"dimensions\":1,\"displayName\":\"甲\",\"dtype\":\"q8\"}",
            json,
        )
    }

    @Test
    fun canonicalJsonEscapesLikeJsonStringify() {
        assertEquals("普通字符串要带引号", "\"abc\"", jsonQuote("abc"))
        assertEquals("控制字符走小写十六进制转义", "\"a\\u0001b\"", jsonQuote("a\u0001b"))
        assertEquals("换行/引号/反斜杠走短转义", "\"a\\n\\\"\\\\b\"", jsonQuote("a\n\"\\b"))
        assertEquals("斜杠不转义（JS 不转义；JSONObject 会转义，不能用它生成验签载荷）", "\"a/b\"", jsonQuote("a/b"))
        assertEquals("非 ASCII 原样输出", "\"中文\"", jsonQuote("中文"))
    }

    @Test
    fun signingPayloadExcludesCatalogSignature() {
        val fields = manifestFields(payload, signature = "SIGNATURE-VALUE")
        val manifest = EmbeddingModelManifest.parse(fields)
        val signingPayload = manifest.signingPayload()
        assertFalse("验签载荷包含签名字段就成了自证（签名覆盖自身）", signingPayload.contains("catalogSignature"))
        assertFalse("签名值本身绝不能进载荷", signingPayload.contains("SIGNATURE-VALUE"))
        assertTrue("载荷必须是 canonical JSON（键序稳定，跨端验签才对得上）", signingPayload.startsWith("{"))
    }

    @Test
    fun weightsFingerprintChangesWhenAnyFileHashChanges() {
        val first = EmbeddingModelManifest.parse(manifestFields(mapOf("model.onnx" to "甲".toByteArray())))
        val second = EmbeddingModelManifest.parse(manifestFields(mapOf("model.onnx" to "乙".toByteArray())))
        val sameAgain = EmbeddingModelManifest.parse(manifestFields(mapOf("model.onnx" to "甲".toByteArray())))
        assertTrue(
            "权重内容变了指纹必须变，否则旧索引会被错误复用（换了模型还在用旧向量）",
            first.weightsFingerprint() != second.weightsFingerprint(),
        )
        assertEquals("同内容指纹必须稳定，否则每次启动都会白白重建索引", first.weightsFingerprint(), sameAgain.weightsFingerprint())
    }
}
