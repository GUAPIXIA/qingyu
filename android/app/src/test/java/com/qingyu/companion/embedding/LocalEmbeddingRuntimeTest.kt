package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-05 第 2 档：设备支持判定与本地运行时抽象。
 * 「不支持设备**明确**降级」的前提是「为什么不支持」说得清——每种原因都要有独立文案。
 */
class LocalEmbeddingRuntimeTest {

    private val manifest = EmbeddingModelManifest.parse(
        manifestFields(mapOf("model.onnx" to ByteArray(8) { it.toByte() }), recommendedMemoryMb = 1024),
    )

    private fun device(
        abis: List<String> = listOf("arm64-v8a"),
        apiLevel: Int = 34,
        totalMemoryMb: Long = 4096,
        allowed: Boolean = true,
    ) = DeviceCapability(abis = abis, apiLevel = apiLevel, totalMemoryMb = totalMemoryMb, localModelAllowed = allowed)

    @Test
    fun capableDeviceIsSupportedWithReadableNote() {
        val support = LocalRuntimeSupportPolicy.evaluate(device(), manifest)
        assertTrue("达标设备必须判支持（不许以「移动端不方便」砍功能）", support is LocalRuntimeSupport.Supported)
        val note = (support as LocalRuntimeSupport.Supported).note
        assertTrue("支持时也要有可读说明（设置页展示）：$note", note.contains("BGE M3 测试模型"))
    }

    @Test
    fun everyUnsupportedReasonHasItsOwnExplanation() {
        val disabled = LocalRuntimeSupportPolicy.evaluate(device(allowed = false), manifest) as LocalRuntimeSupport.Unsupported
        assertEquals(LocalRuntimeSupport.Unsupported.Reason.USER_DISABLED, disabled.reason)
        assertTrue("用户自己关的要直说，别吓唬成设备问题：${disabled.explanation}", disabled.explanation.contains("关闭"))

        val abi = LocalRuntimeSupportPolicy.evaluate(device(abis = listOf("mips")), manifest) as LocalRuntimeSupport.Unsupported
        assertEquals(LocalRuntimeSupport.Unsupported.Reason.ABI_UNSUPPORTED, abi.reason)
        assertTrue("ABI 不支持要列出设备与支持列表：${abi.explanation}", abi.explanation.contains("mips"))

        val api = LocalRuntimeSupportPolicy.evaluate(device(apiLevel = 21), manifest) as LocalRuntimeSupport.Unsupported
        assertEquals(LocalRuntimeSupport.Unsupported.Reason.API_TOO_LOW, api.reason)
        assertTrue("系统版本问题要给出下限：${api.explanation}", api.explanation.contains("Android 26"))

        val memory = LocalRuntimeSupportPolicy.evaluate(device(totalMemoryMb = 512), manifest) as LocalRuntimeSupport.Unsupported
        assertEquals("内存不足归资源不足档（后续走词法降级的原因文案不同）", LocalRuntimeSupport.Unsupported.Reason.MEMORY_BELOW_RECOMMENDED, memory.reason)
        assertTrue("内存不足要给出两个数字，用户才知道差多少：${memory.explanation}", memory.explanation.contains("512 MB") && memory.explanation.contains("1024 MB"))
    }

    @Test
    fun withoutManifestOnlyDeviceGateApplies() {
        // 还没选模型时不该拿某个模型的内存建议把设备判死
        val support = LocalRuntimeSupportPolicy.evaluate(device(totalMemoryMb = 256), manifest = null)
        assertTrue("未选模型时只要设备自身达标就算支持", support is LocalRuntimeSupport.Supported)
    }

    @Test
    fun localIndexChunkCharsFollowsPcFormula() {
        assertEquals("本地切片长度 = max(256, maxTokens×2)（PC resolveIndexChunkChars 同款）", 1024, localIndexChunkChars(manifest))
        val tiny = EmbeddingModelManifest.parse(manifestFields(mapOf("m.onnx" to ByteArray(1)), maxTokens = 8))
        assertEquals("下限 256：切太碎会让向量只看到残词", 256, localIndexChunkChars(tiny))
    }

    @Test
    fun localEmbedderAppliesSameTruncationAndRejectsMisalignedResults() {
        val runtime = FakeMobileEmbeddingRuntime().apply {
            embedScript = { texts -> texts.map { listOf(it.length.toDouble()) } }
        }
        val embedder = LocalModelEmbedder(runtime, manifest)
        val vectors = embedder.embed(listOf("甲甲甲"), EmbeddingInputKind.PASSAGE)
        assertEquals("本地与远程必须同一截断策略，否则两档切换后同一文本切出不同向量", listOf(listOf(3.0)), vectors)

        runtime.embedScript = { texts -> listOf(listOf(1.0)) } // 只回 1 条（输入 2 条）
        try {
            embedder.embed(listOf("甲", "乙"), EmbeddingInputKind.PASSAGE)
            throw AssertionError("返回数量不匹配必须失败：错位的向量会让检索静默失真")
        } catch (error: EmbeddingException) {
            assertEquals(EmbeddingFailureKind.INVALID_RESPONSE, error.kind)
        }
    }
}
