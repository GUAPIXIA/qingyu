package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-05 模型包安装的四条硬要求里的三条（签名/hash、断点续传、空间预检）
 * 加上「旧断点不能配错文本」这类**拼接正确性**边界。
 *
 * 所有断言都核对**字节级结果**：拼接错一块，hash 就对不上，用户会以为包坏了。
 */
class ModelPackageInstallerTest {

    private val modelBytes = ByteArray(40) { it.toByte() } // 40 字节，7 字节一块 → 6 块
    private val fileContent = mapOf("model.onnx" to modelBytes)

    private data class Fixture(
        val installer: ModelPackageInstaller,
        val store: InMemoryModelPackageStore,
        val source: FakeModelPackageSource,
        val manifestJson: String,
        val publicKeyPem: String,
    )

    /**
     * 构造安装环境。[servedBytes] 是下载源实际给的字节（与清单 hash 不同即模拟篡改）；
     * [urls] 可配多镜像。
     */
    private fun fixture(
        freeSpace: Long = 10_000_000,
        installedSizeOverride: Long? = null,
        servedBytes: ByteArray = modelBytes,
        urls: List<String> = listOf("https://models.example.com/pkg"),
    ): Fixture {
        val keyPair = generateEd25519KeyPair()
        val fields = signManifestFields(
            manifestFields(fileContent, urls = urls, installedSizeOverride = installedSizeOverride),
            keyPair.private,
        )
        val store = InMemoryModelPackageStore(freeSpace)
        val source = FakeModelPackageSource(servedBytes, chunkSize = 7)
        val installer = ModelPackageInstaller(store, source, FakeManifestSignatureVerifier(supported = true, valid = true))
        return Fixture(installer, store, source, canonicalJson(fields), publicKeyPem(keyPair.public))
    }

    // ---------- 空间预检（硬要求） ----------

    @Test
    fun insufficientSpaceIsRefusedBeforeAnyDownload() {
        // installedSize 放大到 10 MB：×1.1 后约 11 MB > 可用 5 MB
        val fixture = fixture(freeSpace = 5L * 1024 * 1024, installedSizeOverride = 10L * 1024 * 1024)
        val result = fixture.installer.install(fixture.manifestJson, fixture.publicKeyPem, "2.0.0")

        assertTrue("空间不足必须拒绝安装", result is ModelPackageInstallResult.Rejected)
        result as ModelPackageInstallResult.Rejected
        assertEquals("拒因要与「下载失败」区分，用户才知道该清理空间", ModelPackageInstallResult.Rejected.Reason.SPACE_INSUFFICIENT, result.reason)
        assertTrue("提示要给出需要的空间，否则用户不知道该清多少：${result.message}", result.message.contains("安装需要约"))
        assertTrue("提示要给出当前可用空间：${result.message}", result.message.contains("当前可用"))
        assertTrue("空间不足时一个字节都不该开始下", fixture.source.calls.isEmpty())
    }

    @Test
    fun spacePreflightMarginMatchesPcFormula() {
        val fixture = fixture()
        val manifest = EmbeddingModelManifest.parseJson(fixture.manifestJson)
        val check = fixture.installer.preflightSpace(manifest)
        val expected = (modelBytes.size.toDouble() * ModelPackageInstaller.SPACE_MARGIN).toLong()
        assertEquals(
            "空间预检公式要与 PC preflight 一致（1.1 倍余量），不一致会在同一台设备上一个能装一个不能装",
            expected,
            check.requiredBytes,
        )
        assertTrue("空间够时结论必须是 ok（否则模型永远装不上）", check.ok)
        assertTrue("预检文案要带数字", check.message.contains("MB"))
    }

    // ---------- 签名 / hash（硬要求） ----------

    @Test
    fun hashMismatchIsRefusedAndStagedBytesAreDiscarded() {
        val tampered = modelBytes.copyOf().also { it[0] = (it[0] + 1).toByte() }
        val fixture = fixture(servedBytes = tampered) // 清单 hash 按原件算，下载到的字节被换过
        val result = fixture.installer.install(fixture.manifestJson, fixture.publicKeyPem, "2.0.0")

        assertTrue("被篡改的模型包必须拒绝安装", result is ModelPackageInstallResult.Rejected)
        result as ModelPackageInstallResult.Rejected
        assertEquals("hash 不符必须单独成档（是安全事件，不是网络重试能解决的）", ModelPackageInstallResult.Rejected.Reason.HASH_MISMATCH, result.reason)
        assertTrue("错误要带文件名：${result.message}", result.message.contains("model.onnx"))
        assertTrue("校验不过的文件不能留在暂存区冒充成品", fixture.store.staged.isEmpty())
    }

