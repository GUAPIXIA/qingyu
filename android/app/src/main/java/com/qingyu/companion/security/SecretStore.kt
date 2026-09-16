package com.qingyu.companion.security

/**
 * 阶段 3：连接档案秘密引用。明文只进 Keystore 包装，不进 Room/日志/toString。
 */
data class SecretRef(val alias: String) {
    override fun toString(): String = "SecretRef(alias=***)"
}

interface SecretStore {
    fun put(alias: String, plain: ByteArray): SecretRef
    fun get(ref: SecretRef): ByteArray?
    fun delete(ref: SecretRef)
    fun exists(ref: SecretRef): Boolean
}

/** 内存实现：仅单测；生产用 Keystore wrapping（ADR-010）。 */
class InMemorySecretStore : SecretStore {
    private val map = mutableMapOf<String, ByteArray>()

    override fun put(alias: String, plain: ByteArray): SecretRef {
        map[alias] = plain.copyOf()
        return SecretRef(alias)
    }

    override fun get(ref: SecretRef): ByteArray? = map[ref.alias]?.copyOf()

    override fun delete(ref: SecretRef) {
        map.remove(ref.alias)
    }

    override fun exists(ref: SecretRef): Boolean = map.containsKey(ref.alias)
}

/**
 * public 档案更新与 secret 分离：
 * updatePublic 不得触碰 secret；secret 保存失败时旧值保留。
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
