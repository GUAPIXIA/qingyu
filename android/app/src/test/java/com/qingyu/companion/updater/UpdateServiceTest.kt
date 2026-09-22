package com.qingyu.companion.updater

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * S6-07 更新编排单测（红线）：
 * - 未经用户确认不触发安装（不得静默安装）；
 * - hash 校验失败 / 损坏包 / 缺失 checksum 一律拒绝安装并清理残留；
 * - 下载失败降级不抛错。
 */
class UpdateServiceTest {

    private lateinit var tempDir: File
    private val installer = FakeInstaller()
    private val downloader = FakeDownloader()
    private val pkg = UpdatePackage(
        versionName = "2.0.0",
        channel = ReleaseChannel.STABLE,
        downloadUrl = "https://example.com/update.apk",
    )

    @Before
    fun setUp() {
        tempDir = Files.createTempDirectory("qy-updater-service").toFile()
    }

    @After
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun service(
        releases: List<UpdatePackage> = listOf(pkg),
        currentVersion: String = "1.0.0",
        channel: ReleaseChannel = ReleaseChannel.STABLE,
    ) = UpdateService(
        currentVersionName = currentVersion,
        channel = channel,
        releaseSource = UpdateReleaseSource { releases },
        downloader = downloader,
        fileStore = LocalUpdateFileStore(File(tempDir, "staging")),
        installer = installer,
    )

