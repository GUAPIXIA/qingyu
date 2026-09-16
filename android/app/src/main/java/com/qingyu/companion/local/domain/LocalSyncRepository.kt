package com.qingyu.companion.local.domain

import com.qingyu.companion.domain.contracts.CanonicalJson
import java.security.MessageDigest

/**
 * 阶段 3 本地 Repository：业务写 + entity_heads + change_log。
 * Room 实现与内存实现共用此接口；UI 只暴露该层。
 */
data class LocalEnvelope(
    val entityType: String,
    val entityId: String,
    val payload: Map<String, Any?>,
    val deviceId: String,
    val counter: String,
    val version: Map<String, String>,
    val deleted: Boolean = false,
    val updatedAt: Long = System.currentTimeMillis(),
    val contentHash: String = sha256Hex(CanonicalJson.encode(if (deleted) emptyMap<String, Any?>() else payload)),
) {
    fun toJson(): String = CanonicalJson.encode(
        mapOf(
            "contractVersion" to 1,
            "entityType" to entityType,
            "entityId" to entityId,
            "deleted" to deleted,
            "updatedAt" to updatedAt,
            "contentHash" to contentHash,
            "version" to version,
            "dot" to mapOf("deviceId" to deviceId, "counter" to counter),
            "payload" to payload,
        ),
    )
}

fun sha256Hex(text: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
    return buildString(digest.size * 2) {
        digest.forEach { append("%02x".format(it)) }
    }
}

interface LocalSyncRepository {
    fun deviceId(): String

    fun putCharacter(entityId: String, name: String, description: String = "", personality: String = "")

    fun putPersona(entityId: String, name: String, description: String = "", persona: String = "")

    fun putConnectionProfile(
        entityId: String,
        provider: String,
        baseUrl: String,
        model: String,
        secretRef: String?,
    )

    fun listHeads(): List<Pair<String, String>>

    fun journalCount(origin: String): Int
}

/** 便于 JVM 单测的内存实现（与 PC InMemorySyncRepository 语义对齐的子集）。 */
class InMemoryLocalSyncRepository(
    private val deviceId: String = "android-local",
) : LocalSyncRepository {
    private var nextCounter = 1L
    private val heads = mutableMapOf<Pair<String, String>, Pair<Map<String, String>, String>>()
    private val changes = mutableListOf<Triple<String, String, LocalEnvelope>>()
    private val characters = mutableMapOf<String, Map<String, Any?>>()
    private val personas = mutableMapOf<String, Map<String, Any?>>()
    private val profiles = mutableMapOf<String, Map<String, Any?>>()

    override fun deviceId(): String = deviceId

    private fun bump(): Pair<Map<String, String>, String> {
        val counter = nextCounter.toString()
        nextCounter += 1
        return mapOf(deviceId to counter) to counter
    }

    private fun put(entityType: String, entityId: String, payload: Map<String, Any?>) {
        val (version, counter) = bump()
        val env = LocalEnvelope(
            entityType = entityType,
            entityId = entityId,
            payload = payload,
            deviceId = deviceId,
            counter = counter,
            version = version,
        )
        heads[entityType to entityId] = version to env.contentHash
        changes.add(Triple("local", entityType, env))
        when (entityType) {
            "character" -> characters[entityId] = payload
            "persona" -> personas[entityId] = payload
            "connection_profile_public" -> profiles[entityId] = payload
        }
    }

    override fun putCharacter(entityId: String, name: String, description: String, personality: String) {
        put("character", entityId, mapOf("name" to name, "description" to description, "personality" to personality))
    }

    override fun putPersona(entityId: String, name: String, description: String, persona: String) {
        put("persona", entityId, mapOf("name" to name, "description" to description, "persona" to persona))
    }

    override fun putConnectionProfile(
        entityId: String,
        provider: String,
        baseUrl: String,
        model: String,
        secretRef: String?,
    ) {
        put(
            "connection_profile_public",
            entityId,
            mapOf(
                "provider" to provider,
                "baseUrl" to baseUrl,
                "model" to model,
                "secretRef" to secretRef,
            ),
        )
    }

    override fun listHeads(): List<Pair<String, String>> =
        heads.keys.map { (t, id) -> t to id }

    override fun journalCount(origin: String): Int = changes.count { it.first == origin }

    fun getCharacter(id: String): Map<String, Any?>? = characters[id]
    fun getPersona(id: String): Map<String, Any?>? = personas[id]
    fun getProfile(id: String): Map<String, Any?>? = profiles[id]
}
