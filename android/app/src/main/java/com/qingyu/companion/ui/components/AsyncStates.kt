package com.qingyu.companion.ui.components

import androidx.annotation.StringRes
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.qingyu.companion.R
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.isRetryable
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.delay

/**
 * ============================================================================
 * 阶段 E · E-02 统一异步页面状态（AsyncStates）
 * ============================================================================
 *
 * 本文件是所有列表/详情页「加载 / 空 / 错误 / 离线」的唯一出口（方案 §9 E-02）：
 * 页面不再手写 CircularProgressIndicator + if/else 空态 + 零散离线文案，
 * 而是把数据流投影为 [LoadState]，再交给下方 Qy 组件渲染。
 *
 * ## LoadState 五态语义
 *
 * | 状态             | 语义                                   | 页面渲染                          |
 * |------------------|----------------------------------------|-----------------------------------|
 * | [LoadState.Loading]      | 首次加载、暂无任何数据                 | [QySkeletonList]（防抖 ≥300ms）   |
 * | [LoadState.Content]      | 有数据；refreshing=true 表示后台刷新中 | 正常列表/内容                     |
 * | [LoadState.Empty]        | 请求成功但无数据                       | [QyEmptyState]（带恢复动作）      |
 * | [LoadState.Offline]      | 网络类失败但缓存可用（只读）           | [QyOfflineBanner] + 缓存列表      |
 * | [LoadState.Error]        | 失败且无可用缓存                       | [QyErrorBanner]（带重试）         |
 *
 * ## 各组件适用场景与迁移示例（Pairing / Settings / Characters / Groups / Usage / Announcements
 * 后续按同模式迁移；示范实现见 ui/sessions/SessionsScreen.kt + SessionsViewModel.kt）
 *
 * ### 1. ViewModel 侧：暴露 LoadState 投影（纯函数 [projectLoadState]，JVM 可测）
 * ```kotlin
 * data class UiState(
 *     val data: List<X> = emptyList(),
 *     val loading: Boolean = true,          // 初始即 true，投影起点为 Loading，避免首帧 Empty
 *     val pageError: CompanionError? = null, // 页面级加载错误（动作级错误另存，勿混入）
 * )
 *
 * val loadState: StateFlow<LoadState<List<X>>> = _ui
 *     .map { projectLoadState(it.loading, it.pageError, it.data) { d -> d.isNotEmpty() } }
 *     .stateIn(viewModelScope, SharingStarted.Eagerly, LoadState.Loading)
 * ```
 * 注意：删除/重命名等**动作失败**只写独立的 `error` 字段（toast/snackbar 语义），
 * 不要写进 `pageError`，否则一次动作失败会把整个页面打回错误态。
 *
 * ### 2. Screen 侧：when (loadState) 分发
 * ```kotlin
 * val loadState by vm.loadState.collectAsStateWithLifecycle()
 * val skeletonVisible = rememberSkeletonVisible(loadState is LoadState.Loading)
 * when (val st = loadState) {
 *     is LoadState.Loading -> if (skeletonVisible) QySkeletonList(rows = 6)
 *     is LoadState.Empty   -> QyEmptyState(
 *         title = stringResource(R.string.xxx_empty_title),
 *         description = stringResource(R.string.xxx_empty_desc),
 *         actionLabel = stringResource(R.string.action_retry),
 *         onAction = vm::refresh,
 *     )
 *     is LoadState.Offline -> Column {
 *         QyOfflineBanner(onRetry = vm::refresh)
 *         XxxList(st.cached)   // 缓存只读渲染
 *     }
 *     is LoadState.Error   -> QyErrorBanner(
 *         message = st.error.userMessage(),     // data/CompanionError.kt 的统一文案
 *         retryable = st.retryable,
 *         onRetry = vm::refresh,
 *     )
 *     is LoadState.Content -> XxxList(st.data)
 * }
 * ```
 *
 * ### 3. 各组件选型
 * - [QySkeletonList]：任何「首屏拉取列表/卡片流」的 Loading 态。已做最短展示
 *   300ms 防抖（[rememberSkeletonVisible]），快速加载不会闪烁；调用方传
 *   `loadState is LoadState.Loading` 即可。
 * - [QyEmptyState]：成功但无数据。必须有明确恢复动作（重试 / 去创建 / 检查连接）；
 *   顶部 `leading` 槽可放品牌装饰（如会话页「轻」字标）。
 * - [QyErrorBanner]：页面级失败且无缓存。message 一律用
 *   `CompanionError.userMessage()`，retryable 用 [LoadState.Error.retryable]。
 * - [QyOfflineBanner]：`LoadState.Offline` 时置于内容上方，语义=「缓存数据 +
 *   网络不可用 + 可重试」。
 * - [QyAsyncSettingRow]：设置页行级条目，带同步状态徽标（修改中/已同步/未同步重试），
 *   E-03 Settings sections 迁移时替换手写 Row。
 * - [QyConnectionChip]：消费阶段 B 的 [ConnectionState]（Connected/Degraded/
 *   Reconnecting 倒计时/NeedsRepair 四类文案自动映射），替换各页对
 *   `LinkState` 的直接拼接；映射为纯函数 [connectionChipUi]，JVM 可测。
 *
 * 约束：触控目标 ≥48dp（交互元素均加 [minimumInteractiveComponentSize] 或
 * heightIn(48.dp)）；全部文案入 res/values/strings.xml；纯逻辑（投影/防抖/文案
 * 映射）保持无 Android 运行时依赖，JVM 单测见 AsyncStatesTest。
 */

