package com.qingyu.companion.network.sync

/**
 * 阶段 7 S7-05/S7-07：LAN 同步完整流（openSession → push → prepare → commit → pull）。
 *
 * 仅由用户点击同步中心「开始同步」调用；加密/解密在进入 transport 前完成
 * （LAN 通道内 payload 为信封；服务器模式见 [ServerSyncTransport]）。
 */
class LanSyncRunner(
    private val transport: LanSyncTransport,
    private val endpointProvider: () -> SyncEndpoint?,
    private val authorized: () -> Boolean,
    private val collectUpload: suspend () -> List<SyncEnvelopeDto>,
    private val applyDownload: suspend (List<SyncEnvelopeDto>) -> Map<String, String>,
    private val batchSizeItems: Int = 200,
) {

    @Volatile
    private var cancelled = false

    fun cancel() {
        cancelled = true
        transport.pause()
    }

    suspend fun run(
        onProgress: (phase: String, sent: Int, received: Int) -> Unit = { _, _, _ -> },
    ): SyncRunResult {
        cancelled = false
        transport.resume()
        if (!authorized()) {
            return SyncRunResult(ok = false, error = "LAN 未授权", retryable = false)
        }
        val endpoint = endpointProvider()
            ?: return SyncRunResult(ok = false, error = "LAN 端点未就绪", retryable = true)

        return try {
            onProgress("session", 0, 0)
            val handle = when (val r = transport.openSession(endpoint)) {
                is SyncTransportResult.Ok -> r.value
                is SyncTransportResult.Fail ->
                    return SyncRunResult(ok = false, error = r.message.ifEmpty { r.code }, retryable = r.retryable)
            }

            val upload = collectUpload()
            onProgress("push", 0, 0)
            var sent = 0
            val batchIds = mutableListOf<String>()
            val batches = transport.splitBatches(upload, idPrefix = "up")
            for (batch in batches) {
                if (cancelled) return SyncRunResult(ok = false, error = "cancelled", retryable = false)
                when (val r = transport.pushBatch(handle, batch.copy(envelopes = batch.envelopes.take(batchSizeItems)))) {
                    is SyncTransportResult.Ok -> {
                        batchIds += batch.batchId
                        sent += batch.envelopes.size
                        onProgress("push", sent, 0)
                    }
                    is SyncTransportResult.Fail ->
                        return SyncRunResult(
                            ok = false,
                            error = r.message.ifEmpty { r.code },
                            retryable = r.retryable,
                            uploaded = sent,
                        )
                }
            }

            onProgress("prepare", sent, 0)
            if (batchIds.isNotEmpty()) {
                when (val r = transport.prepare(handle, batchIds)) {
                    is SyncTransportResult.Ok -> Unit
                    is SyncTransportResult.Fail ->
                        return SyncRunResult(ok = false, error = r.message.ifEmpty { r.code }, retryable = r.retryable, uploaded = sent)
                }
            }

            onProgress("pull", sent, 0)
            val downloaded = mutableListOf<SyncEnvelopeDto>()
            var cursor: String? = null
            while (true) {
                if (cancelled) return SyncRunResult(ok = false, error = "cancelled", retryable = false, uploaded = sent)
                val page = when (val r = transport.pull(handle, cursor)) {
                    is SyncTransportResult.Ok -> r.value
                    is SyncTransportResult.Fail ->
                        return SyncRunResult(
                            ok = false,
                            error = r.message.ifEmpty { r.code },
                            retryable = r.retryable,
                            uploaded = sent,
                            downloaded = downloaded.size,
                        )
                }
                downloaded += page.envelopes
                onProgress("pull", sent, downloaded.size)
                cursor = page.nextCursor
                if (!page.hasMore) break
            }

            onProgress("validate", sent, downloaded.size)
            val vector = applyDownload(downloaded)

            onProgress("commit", sent, downloaded.size)
            val batchId = batchIds.firstOrNull() ?: "empty-${handle.sessionId}"
            when (val r = transport.commit(handle, batchId)) {
                is SyncTransportResult.Ok -> Unit
                is SyncTransportResult.Fail -> {
                    // commit 响应丢失：用 receipt 查询恢复（方案 §7.2）
                    val recovered = transport.fetchReceipt(handle, batchId)
                    if (recovered is SyncTransportResult.Fail && recovered.code == "receipt_not_found") {
                        return SyncRunResult(
                            ok = false,
                            error = r.message.ifEmpty { r.code },
                            retryable = r.retryable,
                            uploaded = sent,
                            downloaded = downloaded.size,
                        )
                    }
                }
            }
            onProgress("done", sent, downloaded.size)
            // vector 供 receipt 记账；LAN 首版由上层写 device ack
            SyncRunResult(ok = true, uploaded = sent, downloaded = downloaded.size)
        } catch (e: Exception) {
            SyncRunResult(
                ok = false,
                error = e.message ?: e.javaClass.simpleName,
                retryable = true,
            )
        }
    }
}
