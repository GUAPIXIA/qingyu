package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * S6-05 第 1 档：远程 OpenAI-compatible / Ollama 嵌入客户端。
 *
 * 钉死四件事：失败分类（降级判定要据此选通道）、批量与顺序、
 * 批内原位填充（M-3 那类「文本 i 配上文本 i+1 的向量」的静默失真）、
 * 鉴权本地注入不外泄。
 */
class RemoteEmbeddingClientTest {

    // ---------- 批量 / 顺序 / 截断 ----------

    @Test
    fun batchingKeepsOrderAcrossBatchBoundary() {
        var call = 0
        val transport = FakeEmbeddingTransport { request ->
            // 从请求体数出输入条数，向量取 [全局下标] 以便核对顺序
            val count = request.body.substringAfter("\"input\":[").substringBefore("]").split(",").size
            val start = call * EmbeddingProtocols.BATCH_SIZE
            call++
            val vectors = (0 until count).map { listOf((start + it).toDouble()) }
            EmbeddingHttpResponse(200, openAiResponse(vectors))
        }
        val client = RemoteEmbeddingClient(transport, openAiConfig())
        val texts = (0 until 33).map { "文本$it" }
        val vectors = client.embed(texts, EmbeddingInputKind.PASSAGE)

        assertEquals("32 条一批：33 条必须拆成 2 个请求，否则会超出服务端批量限制", 2, transport.requests.size)
        assertEquals("返回向量必须与输入等长，否则下游会把向量配错文本", 33, vectors.size)
        assertEquals(
            "跨批顺序不能错位：文本 i 必须拿回自己的向量",
            (0 until 33).map { listOf(it.toDouble()) },
            vectors,
        )
    }

    @Test
    fun queryKeepsTailWhilePassageKeepsHead() {
        val text = "头".repeat(20) + "尾".repeat(20)
        val query = EmbeddingProtocols.truncateEmbeddingInput(text, EmbeddingInputKind.QUERY, max = 10)
        val passage = EmbeddingProtocols.truncateEmbeddingInput(text, EmbeddingInputKind.PASSAGE, max = 10)
        assertEquals("查询要保留最新尾部（最新上下文最重要）", "尾".repeat(10), query)
        assertEquals("索引文档保留开头（标题/开头信息密度最高）", "头".repeat(10), passage)
    }

    // ---------- 鉴权本地注入 ----------

    @Test
    fun apiKeyOnlyGoesIntoAuthHeaderAndNeverLeaks() {
        val transport = FakeEmbeddingTransport { EmbeddingHttpResponse(200, openAiResponse(listOf(listOf(1.0, 0.0)))) }
        val secret = "sk-super-secret"
        val client = RemoteEmbeddingClient(transport, openAiConfig(apiKey = secret))
        client.embed(listOf("测试"), EmbeddingInputKind.PASSAGE)

        val request = transport.requests.single()
        assertEquals("鉴权必须本地注入到 Authorization 头，否则 OpenAI 兼容服务会 401", "Bearer $secret", request.headers["Authorization"])
        assertFalse("请求体出现凭据会被中间日志/抓包放大泄漏面", request.body.contains(secret))
        assertFalse("URL 出现凭据会被代理与服务端访问日志记录", request.url.contains(secret))
        assertFalse(
            "日志描述出现凭据就等于把 key 写进日志",
            EmbeddingProtocols.describeForLog(openAiConfig(apiKey = secret)).contains(secret),
        )
    }

    @Test
    fun ollamaRequestCarriesNoAuthorizationHeader() {
        val transport = FakeEmbeddingTransport { EmbeddingHttpResponse(200, ollamaResponse(listOf(listOf(1.0)))) }
        RemoteEmbeddingClient(transport, ollamaConfig()).embed(listOf("测试"), EmbeddingInputKind.QUERY)
        val request = transport.requests.single()
        assertTrue("Ollama 协议不鉴权：多发 Authorization 头会被部分网关当非法请求拒掉", !request.headers.containsKey("Authorization"))
        assertTrue("Ollama 端点是 /api/embed，走错端点会 404", request.url.endsWith("/api/embed"))
    }