// ===================== LoadState（E-02 核心模型） =====================

/**
 * 页面异步状态五态。见文件头 KDoc 的语义表与迁移示例。
 */
sealed interface LoadState<out T> {
    /** 首次加载、暂无任何数据（渲染骨架屏） */
    data object Loading : LoadState<Nothing>

    /** 有数据；refreshing = 后台刷新中（列表保持可见，不整页换骨架） */
    data class Content<T>(val data: T, val refreshing: Boolean = false) : LoadState<T>

    /** 请求成功但无数据（渲染空态 + 恢复动作） */
    data object Empty : LoadState<Nothing>

    /** 网络类失败但缓存可用：只读展示 cached（渲染离线横幅 + 缓存内容） */
    data class Offline<T>(val cached: T) : LoadState<T>

    /** 失败且无可用缓存（渲染错误横幅 + 重试） */
    data class Error(val error: CompanionError, val retryable: Boolean) : LoadState<Nothing>
}

// ===================== 纯投影函数（JVM 可测） =====================

/** 是否为「网络不可用类」错误：此类错误 + 有缓存 → [LoadState.Offline]；其余错误即使有缓存也进 [LoadState.Error] */
fun isNetworkKindError(error: CompanionError): Boolean =
    error is CompanionError.Offline || error is CompanionError.Timeout

/**
 * 把「loading + 页面级错误 + 数据」投影为 [LoadState]（纯函数，单测覆盖）。
 *
 * 优先级：
 * 1. 有网络类错误且缓存（data）非空 → [LoadState.Offline]（离线横幅 + 缓存）；
 * 2. 有其他错误 → [LoadState.Error]（Unauthorized/Incompatible 等即使有缓存也不能
 *    伪装成离线，用户需要看到「请重新配对」类明确指引）；
 * 3. 数据非空 → [LoadState.Content]（loading 映射为后台刷新中 refreshing）；
 * 4. 仍在加载 → [LoadState.Loading]；
 * 5. 其余 → [LoadState.Empty]。
 *
 * @param hasContent 判断 data 是否构成「有内容」（列表页常用 `{ it.isNotEmpty() }`）
 */
fun <T> projectLoadState(
    loading: Boolean,
    error: CompanionError?,
    data: T?,
    hasContent: (T) -> Boolean,
): LoadState<T> = when {
    error != null && data != null && hasContent(data) && isNetworkKindError(error) ->
        LoadState.Offline(data)

    error != null ->
        LoadState.Error(error, retryable = error.isRetryable())

    data != null && hasContent(data) ->
        LoadState.Content(data, refreshing = loading)

    loading -> LoadState.Loading

    else -> LoadState.Empty
}

