package com.qingyu.companion.embedding

/**
 * 阶段 6 S6-05 第 2 档：**模型包安装**——原文四条硬要求里的三条在此落地：
 * 签名/hash 校验、断点续传、空间预检（第四条「卸载影响提示」在 [ModelPackageUninstall]）。
 *
 * 流程对齐 PC `electron/services/localModels/manager.ts`：
 * 1. 清单解析与完整校验（不合法直接拒，不开始下载）；
 * 2. 应用版本下限检查（`minimumAppVersion`）；
 * 3. **空间预检**：`max(installedSize, 文件合计) × 1.1` 不足即拒（PC `preflight` 同公式）；
 * 4. 清单 **Ed25519 验签**（验不了签的设备拒装，见 [ManifestSignatureVerifier]）；
 * 5. 逐文件**断点续传**下载（`.part` 断点、`Range: bytes=N-`、服务器不支持 Range 则整文件重来、
 *    多镜像顺序回退；中断只丢当前传输，已收字节保留为断点）；
 * 6. **大小 + sha256 逐文件校验**，全部通过才提交安装（PC `verifyFiles` 同顺序）。
 *
 * 纯逻辑 + 接口接缝：[ModelPackageStore] 管字节与空间，[ModelPackageSource] 管 HTTP，
 * 测试用替身逐字节核对拼接结果，不需要真机与外网。
 */

/** 模型包存储接缝（暂存区 `.part` 断点 / 完成文件 / 提交安装）。 */
interface ModelPackageStore {
    /** 可用空间字节数（空间预检的输入）。 */
    fun freeSpaceBytes(): Long

    /** 断点文件已收字节数（0 = 无断点）。 */
    fun partialSize(modelId: String, version: String, path: String): Long

    /** 追加一块断点字节（断点续传的拼接原语）。 */
    fun appendPartial(modelId: String, version: String, path: String, chunk: ByteArray)

    /** 读出断点文件当前全部字节（拼接正确性的核对入口 + 传输完成后的收尾）。 */
    fun readPartial(modelId: String, version: String, path: String): ByteArray

    /** 丢弃断点文件（服务器忽略 Range / 断点比文件还大时）。 */
    fun discardPartial(modelId: String, version: String, path: String)

    /** 已完成的暂存文件（null = 不存在）。 */
    fun stagedFile(modelId: String, version: String, path: String): ByteArray?

    fun writeStaged(modelId: String, version: String, path: String, bytes: ByteArray)

    fun discardStaged(modelId: String, version: String, path: String)

    /** 全部校验通过后提交：暂存区 → 模型目录（含清单快照）。 */
    fun commit(modelId: String, version: String, manifestJson: String, files: Map<String, ByteArray>)
}

/** 模型包下载源接缝（HTTP Range 语义）。 */
interface ModelPackageSource {
    /**
     * 打开 `[startInclusive, …)` 的下载流。
     * [ModelPackageChunkReader.resumed] 表示服务器是否用 206 续传；
     * false（200 全量）时调用方会丢弃断点、从全量内容重新拼接（PC 同款处理）。
     */
    fun open(url: String, startInclusive: Long): ModelPackageChunkReader
}

interface ModelPackageChunkReader {
    val resumed: Boolean

    /** 下一块字节；null = 传输结束。中断抛 [ModelPackageDownloadException]，已收字节保留为断点。 */
    fun nextChunk(): ByteArray?
}

/** 传输中断（超时/断线/镜像 5xx），携带的信息进入 `所有下载镜像均失败` 的原因链。 */
class ModelPackageDownloadException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** 空间预检结论（界面可在开始下载前展示）。 */
data class SpaceCheck(
    val ok: Boolean,
    val requiredBytes: Long,
    val freeBytes: Long,
    val message: String,
)

sealed class ModelPackageInstallResult {
    data class Completed(
        val modelId: String,
        val version: String,
        val totalBytes: Long,
        /** 断点续传成功的文件数（读数：让用户知道续传真的发生了）。 */
        val resumedFiles: Int,
    ) : ModelPackageInstallResult()

    data class Rejected(val reason: Reason, val message: String) : ModelPackageInstallResult() {
        enum class Reason {
            INVALID_MANIFEST,
            APP_VERSION_TOO_LOW,
            SIGNATURE_INVALID,
            SIGNATURE_UNSUPPORTED,
            SPACE_INSUFFICIENT,
            DOWNLOAD_FAILED,
            SIZE_MISMATCH,
            HASH_MISMATCH,
        }
    }
}

