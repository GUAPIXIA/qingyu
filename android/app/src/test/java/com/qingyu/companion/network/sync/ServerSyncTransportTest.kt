package com.qingyu.companion.network.sync

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * S8-04 Android ServerTransport：单飞语义、错误映射、取消、完整流。
 */
class ServerSyncTransportTest {

    private fun jsonOf(status: Int, body: String): Pair<Int, String> = status to body

    @Test
    fun runSyncFlowFollowsSessionPlanPushPullCommit() {
        val calls = mutableListOf<String>()
        val http = ServerSyncTransport.HttpExecutor { method, url, _, _ ->
            calls.add("$method $url")
            when {
                url.endsWith("/sync/v1/sessions") && method == "POST" ->
                    jsonOf(201, """{"sessionId":"s1","state":"open","protocolVersion":1,"expiresAt":1}""")
                url.endsWith("/plan") ->
                    jsonOf(200, """{"upload":0,"download":0,"conflicts":0,"estimatedBytes":0,"items":[],"quota":{"usedEntities":0,"maxEntities":1,"usedCiphertextBytes":0,"maxCiphertextBytes":1}}""")
                url.endsWith("/push") ->
                    jsonOf(200, """{"batchId":"b","accepted":1,"rejected":0,"cursor":"1"}""")
                url.endsWith("/pull") ->
                    jsonOf(
                        200,
                        """{"batchId":"p","envelopes":[{"entityType":"character","entityId":"e1","parentId":null,"schemaVersion":1,"version":{"android_b":"1"},"versionHash":"sha256:${"a".repeat(64)}","dot":{"deviceId":"android_b","counter":"1"},"deleted":false,"updatedAt":1,"keyEpoch":1,"cipherRevision":1,"cipherHash":"sha256:${"b".repeat(64)}","contentTag":"t","ciphertext":"Yw==","serverSeq":"1"}],"nextCursor":"1","hasMore":false}""",
                    )
                url.endsWith("/commit") ->
                    jsonOf(200, """{"sessionId":"s1","committedAt":1,"vector":{"android_b":"1"},"serverSeq":"1"}""")
                else -> jsonOf(404, """{"error":{"code":"NOT_FOUND","message":"x","retryable":false,"requestId":"r"}}""")
            }
        }
        val transport = ServerSyncTransport(
            baseUrl = "https://relay.example",
            accessTokenProvider = { "tok" },
            http = http,
            retryBaseMs = 1,
            maxRetries = 1,
        )
        val receipt = kotlinx.coroutines.runBlocking {
            transport.runSyncFlow(
                deviceId = "android_b",
                collectUpload = {
                    listOf(
                        ServerSyncTransport.WireEntity(
                            entityType = "character",
                            entityId = "e0",
                            parentId = null,
                            schemaVersion = 1,
                            version = mapOf("android_b" to "1"),
                            versionHash = "sha256:" + "c".repeat(64),
                            dotDevice = "android_b",
                            dotCounter = "1",
                            deleted = false,
                            updatedAt = 1L,
                            keyEpoch = 1,
                            cipherRevision = 1,
                            cipherHash = "sha256:" + "d".repeat(64),
                            contentTag = "t",
                            ciphertext = "Yw==",
                        ),
                    )
                },
                applyDownload = { mapOf("android_b" to "1") },
            )
        }
        assertEquals("s1", receipt.getString("sessionId"))
        assertTrue(calls.any { it.endsWith("/push") })
        assertTrue(calls.any { it.endsWith("/commit") })
    }

    @Test
    fun nonRetryableDeviceRevokedDoesNotBlindRetry() {
        var n = 0
        val http = ServerSyncTransport.HttpExecutor { _, _, _, _ ->
            n++
            jsonOf(403, """{"error":{"code":"DEVICE_REVOKED","message":"设备已吊销","retryable":false,"requestId":"r1"}}""")
        }
        val transport = ServerSyncTransport(
            baseUrl = "https://x",
            accessTokenProvider = { "t" },
            http = http,
            retryBaseMs = 1,
            maxRetries = 3,
        )
        try {
            kotlinx.coroutines.runBlocking { transport.createSession("d") }
            fail("应当抛出")
        } catch (e: ServerSyncTransport.ServerTransportException) {
            assertEquals("DEVICE_REVOKED", e.code)
            assertEquals(false, e.retryable)
        }
        assertEquals(1, n)
    }

    @Test
    fun cancelRejectsFurtherWork() {
        val transport = ServerSyncTransport(
            baseUrl = "https://x",
            accessTokenProvider = { "t" },
            http = ServerSyncTransport.HttpExecutor { _, _, _, _ -> jsonOf(200, "{}") },
        )
        transport.cancel()
        try {
            kotlinx.coroutines.runBlocking { transport.createSession("d") }
            fail("应当抛出 CANCELLED")
        } catch (e: ServerSyncTransport.ServerTransportException) {
            assertEquals("CANCELLED", e.code)
        }
    }

    @Test
    fun wireEntityRoundTripJson() {
        val e = ServerSyncTransport.WireEntity(
            entityType = "character",
            entityId = "e1",
            parentId = null,
            schemaVersion = 3,
            version = mapOf("android_b" to "4"),
            versionHash = "sha256:" + "a".repeat(64),
            dotDevice = "android_b",
            dotCounter = "4",
            deleted = false,
            updatedAt = 1789550000000L,
            keyEpoch = 1,
            cipherRevision = 1,
            cipherHash = "sha256:" + "b".repeat(64),
            contentTag = "tag",
            ciphertext = "Y2lwaGVy",
        )
        val back = ServerSyncTransport.WireEntity.fromJson(JSONObject(e.toJson().toString()))
        assertEquals(e, back)
    }
}