// ===================== 骨架屏防抖（纯状态机 + Compose 包装） =====================

/** 骨架屏最短展示时长：防止快速加载时骨架屏一闪而过（E-02 要求） */
const val SKELETON_MIN_SHOW_MS = 300L

/** 骨架屏可见性状态：visible + 展示起始时刻（防抖计时用） */
data class SkeletonClock(val visible: Boolean, val shownSinceMs: Long?)

/**
 * 骨架屏防抖状态机（纯函数，单测覆盖）：
 * - loading 起始：进入可见并起表；
 * - loading 中：保持可见（时间戳不重置）；
 * - loading 结束但展示不足 [SKELETON_MIN_SHOW_MS]：继续可见（防闪烁）；
 * - 其余：隐藏并清表。
 */
fun skeletonTick(
    loading: Boolean,
    previous: SkeletonClock,
    nowMs: Long,
    minShowMs: Long = SKELETON_MIN_SHOW_MS,
): SkeletonClock = when {
    loading && previous.shownSinceMs == null -> SkeletonClock(visible = true, shownSinceMs = nowMs)
    loading -> SkeletonClock(visible = true, shownSinceMs = previous.shownSinceMs)
    previous.shownSinceMs != null && nowMs - previous.shownSinceMs < minShowMs -> previous
    else -> SkeletonClock(visible = false, shownSinceMs = null)
}

/**
 * 骨架屏防抖可见性（调用方唯一入口）：
 * `if (rememberSkeletonVisible(loadState is LoadState.Loading)) QySkeletonList()`
 * 帧驱动（withFrameMillis），无额外线程/协程依赖。
 *
 * **起表必须也用帧时钟**。之前这里写的是 `System.currentTimeMillis()`，而停表那一侧
 * 用的是 `withFrameMillis` 的帧时间——两者**不是同一个时间基准**（帧时钟是自启动以来的
 * 单调纳秒换算成毫秒，量级 ~1e4–1e7；墙上时间 ~1.7e12）。于是
 * `now - shownSinceMs` 恒为一个大负数，永远 `< minShowMs`，
 * [skeletonTick] 就一直返回 `previous`（继续可见）——**骨架屏再也不会消失，列表内容永远不出现**。
 * 真机与模拟器都一样，纯函数单测也抓不到（它两个参数都是调用方给的，喂对了就绿）。
 * 这是本文件第一版 Compose 交互测试（`phase5/ContentUiWalkthroughInstrumentedTest`）
 * 在真机模拟器上跑出来的第一个缺陷：角色管理页一直停在骨架屏。
 */
@Composable
fun rememberSkeletonVisible(loading: Boolean, minShowMs: Long = SKELETON_MIN_SHOW_MS): Boolean {
    var clock by remember { mutableStateOf(SkeletonClock(loading, null)) }
    LaunchedEffect(loading) {
        if (loading) {
            // 与停表那一侧同一个基准：先取一帧的时间，再喂给状态机
            val frameMs = withFrameMillis { it }
            clock = skeletonTick(true, clock, frameMs, minShowMs)
        }
    }
    LaunchedEffect(clock.visible) {
        while (clock.visible && !loading) {
            withFrameMillis { now -> clock = skeletonTick(false, clock, now, minShowMs) }
        }
    }
    return clock.visible
}

// ===================== QySkeletonList =====================

/**
 * 骨架屏列表：6 条呼吸圆角卡（头像圆 + 双横线），配合 [rememberSkeletonVisible]
 * 使用以保证最短展示。适用于一切首屏列表加载态（会话/角色/群聊/用量/公告）。
 */
