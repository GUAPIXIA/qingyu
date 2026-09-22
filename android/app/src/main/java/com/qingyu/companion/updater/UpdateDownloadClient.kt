package com.qingyu.companion.updater

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * S6-07 更新下载抽象（接口 + 真实 HTTP 实现；测试用替身）。
 * 边界：只允许 http(s)、跟随同 host 重定向最多 3 次、写盘上限 [HttpUpdateDownloader.maxBytes]。
 */

/** 更新下载客户端（测试替身实现此接口） */
interface UpdateDownloadClient {
    /** 下载到目标文件；失败抛 [IOException]（由上层降级为 Failed，不崩） */
    suspend fun download(url: String, target: File): Long

    /** GET 小文本（checksum sidecar `<url>.sha256`）；失败返回 null */
    suspend fun fetchText(url: String): String?
}

/** staging 文件管理（应用私有目录；测试用临时目录） */
interface UpdateFileStore {
    /** 生成本次下载的 staging 文件（已存在则先删除） */
    fun stagingFile(pkg: UpdatePackage): File

    /** 删除（拒绝/失败后清理残留） */
    fun delete(file: File)
}

/** java.io.File 实现（app filesDir/update 子目录由装配方传入） */
class LocalUpdateFileStore(private val root: File) : UpdateFileStore {
    override fun stagingFile(pkg: UpdatePackage): File {
        root.mkdirs()
        val safeVersion = pkg.versionName.replace(Regex("""[^0-9A-Za-z._-]"""), "_")
        val file = File(root, "update-$safeVersion.apk")
        if (file.exists()) file.delete()
        return file
    }

    override fun delete(file: File) {
        runCatching { if (file.exists()) file.delete() }
    }
}

/**
 * HttpURLConnection 实现（真机用；不在 JVM 单测覆盖范围，测试走 [UpdateDownloadClient] 替身）。
 * 重定向仅跟随同 host 最多 3 次，防止下载链路被引向任意主机（SSRF 边界与 S6-02 同口径）。
 */
class HttpUpdateDownloader(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 60_000,
    private val maxBytes: Long = 512L * 1024 * 1024,
) : UpdateDownloadClient {

    override suspend fun download(url: String, target: File): Long {
        val connection = openFollowingRedirects(url)
        try {
            connection.inputStream.use { input ->
                target.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > maxBytes) throw IOException("update too large: $total")
                        out.write(buffer, 0, read)
                    }
                    return total
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    override suspend fun fetchText(url: String): String? = try {
        val connection = openFollowingRedirects(url)
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                null
            } else {
                connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }.take(4096)
            }
        } finally {
            connection.disconnect()
        }
    } catch (e: IOException) {
        null
    }

    private fun openFollowingRedirects(url: String): HttpURLConnection {
        val originalHost = URL(url).host
        var current = url
        repeat(MAX_REDIRECTS + 1) {
            val connection = (URL(current).openConnection() as? HttpURLConnection)
                ?: throw IOException("unsupported url: $current")
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "*/*")
            val code = connection.responseCode
            if (code in 300..399) {
                val location = connection.getHeaderField("Location")
                connection.disconnect()
                if (location.isNullOrBlank()) throw IOException("redirect without location")
                val next = URL(URL(current), location)
                if (next.host != originalHost) throw IOException("cross-host redirect rejected")
                current = next.toString()
                return@repeat
            }
            return connection
        }
        throw IOException("too many redirects")
    }

    private companion object {
        const val MAX_REDIRECTS = 3
    }
}
