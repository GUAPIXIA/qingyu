package com.qingyu.companion.data

import android.content.Context
import android.os.Build
import java.util.UUID

/**
 * 设备身份：配对时上报的设备名与设备指纹。
 * 指纹为首次启动生成的稳定 UUID（安装期内不变），用于 PC 侧令牌绑定
 * （方案 §6.2「令牌绑定设备指纹」）与吊销管理。
 */
class DeviceIdentity(context: Context) {

    private val prefs = context.getSharedPreferences("companion_device", Context.MODE_PRIVATE)

    /** 本机设备指纹（安装期内稳定） */
    val fingerprint: String by lazy {
        prefs.getString(KEY_FINGERPRINT, null)
            ?: UUID.randomUUID().toString().also {
                prefs.edit().putString(KEY_FINGERPRINT, it).apply()
            }
    }

    /** 展示给 PC 侧确认弹窗的设备名（机型 + 简短指纹尾缀） */
    val displayName: String =
        "${Build.MANUFACTURER} ${Build.MODEL}".trim() +
            " (${fingerprint.take(4)})"

    private companion object {
        const val KEY_FINGERPRINT = "device_fingerprint"
    }
}