    // ---------- 响应解析（M-3 同类错位防线） ----------

    @Test
    fun openAiResponseIsFilledByIndexNotByOrder() {
        val transport = FakeEmbeddingTransport {
            // 故意乱序 + 缺失：index 1 的先回来，index 2 缺失
            val body = "{\"data\":[" +
                "{\"index\":1,\"embedding\":[0,1]}," +
                "{\"index\":0,\"embedding\":[1,0]}" +
                "]}"
            EmbeddingHttpResponse(200, body)
        }
        val vectors = RemoteEmbeddingClient(transport, openAiConfig())
            .embed(listOf("甲", "乙", "丙"), EmbeddingInputKind.PASSAGE)

        assertEquals("向量必须按 index 原位对齐文本（整体前移会让检索静默失真）", listOf(1.0, 0.0), vectors[0])
        assertEquals("乱序返回也必须对回原文本", listOf(0.0, 1.0), vectors[1])
        assertEquals("缺失项补零向量而不是错配邻居的向量", listOf(0.0, 0.0), vectors[2])
    }

    @Test
    fun ollamaShortResultIsZeroFilledWithoutShiftingLaterBatches() {
        val transport = FakeEmbeddingTransport { request ->
            val count = request.body.substringAfter("\"input\":[").substringBefore("]").split(",").size
            // 只返回一半的向量：既测补齐，也测不移位
            EmbeddingHttpResponse(200, ollamaResponse((0 until count / 2).map { listOf(1.0, 0.0) }))
        }
        val vectors = RemoteEmbeddingClient(transport, ollamaConfig())
            .embed(listOf("甲", "乙"), EmbeddingInputKind.PASSAGE)
        assertEquals("数量不匹配时宁可补零也不许把向量前移错配文本", listOf(1.0, 0.0), vectors[0])
        assertEquals("缺失的那条必须是零向量占位", listOf(0.0, 0.0), vectors[1])
    }

    // ---------- 失败分类 ----------

    private fun classifyStatus(status: Int): EmbeddingFailureKind {
        val transport = FakeEmbeddingTransport { EmbeddingHttpResponse(status, "错误正文") }
        return try {
            RemoteEmbeddingClient(transport, openAiConfig()).embed(listOf("测试"), EmbeddingInputKind.PASSAGE)
            fail("非 2xx 必须抛错而不是静默返回空向量（静默空向量会让检索永远不命中且无从排查）")
            EmbeddingFailureKind.HTTP_ERROR
        } catch (error: EmbeddingException) {
            error.kind
        }
    }

    @Test
    fun httpStatusesClassifyIntoDistinctFailureKinds() {
        assertEquals("401/403 是凭据问题：换通道没用，要提示用户改 key", EmbeddingFailureKind.AUTH_FAILED, classifyStatus(401))
        assertEquals("403 同样是鉴权失败", EmbeddingFailureKind.AUTH_FAILED, classifyStatus(403))
        assertEquals("429 是限流：应当可重试/降级而不是判死服务", EmbeddingFailureKind.RATE_LIMITED, classifyStatus(429))
        assertEquals("408 是超时，与网络不可达的处置不同", EmbeddingFailureKind.TIMEOUT, classifyStatus(408))
        assertEquals("504 网关超时同样归超时", EmbeddingFailureKind.TIMEOUT, classifyStatus(504))
        assertEquals("5xx 是服务端错误，可重试", EmbeddingFailureKind.HTTP_ERROR, classifyStatus(500))
    }

    @Test
    fun transportErrorsClassifyIntoTimeoutAndNetwork() {
        val timedOut = try {
            RemoteEmbeddingClient(ThrowingEmbeddingTransport(EmbeddingTransportException("读超时", timedOut = true)), openAiConfig())
                .embed(listOf("测试"), EmbeddingInputKind.PASSAGE)
            fail("传输异常必须上抛")
            EmbeddingFailureKind.NETWORK
        } catch (error: EmbeddingException) {
            error.kind
        }
        assertEquals("传输超时要与网络不可达分开：前者等一会就能重试", EmbeddingFailureKind.TIMEOUT, timedOut)

        val network = try {
            RemoteEmbeddingClient(ThrowingEmbeddingTransport(EmbeddingTransportException("连接被拒")), openAiConfig())
                .embed(listOf("测试"), EmbeddingInputKind.PASSAGE)
            fail("传输异常必须上抛")
            EmbeddingFailureKind.NETWORK
        } catch (error: EmbeddingException) {
            error.kind
        }
        assertEquals("连接被拒归网络不可达", EmbeddingFailureKind.NETWORK, network)
    }

