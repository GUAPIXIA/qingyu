package com.qingyu.companion.ui.settings

import com.qingyu.companion.model.VersionInfo

/**
 * S9-07：PC 连接诊断投影已删除。仅保留本地版本信息展示辅助。
 */
fun versionLabel(info: VersionInfo?): String = info?.version ?: "未知"
