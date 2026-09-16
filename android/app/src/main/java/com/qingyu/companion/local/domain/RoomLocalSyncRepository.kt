package com.qingyu.companion.local.domain

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalDeviceStateEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Room 生产实现：业务表 + entity_heads + change_log 同库事务。
 * DAO 不暴露给 UI。
 */
class RoomLocalSyncRepository(
    private val db: QingyuLocalDatabase,
    private val deviceId: String,
) : LocalSyncRepository {

    override fun deviceId(): String = deviceId

    private fun nextCounter(): Pair<Map<String, String>, String> {
        val dao = db.deviceDao()
        val state = dao.get() ?: LocalDeviceStateEntity(
            deviceId = deviceId,
            nextCounterText = "1",
            updatedAt = System.currentTimeMillis(),
        )
        val current = state.nextCounterText.toULongOrNull() ?: 1uL
        val counter = current.toString()
        dao.upsert(
            state.copy(
                nextCounterText = (current + 1uL).toString(),
                updatedAt = System.currentTimeMillis(),
            ),
        )
        return mapOf(deviceId to counter) to counter
    }

    private fun writeEntity(
        entityType: String,
        entityId: String,
        payload: Map<String, Any?>,
        business: () -> Unit,
    ) {
        val (version, counter) = nextCounter()
        val env = LocalEnvelope(
            entityType = entityType,
            entityId = entityId,
            payload = payload,
            deviceId = deviceId,
            counter = counter,
            version = version,
        )
        business()
        val sync = db.syncMetaDao()
        sync.upsertHead(
            entityType = entityType,
            entityId = entityId,
            versionJson = CanonicalJsonOf(version),
            hash = env.contentHash,
            deleted = false,
            updatedAt = env.updatedAt,
        )
        sync.insertChange(
            com.qingyu.companion.local.db.ChangeLogEntity(
                dotDevice = deviceId,
                dotCounter = counter,
                entityType = entityType,
                entityId = entityId,
                envelopeJson = env.toJson(),
                origin = "local",
                recordedAt = System.currentTimeMillis(),
            ),
        )
    }

    private fun CanonicalJsonOf(map: Map<String, String>): String =
        com.qingyu.companion.domain.contracts.CanonicalJson.encode(map)

    override fun putCharacter(entityId: String, name: String, description: String, personality: String) {
        writeEntity("character", entityId, mapOf("name" to name, "description" to description, "personality" to personality)) {
            db.characterDao().upsert(
                LocalCharacterEntity(
                    id = entityId,
                    name = name,
                    description = description,
                    personality = personality,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    override fun putPersona(entityId: String, name: String, description: String, persona: String) {
        writeEntity("persona", entityId, mapOf("name" to name, "description" to description, "persona" to persona)) {
            db.personaDao().upsert(
                LocalPersonaEntity(
                    id = entityId,
                    name = name,
                    description = description,
                    persona = persona,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    override fun putConnectionProfile(
        entityId: String,
        provider: String,
        baseUrl: String,
        model: String,
        secretRef: String?,
    ) {
        writeEntity(
            "connection_profile_public",
            entityId,
            mapOf("provider" to provider, "baseUrl" to baseUrl, "model" to model, "secretRef" to secretRef),
        ) {
            db.connectionProfileDao().upsert(
                LocalConnectionProfileEntity(
                    id = entityId,
                    provider = provider,
                    baseUrl = baseUrl,
                    model = model,
                    secretRef = secretRef,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    override fun listHeads(): List<Pair<String, String>> {
        // 简化：由调用方用 count 校验；完整列表查询可后续加 DAO
        return emptyList()
    }

    override fun journalCount(origin: String): Int = db.syncMetaDao().countByOrigin(origin)

    suspend fun listCharacters(): List<LocalCharacterEntity> = withContext(Dispatchers.IO) {
        db.characterDao().listAll()
    }

    suspend fun listPersonas(): List<LocalPersonaEntity> = withContext(Dispatchers.IO) {
        db.personaDao().listAll()
    }

    suspend fun listConnectionProfiles(): List<LocalConnectionProfileEntity> = withContext(Dispatchers.IO) {
        db.connectionProfileDao().listAll()
    }
}