    @Test
    fun invalidSignatureOrUnsupportedDeviceRefusesInstall() {
        val fixture = fixture()
        val badSignature = ModelPackageInstaller(
            fixture.store,
            fixture.source,
            FakeManifestSignatureVerifier(supported = true, valid = false),
        )
        val rejected = badSignature.install(fixture.manifestJson, fixture.publicKeyPem, "2.0.0") as ModelPackageInstallResult.Rejected
        assertEquals("签名不符必须拒绝", ModelPackageInstallResult.Rejected.Reason.SIGNATURE_INVALID, rejected.reason)

        val unsupported = ModelPackageInstaller(
            InMemoryModelPackageStore(10_000_000),
            FakeModelPackageSource(modelBytes),
            FakeManifestSignatureVerifier(supported = false),
        )
        val unsupportedResult = unsupported.install(fixture.manifestJson, fixture.publicKeyPem, "2.0.0") as ModelPackageInstallResult.Rejected
        assertEquals(
            "验不了签的设备要与「签名不对」分开报（前者是设备能力，后者是包有问题）",
            ModelPackageInstallResult.Rejected.Reason.SIGNATURE_UNSUPPORTED,
            unsupportedResult.reason,
        )
    }

    // ---------- 断点续传（硬要求） ----------

    @Test
    fun resumeReassemblesChunksCorrectlyAcrossInstallRuns() {
        val fixture = fixture()
        // 第一轮：收到 14 字节后传输中断
        fixture.source.failAfterBytes = 14
        val first = fixture.installer.install(fixture.manifestJson, fixture.publicKeyPem, "2.0.0")
        assertTrue("传输中断应报下载失败（可重试），而不是当包损坏", first is ModelPackageInstallResult.Rejected)
        assertEquals(
            "中断是可续传的失败，不能与 hash/签名类拒因混档",
            ModelPackageInstallResult.Rejected.Reason.DOWNLOAD_FAILED,
            (first as ModelPackageInstallResult.Rejected).reason,
        )
        assertEquals(
            "断点必须保留已收的 14 字节，否则续传无从谈起",
            14,
            fixture.store.readPartial("bge-m3", "1.0.0", "model.onnx").size,
        )

        // 第二轮：从断点续传
        fixture.source.failAfterBytes = null
        val resumedCallsBefore = fixture.source.calls.size
        val second = fixture.installer.install(fixture.manifestJson, fixture.publicKeyPem, "2.0.0")
        assertTrue("续传后必须安装成功", second is ModelPackageInstallResult.Completed)
        second as ModelPackageInstallResult.Completed

        val resumeCall = fixture.source.calls[resumedCallsBefore]
        assertEquals("续传必须带断点偏移（Range: bytes=14-），从 0 重下说明续传没生效", 14L, resumeCall.second)
        assertEquals(
            "续传块拼接后必须与原文件逐字节一致",
            modelBytes.toList(),
            fixture.store.committed["bge-m3_model.onnx"]!!.toList(),
        )
        assertEquals("安装成功的总字节数要与原文件一致", modelBytes.size.toLong(), second.totalBytes)
        assertEquals("续传发生的文件数要能读出来（给界面/日志）", 1, second.resumedFiles)
    }

    @Test
    fun serverIgnoringRangeRestartsFromScratchWithoutCorruption() {
        val fixture = fixture()
        fixture.source.failAfterBytes = 14
        fixture.installer.install(fixture.manifestJson, fixture.publicKeyPem, "2.0.0")

        // 服务器不支持 Range（resumed=false、返回全量）：断点必须作废、全量重拼
        fixture.source.failAfterBytes = null
        fixture.source.respectRange = false
        val result = fixture.installer.install(fixture.manifestJson, fixture.publicKeyPem, "2.0.0")

        assertTrue("服务器忽略 Range 时应全量重下成功", result is ModelPackageInstallResult.Completed)
        assertEquals(
            "全量内容必须与原文件一致——不断点就拼接会得到「14 字节旧前缀 + 全量内容」的损坏文件",
            modelBytes.toList(),
            fixture.store.committed["bge-m3_model.onnx"]!!.toList(),
        )
    }

