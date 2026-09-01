package com.qingyu.companion.ui.notification

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper

/**
 * A-06 通知权限延迟申请策略。
 *
 * 原则（实施文档 §A-05/A-06）：
 * - 启动不再弹系统权限框（MainActivity 中的申请代码已移除）；
 * - 「任务通知」开关打开时先展示用途说明，确认后才发起 POST_NOTIFICATIONS 请求；
 * - 不反复弹系统权限框：此前已请求过且被永久拒绝时，只提供「前往系统设置」入口；
 * - 未授权/拒绝授权不阻断任何生成、连接、发消息流程（首生成说明为非阻塞提示）。
 */

/** 用途说明对话框确认后应执行的下一步动作 */
enum class TaskNotificationEnableAction {
    /** 无需（或不能再）打扰系统：仅保存 App 内开关即可 */
    None,

    /** 发起系统 POST_NOTIFICATIONS 请求 */
    RequestSystem,

    /** 权限已被永久拒绝：引导前往系统通知设置 */
    OpenSystemSettings,
}

/**
 * 纯决策函数（可 JVM 单测）：根据权限状态决定「确认开启任务通知」后的动作。
 *
 * @param permissionRequired Android 13+（需要动态 POST_NOTIFICATIONS）
 * @param granted 当前是否已授予系统权限
 * @param shouldShowRationale Activity.shouldShowRequestPermissionRationale 结果
 * @param askedBefore 本应用是否已发起过系统权限请求（持久化记录，用于识别永久拒绝）
 */
fun decideTaskNotificationEnableAction(
    permissionRequired: Boolean,
    granted: Boolean,
    shouldShowRationale: Boolean,
    askedBefore: Boolean,
): TaskNotificationEnableAction = when {
    !permissionRequired || granted -> TaskNotificationEnableAction.None
    askedBefore && !shouldShowRationale -> TaskNotificationEnableAction.OpenSystemSettings
    else -> TaskNotificationEnableAction.RequestSystem
}

/**
 * 纯决策函数（可 JVM 单测）：用户首次发起可能后台完成的生成任务时，
 * 是否显示非阻塞的通知说明提示。
 * 仅在「App 内任务通知开关开启 + 系统侧当前无法通知 + 本次会话未提示过」时提示一次。
 */
fun shouldShowFirstGenerationNotificationHint(
    appNotificationsEnabled: Boolean,
    canPostSystem: Boolean,
    alreadyShown: Boolean,
): Boolean = appNotificationsEnabled && !canPostSystem && !alreadyShown

/**
 * App 内「任务通知」开关的内存镜像（由 [NotificationDispatcher] 随 DataStore 同步）。
 * 两个通知 Helper 的 canPost 先查本开关：关闭后系统渠道虽存在也不再投递，
 * 使渠道表现与 App 内开关一致；默认放行以免在 DataStore 首帧前吞掉通知。
 * 纯判断逻辑见 [canPostNotification]，可 JVM 单测。
 */
object NotificationGate {
    @Volatile
    var appEnabled: Boolean = true
}

/** 纯决策函数（可 JVM 单测）：App 内开关与系统可投递状态的合成 */
fun canPostNotification(appEnabled: Boolean, canPostSystem: Boolean): Boolean =
    appEnabled && canPostSystem

/** 「已发起过系统权限请求」的持久化标记（避免重复弹系统框、识别永久拒绝） */
private const val SHARED_PREFS = "companion_notification_permission"
private const val KEY_ASKED = "post_notifications_asked"

fun hasAskedNotificationPermission(context: Context): Boolean =
    context.getSharedPreferences(SHARED_PREFS, Context.MODE_PRIVATE)
        .getBoolean(KEY_ASKED, false)

fun markNotificationPermissionAsked(context: Context) {
    context.getSharedPreferences(SHARED_PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_ASKED, true).apply()
}

/** 从 Compose 的 LocalContext 逐层解包找到宿主 Activity（用于 rationale 查询） */
fun Context.findActivity(): Activity? {
    var ctx: Context = this
    while (ctx is ContextWrapper) {
        if (ctx is Activity) return ctx
        ctx = ctx.baseContext
    }
    return null
}
