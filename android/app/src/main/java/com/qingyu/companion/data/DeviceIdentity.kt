package com.qingyu.companion.data

import android.content.Context
import android.os.Build
import java.util.UUID

/**
 * 设备身份：配对时上报的设备名与设备标识。
 * - deviceInstallationId / fingerprint：本机安装期随机 UUID（非服务器公钥指纹），用于 PC 侧令牌绑定与吊销（方案 §6.2）
 * - serverFingerprint（见 ServerConnection.fingerprint）：PC 侧公钥/设备指纹，两者命名已区分，避免信任混淆（路线图 4.3）
 */
class DeviceIdentity(context: Context) {

    private val prefs = context.getSharedPreferences("companion_device", Context.MODE_PRIVATE)

    /** 本机设备安装标识（安装期内稳定，随机 UUID，非服务器公钥指纹） */
    val deviceInstallationId: String by lazy {
        prefs.getString(KEY_FINGERPRINT, null)
            ?: UUID.randomUUID().toString().also {
                prefs.edit().putString(KEY_FINGERPRINT, it).apply()
            }
    }

    /** @deprecated 使用 deviceInstallationId，保留 fingerprint 兼容旧调用 */
    val fingerprint: String by lazy { deviceInstallationId }

    /** 展示给 PC 侧确认弹窗的设备名（机型 + 简短安装标识尾缀） */
    val displayName: String =
        "${Build.MANUFACTURER} ${Build.MODEL}".trim() +
            " (${deviceInstallationId.take(4)})"

    private companion object {
        const val KEY_FINGERPRINT = "device_fingerprint"
    }
}