    @Test
    fun malformedResponseAndBadConfigClassifySeparately() {
        val badJson = try {
            RemoteEmbeddingClient(FakeEmbeddingTransport { EmbeddingHttpResponse(200, "<html>不是 JSON</html>") }, openAiConfig())
                .embed(listOf("测试"), EmbeddingInputKind.PASSAGE)
            fail("响应不是 JSON 必须失败")
            EmbeddingFailureKind.NETWORK
        } catch (error: EmbeddingException) {
            error.kind
        }
        assertEquals("2xx 但坏响应体是响应格式问题，不是网络问题", EmbeddingFailureKind.INVALID_RESPONSE, badJson)

        val notConfigured = try {
            RemoteEmbeddingClient(FakeEmbeddingTransport { EmbeddingHttpResponse(200, "{}") }, openAiConfig(apiKey = " "))
                .embed(listOf("测试"), EmbeddingInputKind.PASSAGE)
            fail("缺 apiKey 的 OpenAI 兼容配置必须在发请求前失败")
            EmbeddingFailureKind.NETWORK
        } catch (error: EmbeddingException) {
            error.kind
        }
        assertEquals("没配置就该报「未配置」，让用户去设置页而不是反复重试", EmbeddingFailureKind.NOT_CONFIGURED, notConfigured)

        val localProvider = try {
            RemoteEmbeddingClient(FakeEmbeddingTransport { EmbeddingHttpResponse(200, "{}") }, ollamaConfig().copy(provider = "local", model = "bge-m3@1.0.0"))
                .embed(listOf("测试"), EmbeddingInputKind.PASSAGE)
            fail("local 提供方不能走远程客户端")
            EmbeddingFailureKind.NETWORK
        } catch (error: EmbeddingException) {
            error.kind
        }
        assertEquals("local 提供方走错入口是配置错误", EmbeddingFailureKind.MISCONFIGURED, localProvider)
    }

    @Test
    fun oneFailedBatchFailsTheWholeRequest() {
        var batch = 0
        val transport = FakeEmbeddingTransport {
            batch++
            if (batch == 2) EmbeddingHttpResponse(500, "boom") else EmbeddingHttpResponse(200, openAiResponse(listOf(listOf(1.0))))
        }
        try {
            RemoteEmbeddingClient(transport, openAiConfig())
                .embed(List(EmbeddingProtocols.BATCH_SIZE + 1) { "文本$it" }, EmbeddingInputKind.PASSAGE)
            fail("任一批失败必须整体失败：只成功一半会让索引一半新一半旧，且没有任何读数")
        } catch (error: EmbeddingException) {
            assertEquals(EmbeddingFailureKind.HTTP_ERROR, error.kind)
        }
    }

    // ---------- 连接测试 ----------

    @Test
    fun testConnectionReportsDimensionOrExplainableError() {
        val ok = RemoteEmbeddingClient(
            FakeEmbeddingTransport { EmbeddingHttpResponse(200, openAiResponse(listOf(listOf(1.0, 0.0, 0.0)))) },
            openAiConfig(),
        ).testConnection()
        assertTrue("连接成功必须报 ok", ok.ok)
        assertEquals("返回维度供设置页展示", 3, ok.dimensions)

        val broken = RemoteEmbeddingClient(
            FakeEmbeddingTransport { EmbeddingHttpResponse(200, openAiResponse(listOf(emptyList()))) },
            openAiConfig(),
        ).testConnection()
        assertFalse("空向量不算连接成功，否则用户会以为配置可用", broken.ok)
        assertEquals("错误要能解释为什么失败", "嵌入服务未返回有效向量", broken.error)
    }
}
