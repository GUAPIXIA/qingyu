package com.qingyu.companion.updater

import com.qingyu.companion.model.VersionInfo
import java.io.File
import kotlinx.coroutines.CancellationException

/**
 * S6-07 应用更新编排（纯逻辑 + 接口抽象，JVM 可测）：
 * 检查（按发布渠道）→ 下载 → hash 校验 + 损坏包识别 → **用户确认** → 系统安装确认。
 *
 * 降级约定：版本获取失败 / 服务器未配置 / 下载失败都返回稳定原因键的降级结果，
 * 不抛错不崩；公告与版本检查在离线时同样可降级（见 ui/announcements/AnnouncementFeed）。
 */

/** 版本信息源（窄接口，适配 ChatRepository.fetchVersionInfo） */
fun interface VersionInfoSource {
    suspend fun fetch(): VersionInfo?
}

/** 发布清单源（按渠道提供候选包） */
fun interface UpdateReleaseSource {
    suspend fun releases(): List<UpdatePackage>
}

/**
 * 版本接口适配：`/api/v1/version` 的 Android 字段视为 STABLE 渠道发布包。
 * expectedSha256 置 null → 下载前向 `<downloadUrl>.sha256` sidecar 取可信校验和。
 */
class VersionInfoReleaseSource(
    private val source: VersionInfoSource,
    private val channel: ReleaseChannel = ReleaseChannel.STABLE,
) : UpdateReleaseSource {
    override suspend fun releases(): List<UpdatePackage> {
        val info = source.fetch() ?: return emptyList()
        val url = info.effectiveDownloadUrl.trim()
        if (url.isBlank()) return emptyList()
        return listOf(
            UpdatePackage(
                versionName = info.effectiveVersion.trim(),
                channel = channel,
                downloadUrl = url,
                changelog = info.effectiveChangelog,
            ),
        )
    }
}

class UpdateService(
    private val currentVersionName: String,
    private val channel: ReleaseChannel,
    private val releaseSource: UpdateReleaseSource,
    private val downloader: UpdateDownloadClient,
    private val fileStore: UpdateFileStore,
    private val installer: UpdateInstaller,
) {

    /** 检查更新（离线/接口失败 → Unavailable，不崩） */
    suspend fun check(): UpdateCheckResult {
        val releases = try {
            releaseSource.releases()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return UpdateCheckResult.Unavailable("version_fetch_failed")
        }
        if (releases.isEmpty()) return UpdateCheckResult.Unavailable("no_release_info")
        val picked = UpdatePolicy.selectForChannel(releases, channel)
            ?: return UpdateCheckResult.Unavailable("no_release_for_channel")
        return if (UpdatePolicy.isNewer(picked.versionName, currentVersionName)) {
            UpdateCheckResult.UpdateAvailable(picked)
        } else {
            UpdateCheckResult.UpToDate(currentVersionName)
        }
    }

    /**
     * 下载 + 校验（hash 校验失败 / 损坏包 / 无 checksum 一律 Rejected 且清理残留；
     * 下载异常降级为 Failed）。
     */
    suspend fun prepare(pkg: UpdatePackage): PrepareResult {
        val expected = resolveChecksum(pkg)
            ?: return PrepareResult.Rejected(VerificationResult.MissingChecksum)
        val file = fileStore.stagingFile(pkg)
        try {
            downloader.download(pkg.downloadUrl, file)
        } catch (e: CancellationException) {
            fileStore.delete(file)
            throw e
        } catch (_: Exception) {
            fileStore.delete(file)
            return PrepareResult.Failed("download_failed")
        }
        return when (val verification = UpdateVerifier.verifyFile(file, expected)) {
            is VerificationResult.Ok -> PrepareResult.Prepared(file, verification.actualSha256, pkg)
            else -> {
                fileStore.delete(file)
                PrepareResult.Rejected(verification)
            }
        }
    }

    /**
     * 安装（红线：不得静默安装）。
     * 未经 [UserConfirmation.Confirmed] **不触发安装**；确认后进入系统安装确认流程
     * （PackageInstaller commit 的系统弹窗是第二道用户确认）。
     */
    fun install(prepared: PrepareResult.Prepared, confirmation: UserConfirmation): InstallResult =
        when (confirmation) {
            UserConfirmation.NotConfirmed -> InstallResult.AwaitingUserConfirmation
            UserConfirmation.Confirmed -> try {
                installer.install(prepared.file)
                InstallResult.Started
            } catch (e: Exception) {
                InstallResult.Failed("install_failed")
            }
        }

    /** 一步式流程（UI 用）：下载校验 + 确认门；Rejection/Failed 均不触发安装 */
    suspend fun downloadAndInstall(pkg: UpdatePackage, confirmation: UserConfirmation): InstallResult =
        when (val prepared = prepare(pkg)) {
            is PrepareResult.Prepared -> install(prepared, confirmation)
            is PrepareResult.Rejected -> InstallResult.Failed("rejected:${describe(prepared.result)}")
            is PrepareResult.Failed -> InstallResult.Failed(prepared.reason)
        }

    /** 可信 checksum：优先包清单自带，其次 `<downloadUrl>.sha256` sidecar；都取不到 → null（拒绝） */
    private suspend fun resolveChecksum(pkg: UpdatePackage): String? {
        UpdatePolicy.parseChecksumText(pkg.expectedSha256)?.let { return it }
        val sidecar = try {
            downloader.fetchText(pkg.downloadUrl + CHECKSUM_SIDECAR_SUFFIX)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        return UpdatePolicy.parseChecksumText(sidecar)
    }

    private fun describe(result: VerificationResult): String = when (result) {
        is VerificationResult.Ok -> "ok"
        is VerificationResult.HashMismatch -> "hash_mismatch"
        is VerificationResult.Corrupt -> "corrupt:${result.reason}"
        is VerificationResult.MissingChecksum -> "missing_checksum"
    }

    private companion object {
        const val CHECKSUM_SIDECAR_SUFFIX = ".sha256"
    }
}

/** staging 目录便捷工厂（app filesDir/update 由装配方指定） */
fun defaultUpdateFileStore(root: File): UpdateFileStore = LocalUpdateFileStore(root)