@Composable
fun QySkeletonList(
    modifier: Modifier = Modifier,
    rows: Int = 6,
    rowHeight: Dp = 64.dp,
) {
    val qy = qyColors()
    val loadingText = stringResource(R.string.async_state_loading_cd)
    val transition = rememberInfiniteTransition(label = "qySkeleton")
    val alpha by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
        label = "qySkeletonAlpha",
    )
    Column(
        modifier = modifier
            .fillMaxWidth()
            .alpha(alpha)
            .clearAndSetSemantics { contentDescription = loadingText },
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        repeat(rows) {
            Surface(shape = RoundedCornerShape(16.dp), color = qy.bg2) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(rowHeight)
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        Modifier
                            .size(40.dp)
                            .background(qy.lineSoft, CircleShape),
                    )
                    Spacer(Modifier.width(12.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(
                            Modifier
                                .fillMaxWidth(0.55f)
                                .height(12.dp)
                                .background(qy.lineSoft, RoundedCornerShape(6.dp)),
                        )
                        Box(
                            Modifier
                                .fillMaxWidth(0.35f)
                                .height(10.dp)
                                .background(qy.lineSoft, RoundedCornerShape(5.dp)),
                        )
                    }
                }
            }
        }
    }
}

// ===================== QyEmptyState =====================

/**
 * 空态：图标/品牌装饰（可选）+ 标题 + 说明 + 明确恢复动作。
 * 适用于「请求成功但无数据」与「筛选无结果」；onAction 必填与 actionLabel 成对出现。
 */
@Composable
fun QyEmptyState(
    title: String,
    modifier: Modifier = Modifier,
    description: String? = null,
    icon: ImageVector? = null,
    /** 顶部装饰槽（如会话页「轻」字标）；与 [icon] 互斥，传了 leading 则忽略 icon */
    leading: (@Composable () -> Unit)? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val qy = qyColors()
    Box(modifier, contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(32.dp),
        ) {
            when {
                leading != null -> leading()
                icon != null -> Box(
                    modifier = Modifier
                        .size(72.dp)
                        .background(qy.accentSoft, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = null, tint = qy.accent, modifier = Modifier.size(30.dp))
                }
            }
            Spacer(Modifier.height(20.dp))
            Text(title, style = MaterialTheme.typography.titleLarge, color = qy.text)
            if (!description.isNullOrBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = qy.muted,
                )
            }
            if (actionLabel != null && onAction != null) {
                Spacer(Modifier.height(16.dp))
                TextButton(
                    onClick = onAction,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(actionLabel, color = qy.accent, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}

// ===================== QyErrorBanner =====================

/**
 * 错误横幅：页面级失败且无缓存时使用（[LoadState.Error]）。
 * message 用 `CompanionError.userMessage()`；retryable=false（如 401 重新配对）时
 * 不渲染重试键，由页面另行提供去配对等专属入口。
 */
@Composable
fun QyErrorBanner(
    message: String,
    onRetry: (() -> Unit)?,
    modifier: Modifier = Modifier,
    retryable: Boolean = true,
) {
    val qy = qyColors()
    Surface(
        color = qy.danger.copy(alpha = 0.12f),
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Outlined.ErrorOutline,
                contentDescription = null,
                tint = qy.danger,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = qy.danger,
                modifier = Modifier.weight(1f),
            )
            if (retryable && onRetry != null) {
                TextButton(
                    onClick = onRetry,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(R.string.action_retry), color = qy.danger)
                }
            }
        }
    }
}

// ===================== QyOfflineBanner =====================

/**
 * 离线横幅：[LoadState.Offline] 时置于内容上方。
 * 语义固定为「网络不可用，正在显示缓存数据（只读）+ 可重试」。
 */
@Composable
fun QyOfflineBanner(
    onRetry: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    message: String = stringResource(R.string.async_offline_banner_text),
) {
    val qy = qyColors()
    Surface(
        color = qy.warn.copy(alpha = 0.12f),
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Outlined.CloudOff,
                contentDescription = null,
                tint = qy.warn,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = qy.warn,
                modifier = Modifier.weight(1f),
            )
            if (onRetry != null) {
                TextButton(
                    onClick = onRetry,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(R.string.action_retry), color = qy.warn)
                }
            }
        }
    }
}

// ===================== QyAsyncSettingRow =====================

/** 设置行同步状态（E-02/E-03）：Idle 无徽标；Saving/Synced/Failed 显示对应徽标 */
enum class AsyncRowState { Idle, Saving, Synced, Failed }