    private fun validZipBytes(): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry("classes.dex"))
            zip.write(byteArrayOf(9, 8, 7, 6))
            zip.closeEntry()
        }
        return out.toByteArray()
    }

    // ---------- 红线：不得静默安装 ----------

    @Test
    fun `未经用户确认绝不触发安装`() = runTest {
        val apk = validZipBytes()
        downloader.bytes = apk
        downloader.text = UpdateVerifier.sha256(apk)
        val prepared = service().prepare(pkg)
        assertTrue("合法更新包应准备好安装", prepared is PrepareResult.Prepared)

        val result = service().install(prepared as PrepareResult.Prepared, UserConfirmation.NotConfirmed)
        assertTrue("未确认应停在等待确认状态", result is InstallResult.AwaitingUserConfirmation)
        assertTrue(
            "未经用户确认就触发安装等于静默安装（红线）",
            installer.installed.isEmpty(),
        )
    }

    @Test
    fun `用户确认后才进入系统安装确认流程`() = runTest {
        val apk = validZipBytes()
        downloader.bytes = apk
        downloader.text = UpdateVerifier.sha256(apk)
        val prepared = service().prepare(pkg) as PrepareResult.Prepared
        val result = service().install(prepared, UserConfirmation.Confirmed)
        assertTrue("确认后应进入系统安装确认流程", result is InstallResult.Started)
        assertEquals("确认后应恰好触发一次安装", 1, installer.installed.size)
        assertEquals("安装的应是校验通过的那个文件", prepared.file, installer.installed.single())
    }

    @Test
    fun `一步式流程未确认同样不安装`() = runTest {
        val apk = validZipBytes()
        downloader.bytes = apk
        downloader.text = UpdateVerifier.sha256(apk)
        val result = service().downloadAndInstall(pkg, UserConfirmation.NotConfirmed)
        assertTrue("未确认应停在等待确认状态", result is InstallResult.AwaitingUserConfirmation)
        assertTrue("未经确认就安装等于静默安装（红线）", installer.installed.isEmpty())
    }

    // ---------- 红线：hash 校验失败 / 损坏包 / 缺 checksum ----------

    @Test
    fun `hash校验失败拒绝安装并清理残留`() = runTest {
        val apk = validZipBytes()
        downloader.bytes = apk
        downloader.text = UpdateVerifier.sha256("tampered package".toByteArray()) // 与实包不符
        val result = service().prepare(pkg)
        assertTrue("hash 不符必须拒绝，否则可投毒升级包（红线）", result is PrepareResult.Rejected)
        assertTrue(
            "拒绝原因应是 hash 不符",
            (result as PrepareResult.Rejected).result is VerificationResult.HashMismatch,
        )
        assertTrue("被拒绝的包必须删除，不能留给安装器误用", File(tempDir, "staging").listFiles().isNullOrEmpty())
        assertTrue("拒绝后绝不能触发安装", installer.installed.isEmpty())

        val forced = service().downloadAndInstall(pkg, UserConfirmation.Confirmed)
        assertTrue("即使用户已确认，hash 不符也必须拒绝安装", forced is InstallResult.Failed)
        assertEquals("拒绝后仍触发安装等于放行投毒包（红线）", 0, installer.installed.size)
    }

    @Test
    fun `损坏更新包拒绝安装`() = runTest {
        val corrupt = "corrupt-package-bytes-not-a-zip".repeat(4)
        downloader.bytes = corrupt.toByteArray()
        downloader.text = UpdateVerifier.sha256(corrupt.toByteArray())
        val result = service().prepare(pkg)
        assertTrue("损坏的更新包必须拒绝（红线）", result is PrepareResult.Rejected)
        assertTrue(
            "拒绝原因应是包损坏",
            (result as PrepareResult.Rejected).result is VerificationResult.Corrupt,
        )
        assertTrue("损坏包必须删除，不能留在暂存区", File(tempDir, "staging").listFiles().isNullOrEmpty())
        assertTrue("损坏包绝不能触发安装", installer.installed.isEmpty())
    }

    @Test
    fun `缺失checksum拒绝安装且不开始下载`() = runTest {
        downloader.text = null
        val result = service().prepare(pkg)
        assertTrue("无可信 checksum 必须拒绝（fail closed）", result is PrepareResult.Rejected)
        assertTrue(
            "拒绝原因应是缺失 checksum",
            (result as PrepareResult.Rejected).result is VerificationResult.MissingChecksum,
        )
        assertTrue("都没校验和了不该先下大文件", downloader.downloads.isEmpty())
        assertTrue("缺失 checksum 绝不能触发安装", installer.installed.isEmpty())
    }

    @Test
    fun `checksum获取异常按缺失处理`() = runTest {
        downloader.textError = IOException("sidecar 500")
        val result = service().prepare(pkg)
        assertTrue("checksum 获取异常必须按缺失拒绝，不能默认放行", result is PrepareResult.Rejected)
        assertTrue(
            "拒绝原因应是缺失 checksum",
            (result as PrepareResult.Rejected).result is VerificationResult.MissingChecksum,
        )
    }

    // ---------- 降级与安装失败 ----------

    @Test
    fun `下载失败降级为稳定结果不抛错`() = runTest {
        downloader.text = "a".repeat(64)
        downloader.downloadError = IOException("network down")
        val result = service().prepare(pkg)
        assertTrue("下载失败应降级为稳定结果，不能把异常抛给 UI", result is PrepareResult.Failed)
        assertEquals("失败原因键被改动会让 UI 无法映射提示", "download_failed", (result as PrepareResult.Failed).reason)
        assertTrue("下载失败的残片必须清理", File(tempDir, "staging").listFiles().isNullOrEmpty())
    }

    @Test
    fun `安装异常降级为稳定结果不抛错`() = runTest {
        val apk = validZipBytes()
        downloader.bytes = apk
        downloader.text = UpdateVerifier.sha256(apk)
        val prepared = service().prepare(pkg) as PrepareResult.Prepared
        installer.error = IOException("session commit failed")
        val result = service().install(prepared, UserConfirmation.Confirmed)
        assertTrue("安装异常应降级为稳定结果", result is InstallResult.Failed)
        assertEquals("失败原因键被改动会让 UI 无法映射提示", "install_failed", (result as InstallResult.Failed).reason)
    }

    // ---------- 检查与渠道 ----------

    @Test
    fun `检查更新按发布渠道选包`() = runTest {
        val releases = listOf(
            UpdatePackage("2.0.0", ReleaseChannel.STABLE, "https://example.com/s.apk"),
            UpdatePackage("2.1.0", ReleaseChannel.BETA, "https://example.com/b.apk"),
        )
        val betaCheck = service(releases = releases, channel = ReleaseChannel.BETA).check()
        assertTrue("有新版本应报出来", betaCheck is UpdateCheckResult.UpdateAvailable)
        assertEquals("beta 渠道应拿到 beta 发布包", "2.1.0", (betaCheck as UpdateCheckResult.UpdateAvailable).pkg.versionName)

        val stableCheck = service(releases = releases).check()
        assertEquals(
            "stable 渠道应拿到 stable 发布包",
            "2.0.0",
            (stableCheck as UpdateCheckResult.UpdateAvailable).pkg.versionName,
        )

        val nightlyCheck = service(releases = releases, channel = ReleaseChannel.NIGHTLY).check()
        assertEquals(
            "nightly 无专属包时应安全回落 stable",
            "2.0.0",
            (nightlyCheck as UpdateCheckResult.UpdateAvailable).pkg.versionName,
        )
    }

    @Test
    fun `已是最新时报上架状态`() = runTest {
        val check = service(currentVersion = "2.0.0").check()
        assertTrue("同版本不应提示更新", check is UpdateCheckResult.UpToDate)
    }

    // ---------- 测试替身 ----------

    private class FakeDownloader : UpdateDownloadClient {
        var text: String? = null
        var bytes: ByteArray = ByteArray(0)
        var downloadError: Exception? = null
        var textError: Exception? = null
        val downloads = mutableListOf<String>()

        override suspend fun download(url: String, target: File): Long {
            downloads += url
            downloadError?.let { throw it }
            target.writeBytes(bytes)
            return bytes.size.toLong()
        }

        override suspend fun fetchText(url: String): String? {
            textError?.let { throw it }
            return text
        }
    }

    private class FakeInstaller : UpdateInstaller {
        val installed = mutableListOf<File>()
        var error: Exception? = null

        override fun install(apk: File) {
            error?.let { throw it }
            installed += apk
        }
    }
}