class ModelPackageInstaller(
    private val store: ModelPackageStore,
    private val source: ModelPackageSource,
    private val signatureVerifier: ManifestSignatureVerifier,
) {
    /**
     * 安装模型包。[manifestText] 是目录里的清单原文（保真保存，验签用
     * [EmbeddingModelManifest.signingPayload] 的 canonical JSON）。
     */
    fun install(
        manifestText: String,
        publicKeyPem: String,
        appVersion: String,
    ): ModelPackageInstallResult {
        val manifest = try {
            EmbeddingModelManifest.parseJson(manifestText)
        } catch (error: ModelPackageFormatException) {
            return reject(ModelPackageInstallResult.Rejected.Reason.INVALID_MANIFEST, error.message.orEmpty())
        }

        if (compareSemver(appVersion, manifest.minimumAppVersion) < 0) {
            return reject(
                ModelPackageInstallResult.Rejected.Reason.APP_VERSION_TOO_LOW,
                "应用版本过低，需要 ${manifest.minimumAppVersion} 或更高版本",
            )
        }

        // 空间预检在下载之前（不够就不要开始，别下到一半把用户磁盘吃光）
        val space = preflightSpace(manifest)
        if (!space.ok) {
            return reject(ModelPackageInstallResult.Rejected.Reason.SPACE_INSUFFICIENT, space.message)
        }

        when (val check = ModelPackageVerifier.verifyManifestSignature(manifest, publicKeyPem, signatureVerifier)) {
            is SignatureCheck.Invalid ->
                return reject(ModelPackageInstallResult.Rejected.Reason.SIGNATURE_INVALID, check.message)
            is SignatureCheck.Unsupported ->
                return reject(ModelPackageInstallResult.Rejected.Reason.SIGNATURE_UNSUPPORTED, check.message)
            SignatureCheck.Valid -> Unit
        }

        var resumedFiles = 0
        for (file in manifest.files) {
            when (val outcome = downloadFile(manifest, file)) {
                is DownloadOutcome.Failed ->
                    return reject(ModelPackageInstallResult.Rejected.Reason.DOWNLOAD_FAILED, outcome.message)
                is DownloadOutcome.Resumed -> resumedFiles++
                DownloadOutcome.Completed -> Unit
            }
        }

        val staged = mutableMapOf<String, ByteArray>()
        for (file in manifest.files) {
            val bytes = store.stagedFile(manifest.id, manifest.version, file.path)
                ?: return reject(
                    ModelPackageInstallResult.Rejected.Reason.SIZE_MISMATCH,
                    "模型文件缺失: ${file.path}",
                )
            staged[file.path] = bytes
        }
        when (val check = ModelPackageVerifier.verifyFiles(manifest, staged)) {
            is FileVerification.Rejected -> {
                val reason = when (check.reason) {
                    FileVerification.Rejected.Reason.HASH_MISMATCH ->
                        ModelPackageInstallResult.Rejected.Reason.HASH_MISMATCH
                    FileVerification.Rejected.Reason.SIZE_MISMATCH,
                    FileVerification.Rejected.Reason.MISSING,
                    -> ModelPackageInstallResult.Rejected.Reason.SIZE_MISMATCH
                }
                // 校验不过的文件不留在暂存区冒充成品（下次安装要么重下要么继续断点）
                for (file in manifest.files) store.discardStaged(manifest.id, manifest.version, file.path)
                return reject(reason, check.message)
            }
            FileVerification.Ok -> Unit
        }

        store.commit(manifest.id, manifest.version, manifestText, staged)
        return ModelPackageInstallResult.Completed(
            modelId = manifest.id,
            version = manifest.version,
            totalBytes = staged.values.fold(0L) { sum, bytes -> sum + bytes.size },
            resumedFiles = resumedFiles,
        )
    }

    /**
     * 空间预检（PC `preflight` 公式：`max(installedSize, 文件合计) × 1.1`）。
     * 文案带上需要/可用两个数字——「空间不足」不给数字，用户不知道该清多少。
     */
    fun preflightSpace(manifest: EmbeddingModelManifest): SpaceCheck {
        val filesTotal = manifest.files.sumOf { it.size }
        val required = (maxOf(manifest.installedSize, filesTotal) * SPACE_MARGIN).toLong()
        val free = store.freeSpaceBytes()
        val ok = free >= required
        return SpaceCheck(
            ok = ok,
            requiredBytes = required,
            freeBytes = free,
            message = if (ok) "空间充足：需要约 ${mb(required)} MB，可用 ${mb(free)} MB"
            else "可用空间不足：安装需要约 ${mb(required)} MB，当前可用 ${mb(free)} MB，请先清理空间后重试",
        )
    }

    private sealed class DownloadOutcome {
        object Completed : DownloadOutcome()
        data class Resumed(val path: String) : DownloadOutcome()
        data class Failed(val message: String) : DownloadOutcome()
    }

    /**
     * 单文件下载（PC `downloadFile` 语义）：
     * 已完成且校验通过的文件直接复用；`.part` 断点续传；服务器不支持 Range 则整文件重来；
     * 多镜像顺序回退，全部失败才报「所有下载镜像均失败」。
     */
    private fun downloadFile(manifest: EmbeddingModelManifest, file: EmbeddingModelManifest.ModelFile): DownloadOutcome {
        val modelId = manifest.id
        val version = manifest.version
        val staged = store.stagedFile(modelId, version, file.path)
        if (staged != null) {
            if (staged.size.toLong() == file.size && sha256Hex(staged) == file.sha256) {
                return DownloadOutcome.Completed // 上次已完成：不重下
            }
            store.discardStaged(modelId, version, file.path) // 损坏的成品不能留
        }

        if (file.urls.isEmpty()) return DownloadOutcome.Failed("模型文件没有在线下载源: ${file.path}")

        var lastError: Exception? = null
        var resumedThisFile = false
        for (url in file.urls) {
            try {
                // 断点长度在**每次镜像重试前**重算（PC 在 url 循环内读 .part 大小，同一口径）
                var start = store.partialSize(modelId, version, file.path)
                if (start > file.size) {
                    store.discardPartial(modelId, version, file.path)
                    start = 0
                }
                if (start > 0) resumedThisFile = true
                val reader = source.open(url, start)
                if (start > 0 && !reader.resumed) {
                    // 服务器忽略了 Range、给了全量内容：断点作废，用全量重新拼（PC 同款）
                    store.discardPartial(modelId, version, file.path)
                    resumedThisFile = false
                }
                while (true) {
                    val chunk = reader.nextChunk() ?: break
                    if (chunk.isEmpty()) continue
                    store.appendPartial(modelId, version, file.path, chunk)
                }
                val assembled = store.readPartial(modelId, version, file.path)
                store.writeStaged(modelId, version, file.path, assembled)
                store.discardPartial(modelId, version, file.path)
                return if (resumedThisFile) DownloadOutcome.Resumed(file.path) else DownloadOutcome.Completed
            } catch (error: ModelPackageDownloadException) {
                // 中断：断点（.part）原样保留，下一个镜像/下一次安装从这里续传
                lastError = error
            }
        }
        val reason = lastError?.message ?: "未知错误"
        return DownloadOutcome.Failed("所有下载镜像均失败: ${file.path}（$reason）")
    }

    private fun reject(
        reason: ModelPackageInstallResult.Rejected.Reason,
        message: String,
    ): ModelPackageInstallResult = ModelPackageInstallResult.Rejected(reason, message)

    private fun mb(bytes: Long): Long = bytes / 1024 / 1024

    companion object {
        /** 空间余量系数（PC `preflight` 的 1.1）。 */
        const val SPACE_MARGIN = 1.1

        /**
         * 简化 semver 比较（PC `compareVersions`）：逐段数值比较，预发布后缀不参与大小
         * （清单的 `minimumAppVersion` 不带预发布；带后缀时按主段比较，够判断「版本过低」）。
         */
        fun compareSemver(left: String, right: String): Int {
            val leftParts = versionSegments(left)
            val rightParts = versionSegments(right)
            for (index in 0 until maxOf(leftParts.size, rightParts.size)) {
                val l = leftParts.getOrElse(index) { 0 }
                val r = rightParts.getOrElse(index) { 0 }
                if (l != r) return l.compareTo(r)
            }
            return 0
        }

        private fun versionSegments(version: String): List<Long> =
            version.substringBefore('-').split('.').map { it.trim().toLongOrNull() ?: 0L }
    }
}
