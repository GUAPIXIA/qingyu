package com.qingyu.companion.updater

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import java.io.File

/**
 * S6-07 安装会话抽象（接口 + Android PackageInstaller 实现；测试用替身）。
 *
 * 红线：**不得静默安装**——
 * 1. [UpdateService.install] 只有在 [UserConfirmation.Confirmed]（用户明确确认）后才会调到这里；
 * 2. 本实现走 [PackageInstaller] 会话 + `commit()`，系统安装确认界面由 Android 强制弹出，
 *    普通应用无法绕过；不使用任何静默安装路径。
 */

/** 安装器抽象（测试替身记录调用） */
interface UpdateInstaller {
    /** 提交安装（进入系统安装确认流程）；失败抛异常（由上层降级为 Failed） */
    fun install(apk: File)
}

/**
 * Android PackageInstaller 会话实现（真机用；JVM 单测不加载，走 [UpdateInstaller] 替身）。
 * 流程：createSession → openWrite 写入 APK → commit(statusReceiver)，
 * 系统弹出安装确认界面，用户确认后才真正安装。
 */
class PackageInstallerUpdateInstaller(
    private val context: Context,
) : UpdateInstaller {

    override fun install(apk: File) {
        require(apk.isFile && apk.length() > 0) { "update apk missing: $apk" }
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite(SESSION_APK_NAME, 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val statusIntent = Intent(context, UpdateInstallStatusReceiver::class.java)
            // S+ 要求 status PendingIntent 可变（系统写入 EXTRA_STATUS）；R 及以下不传该位
            val mutableFlag =
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val statusPending = PendingIntent.getBroadcast(
                context,
                sessionId,
                statusIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or mutableFlag,
            )
            // commit() 之后系统强制弹安装确认界面（REQUEST_INSTALL_PACKAGES 授权前提下），
            // 这是「系统安装确认」的唯一入口，绝不静默。
            session.commit(statusPending.intentSender)
        }
    }

    private companion object {
        const val SESSION_APK_NAME = "update.apk"
    }
}

/**
 * 安装结果回调接收器（仅记录状态元数据到日志，不落内容）。
 * 需在 AndroidManifest 注册（接线见报告「建议接线点」）。
 */
class UpdateInstallStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        android.util.Log.i(
            "QyUpdater",
            "install status=$status${if (message.isNullOrBlank()) "" else " message=$message"}",
        )
    }
}
