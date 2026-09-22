package com.qingyu.companion.updater

/**
 * S6-07 应用更新模型（纯 Kotlin，JVM 可测）。
 *
 * 红线（阶段 6 实施方案 §S6-07）：
 * - 更新按发布渠道选择下载；
 * - 下载后必须通过 hash 校验（缺失 checksum 一律拒绝，fail closed）；
 * - **不得静默安装**：必须用户确认（[UserConfirmation.Confirmed]）才进入系统安装确认流程。
 */

/** 发布渠道 */
enum class ReleaseChannel {
    STABLE,
    BETA,
    NIGHTLY;

    companion object {
        /** 宽松解析（未知值回落 STABLE） */
        fun from(raw: String?): ReleaseChannel = when (raw?.trim()?.lowercase()) {
            "beta" -> BETA
            "nightly", "dev", "alpha" -> NIGHTLY
            else -> STABLE
        }
    }
}

/**
 * 一个发布包（来自版本接口 / 渠道清单）。
 * expectedSha256 为清单直接给出的校验和；null 表示需向 `<downloadUrl>.sha256` sidecar 取。
 */
data class UpdatePackage(
    val versionName: String,
    val channel: ReleaseChannel,
    val downloadUrl: String,
    val changelog: String = "",
    val expectedSha256: String? = null,
    val sizeBytes: Long? = null,
)

/** 更新检查结果（获取失败降级为 Unavailable，不抛错不崩） */
sealed interface UpdateCheckResult {
    /** 已是最新 */
    data class UpToDate(val currentVersion: String) : UpdateCheckResult

    /** 有可用更新 */
    data class UpdateAvailable(val pkg: UpdatePackage) : UpdateCheckResult

    /** 检查不可用（网络失败 / 服务器未配置 / 渠道无发布）；reason 为稳定原因键 */
    data class Unavailable(val reason: String) : UpdateCheckResult
}

/** 用户确认（不得静默安装：只有 Confirmed 才允许进入安装） */
enum class UserConfirmation {
    /** 未确认：绝不触发安装 */
    NotConfirmed,

    /** 用户明确确认：可进入系统安装确认流程 */
    Confirmed,
}

/** 下载 + 校验结果 */
sealed interface PrepareResult {
    /** 校验通过、可用于安装（只有它能进入 [UpdateService.install]） */
    data class Prepared(
        val file: java.io.File,
        val actualSha256: String,
        val pkg: UpdatePackage,
    ) : PrepareResult

    /** 拒绝（hash 不符 / 包损坏 / 无 checksum）；staging 文件已删除 */
    data class Rejected(val result: VerificationResult) : PrepareResult

    /** 下载失败等降级（不抛错不崩） */
    data class Failed(val reason: String) : PrepareResult
}

/** 校验结果 */
sealed interface VerificationResult {
    /** 通过（actualSha256 为实测哈希） */
    data class Ok(val actualSha256: String) : VerificationResult

    /** hash 校验失败 → 拒绝安装 */
    data class HashMismatch(val expected: String, val actual: String) : VerificationResult

    /** 更新包损坏（非 APK/ZIP 形态、结构不完整）→ 拒绝安装 */
    data class Corrupt(val reason: String) : VerificationResult

    /** 缺失可信 checksum → 拒绝安装（fail closed） */
    data object MissingChecksum : VerificationResult
}

/** 安装结果 */
sealed interface InstallResult {
    /** 已进入系统安装确认流程（系统仍会弹确认界面，绝不静默） */
    data object Started : InstallResult

    /** 未经用户确认 → 不触发安装 */
    data object AwaitingUserConfirmation : InstallResult

    /** 安装流程失败（稳定原因键） */
    data class Failed(val reason: String) : InstallResult
}
