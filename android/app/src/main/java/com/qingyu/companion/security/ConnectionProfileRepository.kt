package com.qingyu.companion.security

import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.domain.LocalStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * 阶段 3 S3-06：连接档案的 public / secret 双事务写入。
 *
 * 硬要求：
 * - public 字段与 secret 必须是**两个明确事务**；
 * - secret 保存失败时绝不能用空值覆盖旧 secret；
 * - UI 只能看到掩码与「已配置/未配置」。
 */
class ConnectionProfileRepository(
    private val store: LocalStore,
    private val secrets: SecretStore,
) {

    /** 秘密别名与连接档案绑定；档案被删时同步删除别名。 */
    fun secretAlias(profileId: String): String = "conn.$profileId.apiKey"

    fun observeProfiles(): Flow<List<LocalConnectionProfileEntity>> = store.observeConnectionProfiles()

    /** UI 视图模型：不含任何秘密，只含「是否已配置」。 */
    fun observeProfileViews(): Flow<List<ConnectionProfileView>> =
        store.observeConnectionProfiles().map { list ->
            list.sortedWith(compareBy({ it.sortIndex }, { it.id })).map { it.toView(secrets) }
        }

    suspend fun listProfiles(): List<LocalConnectionProfileEntity> = store.listConnectionProfiles()

    suspend fun listViews(): List<ConnectionProfileView> =
        store.listConnectionProfiles()
            .sortedWith(compareBy({ it.sortIndex }, { it.id }))
            .map { it.toView(secrets) }

    suspend fun getProfile(id: String): LocalConnectionProfileEntity? = store.getConnectionProfile(id)

    /**
     * 保存 public 字段。**不触碰 secret**：即使调用方传入 `secretRef` 也会被忽略，
     * secret 只能经 [saveSecret] / [clearSecret] 两个独立事务变更。
     */
    suspend fun savePublic(
        id: String,
        displayName: String,
        provider: String,
        baseUrl: String,
        model: String,
        enabled: Boolean = true,
        sortIndex: Int = 0,
        allowHttp: Boolean = false,
        capabilitiesJson: String = "{}",
    ) {
        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = id,
                provider = provider,
                baseUrl = baseUrl,
                model = model,
                displayName = displayName,
                enabled = enabled,
                sortIndex = sortIndex,
                allowHttp = allowHttp,
                capabilitiesJson = capabilitiesJson,
                secretRef = null,
                createdAt = 0,
                updatedAt = 0,
            ),
        )
    }

    /**
     * 保存 secret：先写 secret 存储，成功后才更新引用。
     * 任一步失败都抛出且旧 secret 保持可用。
     */
    suspend fun saveSecret(profileId: String, plain: String) {
        if (plain.isEmpty()) throw IllegalArgumentException("拒绝以空值保存 API Key")
        val ref = secrets.put(secretAlias(profileId), plain.toByteArray(Charsets.UTF_8))
        store.setConnectionSecret(profileId, ref.alias)
    }

    suspend fun clearSecret(profileId: String) {
        val existing = store.getConnectionProfile(profileId)?.secretRef ?: return
        secrets.delete(SecretRef(existing))
        store.setConnectionSecret(profileId, null)
    }

    suspend fun readSecret(profileId: String): String? {
        val alias = store.getConnectionProfile(profileId)?.secretRef ?: return null
        val bytes = secrets.get(SecretRef(alias)) ?: return null
        return bytes.toString(Charsets.UTF_8)
    }

    suspend fun secretConfigured(profileId: String): Boolean {
        val alias = store.getConnectionProfile(profileId)?.secretRef ?: return false
        return secrets.exists(SecretRef(alias))
    }

    /** 删除档案时同步清理秘密别名，避免残留密文。 */
    suspend fun deleteProfile(profileId: String) {
        store.getConnectionProfile(profileId)?.secretRef?.let { secrets.delete(SecretRef(it)) }
        store.deleteConnectionProfile(profileId)
    }

    /** 排序：整体重写 sortIndex；不动 public 的其他字段与 secret。 */
    suspend fun reorder(orderedIds: List<String>) {
        val byId = store.listConnectionProfiles().associateBy { it.id }
        orderedIds.forEachIndexed { index, id ->
            val existing = byId[id] ?: return@forEachIndexed
            store.upsertConnectionProfile(
                existing.copy(sortIndex = index, secretRef = null, updatedAt = 0),
            )
        }
    }
}

/** UI 视图模型（掩码）；绝不含明文秘密。 */
data class ConnectionProfileView(
    val id: String,
    val displayName: String,
    val provider: String,
    val baseUrl: String,
    val model: String,
    val enabled: Boolean,
    val sortIndex: Int,
    val allowHttp: Boolean,
    val secretConfigured: Boolean,
) {
    /** 只显示尾部 4 位的掩码；无秘密时显示「未配置」。 */
    fun maskedSecretHint(): String = if (secretConfigured) "已配置（••••）" else "未配置"

    override fun toString(): String = "ConnectionProfileView(id=$id, provider=$provider, model=$model, secret=***)"
}

private fun LocalConnectionProfileEntity.toView(secrets: SecretStore): ConnectionProfileView =
    ConnectionProfileView(
        id = id,
        displayName = displayName.ifBlank { model.ifBlank { provider } },
        provider = provider,
        baseUrl = baseUrl,
        model = model,
        enabled = enabled,
        sortIndex = sortIndex,
        allowHttp = allowHttp,
        secretConfigured = secretRef?.let { secrets.exists(SecretRef(it)) } == true,
    )

/**
 * 兼容层：阶段 3 早期的内存实现（`Phase3LocalDomainTest` 与阶段 4 之前的调用点）。
 * 生产路径使用 [ConnectionProfileRepository]；本类不再被 AppContainer 装配。
 */
data class ConnectionProfilePublic(
    val id: String,
    val provider: String,
    val baseUrl: String,
    val model: String,
    val enabled: Boolean = true,
)

class ConnectionProfileStore(
    private val secrets: SecretStore,
) {
    private val publicProfiles = mutableMapOf<String, ConnectionProfilePublic>()
    private val secretRefs = mutableMapOf<String, SecretRef>()

    fun savePublic(profile: ConnectionProfilePublic) {
        publicProfiles[profile.id] = profile
    }

    /** secret 保存失败时抛出，旧 secret 保持不变 */
    fun saveSecret(profileId: String, apiKey: String) {
        val alias = "conn-$profileId-apiKey"
        secrets.put(alias, apiKey.toByteArray(Charsets.UTF_8))
        secretRefs[profileId] = SecretRef(alias)
    }

    fun readSecret(profileId: String): String? {
        val ref = secretRefs[profileId] ?: return null
        val bytes = secrets.get(ref) ?: return null
        return bytes.toString(Charsets.UTF_8)
    }

    fun secretConfigured(profileId: String): Boolean = secretRefs[profileId]?.let { secrets.exists(it) } == true

    fun getPublic(profileId: String): ConnectionProfilePublic? = publicProfiles[profileId]

    fun delete(profileId: String) {
        secretRefs[profileId]?.let { secrets.delete(it) }
        secretRefs.remove(profileId)
        publicProfiles.remove(profileId)
    }

    fun listPublic(): List<ConnectionProfilePublic> = publicProfiles.values.sortedBy { it.id }
}