    @Test
    fun completedFilesAreReusedAndMirrorFallbackWorks() {
        // 主镜像全挂、备镜像可用：urls 顺序回退
        val keyPair = generateEd25519KeyPair()
        val fields = signManifestFields(
            manifestFields(fileContent, urls = listOf("https://bad.example.com/f", "https://good.example.com/f")),
            keyPair.private,
        )
        val store = InMemoryModelPackageStore(10_000_000)
        val source = FakeModelPackageSource(modelBytes, chunkSize = 7)
        var call = 0
        val flakySource = object : ModelPackageSource {
            override fun open(url: String, startInclusive: Long): ModelPackageChunkReader {
                call++
                if (call == 1) throw ModelPackageDownloadException("镜像 503")
                return source.open(url, startInclusive)
            }
        }
        val installer = ModelPackageInstaller(store, flakySource, FakeManifestSignatureVerifier(valid = true))
        val result = installer.install(canonicalJson(fields), publicKeyPem(keyPair.public), "2.0.0")
        assertTrue("主镜像失败必须回退到备镜像，而不是直接判死", result is ModelPackageInstallResult.Completed)

        // 已完成的文件第二次安装不重下
        val callsBefore = call
        val again = installer.install(canonicalJson(fields), publicKeyPem(keyPair.public), "2.0.0")
        assertTrue("已安装的包应走复用路径", again is ModelPackageInstallResult.Completed)
        assertEquals("文件校验通过后不该再发起下载（否则每次安装都全量重下）", callsBefore, call)
    }

    @Test
    fun allMirrorsFailingReportsEveryMirrorTried() {
        val keyPair = generateEd25519KeyPair()
        val fields = signManifestFields(
            manifestFields(fileContent, urls = listOf("https://a.example.com/f", "https://b.example.com/f")),
            keyPair.private,
        )
        val store = InMemoryModelPackageStore(10_000_000)
        var attempts = 0
        val deadSource = object : ModelPackageSource {
            override fun open(url: String, startInclusive: Long): ModelPackageChunkReader {
                attempts++
                throw ModelPackageDownloadException("镜像不可达: $url")
            }
        }
        val installer = ModelPackageInstaller(store, deadSource, FakeManifestSignatureVerifier(valid = true))
        val result = installer.install(canonicalJson(fields), publicKeyPem(keyPair.public), "2.0.0") as ModelPackageInstallResult.Rejected

        assertEquals(ModelPackageInstallResult.Rejected.Reason.DOWNLOAD_FAILED, result.reason)
        assertTrue("所有镜像都失败要说「所有下载镜像均失败」并带文件名：${result.message}", result.message.contains("所有下载镜像均失败"))
        assertTrue("两个镜像都必须试过", attempts == 2)
    }

    // ---------- 清单 / 版本门槛 ----------

    @Test
    fun invalidManifestAndLowAppVersionAreRefused() {
        val fixture = fixture()
        val invalid = fixture.installer.install("{不是清单", fixture.publicKeyPem, "2.0.0") as ModelPackageInstallResult.Rejected
        assertEquals("坏清单要在下载前拒绝", ModelPackageInstallResult.Rejected.Reason.INVALID_MANIFEST, invalid.reason)

        val lowVersion = fixture.installer.install(fixture.manifestJson, fixture.publicKeyPem, "0.9.0") as ModelPackageInstallResult.Rejected
        assertEquals(
            "应用版本低于 minimumAppVersion 必须拒装（旧运行时可能跑不了新模型）",
            ModelPackageInstallResult.Rejected.Reason.APP_VERSION_TOO_LOW,
            lowVersion.reason,
        )
        assertTrue("要告诉用户需要的版本：${lowVersion.message}", lowVersion.message.contains("1.0.0"))
    }

    @Test
    fun semverComparisonIsNumericNotLexicographic() {
        assertTrue("1.10.0 大于 1.9.0（字典序会判反，导致版本门槛失效）", ModelPackageInstaller.compareSemver("1.10.0", "1.9.0") > 0)
        assertTrue("同版本相等", ModelPackageInstaller.compareSemver("1.0.0", "1.0.0") == 0)
        assertTrue("2.0.0 大于 1.99.99", ModelPackageInstaller.compareSemver("2.0.0", "1.99.99") > 0)
    }
}