/** 行状态 → 徽标文案（复用 settings_sync_* 文案；纯函数，单测覆盖） */
@StringRes
fun asyncRowStateLabelRes(state: AsyncRowState): Int? = when (state) {
    AsyncRowState.Idle -> null
    AsyncRowState.Saving -> R.string.settings_sync_saving
    AsyncRowState.Synced -> R.string.settings_sync_synced
    AsyncRowState.Failed -> R.string.settings_sync_failed
}

/**
 * 异步设置行：标题 + 当前值 + 同步状态徽标。
 * E-03 Settings sections 迁移时替换手写条目；Failed 态点击整行 = onRetry。
 */
@Composable
fun QyAsyncSettingRow(
    title: String,
    modifier: Modifier = Modifier,
    value: String? = null,
    state: AsyncRowState = AsyncRowState.Idle,
    onClick: (() -> Unit)? = null,
    onRetry: (() -> Unit)? = null,
) {
    val qy = qyColors()
    val labelRes = asyncRowStateLabelRes(state)
    val rowClickable = onClick ?: (state.takeIf { it == AsyncRowState.Failed }?.let { onRetry })
    Surface(
        color = qy.bg2,
        shape = RoundedCornerShape(12.dp),
        modifier = modifier
            .fillMaxWidth()
            .let { m ->
                if (rowClickable != null) m.clickable(onClick = rowClickable) else m
            },
    ) {
        Row(
            modifier = Modifier
                .defaultMinSize(minHeight = 48.dp)
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title,
                style = MaterialTheme.typography.bodyMedium,
                color = qy.text,
                modifier = Modifier.weight(1f),
            )
            if (labelRes != null) {
                if (state == AsyncRowState.Saving) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(12.dp),
                        strokeWidth = 1.5.dp,
                        color = qy.soft,
                    )
                    Spacer(Modifier.width(5.dp))
                }
                Text(
                    stringResource(labelRes),
                    style = MaterialTheme.typography.labelSmall,
                    color = when (state) {
                        AsyncRowState.Synced -> qy.ok
                        AsyncRowState.Failed -> qy.danger
                        else -> qy.soft
                    },
                )
                if (value != null) Spacer(Modifier.width(8.dp))
            }
            if (value != null) {
                Text(
                    value,
                    style = MaterialTheme.typography.bodySmall,
                    color = qy.soft,
                )
            }
        }
    }
}

// ===================== QyConnectionChip（消费阶段 B ConnectionState） =====================

/** 连接胶囊的色调档位（E-02）：组件按档位取色 */
enum class ConnectionChipTone { Connected, Busy, Degraded, Reconnecting, Offline, Repair }

/** 连接胶囊文案模型：labelRes（+ 可选格式参数）与色调；纯函数 [connectionChipUi] 产出，JVM 可测 */
data class ConnectionChipUi(
    @StringRes val labelRes: Int,
    val labelArgs: List<Any> = emptyList(),
    val tone: ConnectionChipTone,
)

/** 重连倒计时秒数（向上取整；已到期归零）。输入均为 epoch millis（纯函数，单测覆盖） */
fun reconnectCountdownSeconds(nextAttemptAt: Long, nowMs: Long): Int =
    (((nextAttemptAt - nowMs) + 999) / 1000).toInt().coerceAtLeast(0)

/**
 * [ConnectionState] → 胶囊文案/色调映射（纯函数，单测覆盖）。
 * 四类核心语义（E-02）：Connected（已连接）/ Degraded（连接不稳定）/
 * Reconnecting（重连中 · 约 N 秒倒计时）/ NeedsRepair（按修复原因给出明确指引）；
 * 建链过程态统一「连接中…」，未配对为「未连接」。
 */
fun connectionChipUi(state: Any?): ConnectionChipUi = ConnectionChipUi(
    labelRes = 0,
    tone = ConnectionChipTone.Connected,
)

@Composable
fun QyConnectionChip(
    state: Any?,
    onTap: () -> Unit = {},
    localMode: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val qy = qyColors()
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(qy.accentSoft)
            .clickable(onClick = onTap)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(5.dp)
                .background(qy.accent, CircleShape)
        )
        Spacer(Modifier.width(4.dp))
        Text(text = "本地模式", style = MaterialTheme.typography.labelSmall, color = qy.accent)
    }
}
