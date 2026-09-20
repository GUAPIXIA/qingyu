package com.qingyu.companion.ui.content

import android.content.Context
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.data.DraftWrite
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineScope
import com.qingyu.companion.content.CharacterCardCodec
import com.qingyu.companion.local.domain.BindingImpact
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 阶段 5 内容编辑器的共用支撑。
 *
 * 放这里的是六个编辑器（角色/世界书/预设/人设/正则/快捷回复）**必须一致**的行为，
 * 不是顺手抽公共组件：
 * - 草稿自动保存的边界（方案 §2：自动保存只写草稿区，点保存或离开确认后才产生**一个**业务变更）；
 * - SAF 导入的数量 / 单文件 / 总大小上限（方案 S5-01）；
 * - 删除影响范围确认（方案 §2：删除均显示影响范围，有引用先解绑或阻止）。
 *
 * 漏在某个页面里单独实现，另外五个就会各自漂移——尤其「每次键入都产生一个同步变更」，
 * 一旦哪个编辑器直接落库，同步端就会看到同一实体的成百上千个并发版本。
 */
object ContentEditorSupport {
    /** 单个导入文件上限（与角色卡编解码层同一口径，避免两处各写一个数）。 */
    val MAX_FILE_BYTES: Long = CharacterCardCodec.MAX_CARD_BYTES.toLong()

    /** 一次批量导入的字节总量上限。 */
    const val MAX_BATCH_BYTES: Long = CharacterCardCodec.MAX_BATCH_BYTES

    /** 一次批量导入的文件数上限。 */
    const val MAX_BATCH_FILES: Int = CharacterCardCodec.MAX_BATCH_FILES
}

/**
 * 编辑草稿状态机。
 *
 * 不变量：[draft] 的每次变化**只**更新内存草稿；只有 [commit] 才调用 [onPersist]
 * 产生一次业务写（进而产生一条 journal）。自动保存可以持续更新 [draft]，
 * 但绝不允许直接调 [onPersist]。
 */
class EditorDraft<T : Any>(source: T) {

    var original: T = source
        private set
    var draft: T = source
        private set

    val dirty: Boolean get() = draft != original

    fun edit(transform: (T) -> T) {
        draft = transform(draft)
    }

    /** 放弃草稿（用户在离开确认里选「不保存」）。 */
    fun revert() {
        draft = original
    }

    /**
     * 提交为一次业务变更；无变化时返回 false 且**不落库**。
     *
     * 为什么强调不落库：一次空内容的保存同样会推进版本向量、写一条 journal，
     * 同步端就会把它当成真实修改与对端版本判为并发冲突。
     *
     * [force] 是给「还没落库的新行」用的：从草稿区恢复出来的新建草稿，
     * `original` 与 `draft` 天生相等 → `dirty` 为假 → 不 force 就会出现
     * **界面显示「已保存」、库里却没有这一行**（`ContentDraftAreaInstrumentedTest` 在设备上实测到）。
     */
    suspend fun commit(force: Boolean = false, onPersist: suspend (T) -> Unit): Boolean {
        if (!dirty && !force) return false
        onPersist(draft)
        original = draft
        return true
    }
}

/**
 * 阶段 5 §2 的草稿区写入器：**每次键入只写本地草稿，绝不碰同步层**。
 *
 * 三条边界按需求原文分开处理：
 * - 键入 → 节流后写草稿区（不落库、不记账、不推版本向量）；
 * - 点保存 → 提交为一次业务变更，并**清掉草稿**（留着会让下次进来又恢复出一份已保存的内容）；
 * - 明确放弃（离开确认里选「不保存」）→ 也清掉；
 * - 进程被杀 / 页面被回收 → 谁都没被调用，草稿原地留着，回来能接上。
 *
 * 节流而不是每键一写：DataStore 每次写都是一次磁盘提交，
 * 输入法连打会把它变成写放大器；300ms 静默期足够把一串键入并成一次。
 */
class ContentDraftAutosaver<E : Any>(
    private val store: ContentDraftStore,
    private val kind: String,
    private val encode: (E) -> String,
    private val decode: (String) -> E?,
    private val onSkipped: (String) -> Unit = {},
) {
    private var pending: Job? = null

    /**
     * 上一次**真正落进草稿区**的值。
     *
     * 判「内容有没有变」而不是「有没有敲键」：整页草稿可能只是光标移动或焦点变化触发的
     * 同值重组，而一次同值重组就要把整行 JSON 连同整个 DataStore 文件重写一遍。
     */
    private var lastWritten: E? = null

    /** 取消上一次尚未落盘的排程——旧草稿值绝不能在新值之后写进去。 */
    fun schedule(scope: CoroutineScope, entityId: String, value: E) {
        pending?.cancel()
        if (value == lastWritten) return
        pending = scope.launch {
            delay(AUTOSAVE_DEBOUNCE_MS)
            when (store.put(kind, entityId, encode(value))) {
                DraftWrite.ACCEPTED -> lastWritten = value
                DraftWrite.TOO_LARGE -> onSkipped(NOTE_TOO_LARGE)
                DraftWrite.OVER_BUDGET -> onSkipped(NOTE_OVER_BUDGET)
            }
        }
    }

    /** 保存/放弃前的收口：等在途的排程落完，避免「已清草稿」被后到的写入覆盖。 */
    suspend fun settle() {
        pending?.join()
        pending = null
    }

    suspend fun restore(entityId: String): E? = store.get(kind, entityId)
        ?.let { raw -> decode(raw) }
        ?.also { lastWritten = it }

    suspend fun discard(entityId: String) {
        pending?.cancel()
        // 槽清空之后，同值草稿必须能再写一次：不然「保存后继续编辑同样的内容」会被当成无变化跳过
        lastWritten = null
        store.clear(kind, entityId)
    }

    private companion object {
        const val AUTOSAVE_DEBOUNCE_MS = 300L

        /**
         * 拒绝必须说原因与后果：否则用户以为自动保存还在工作。
         * 数字从常量算出来——写死的 MiB 会在有人调上限之后变成一句假话。
         */
        val NOTE_TOO_LARGE: String =
            "这篇内容超过单条草稿上限（${mib(ContentDraftStore.MAX_DRAFT_BYTES.toLong())} MiB），" +
                "自动草稿已停用：请及时点保存，退出前不会替你留稿。"
        val NOTE_OVER_BUDGET: String =
            "草稿区总量已满（${mib(ContentDraftStore.MAX_DRAFT_TOTAL_BYTES)} MiB），" +
                "这次自动草稿没落下：请先保存并离开一个未保存的编辑器。"

        private fun mib(bytes: Long): Long = bytes / 1024 / 1024
    }
}

/** 导入类文件的读取结果：字节 + 展示名。展示名不可信，尺寸以字节为准。 */
data class PickedDocument(val uri: Uri, val displayName: String, val bytes: ByteArray)

/**
 * 多文档选择器（Storage Access Framework）。
 *
 * 大小校验在数据层做而不是交给 UI：`displayName` 可以随便写，
 * 真尺寸只能从 metadata 与实读字节确认。先按声明大小筛、读满后再二次确认，
 * 才能对「自称 200 KiB 的 2 GiB 文件」给出确定行为而不是 OOM。
 *
 * 一次最多取 [maxFiles] 个；返回条数少于选择条数即代表有文件被大小规则丢弃。
 */
@Composable
fun rememberMultiDocumentPicker(
    mimeTypes: Array<String>,
    maxFiles: Int = ContentEditorSupport.MAX_BATCH_FILES,
    onPicked: suspend (List<PickedDocument>) -> Unit,
): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris: List<Uri> ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch { onPicked(readDocuments(context, uris.take(maxFiles))) }
    }
    return { launcher.launch(mimeTypes) }
}

/** 单文档「另存为」选择器（导出用）。 */
@Composable
fun rememberCreateDocumentPicker(
    mimeType: String,
    onPicked: suspend (Uri) -> Unit,
): (String) -> Unit {
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument(mimeType),
    ) { uri -> if (uri != null) scope.launch { onPicked(uri) } }
    return { suggestedName -> launcher.launch(suggestedName) }
}

/** 读取被选文档；读不到或超限的条目被丢弃（不抛异常打断整批）。 */
suspend fun readDocuments(context: Context, uris: List<Uri>): List<PickedDocument> =
    withContext(Dispatchers.IO) {
        val capped = uris.take(ContentEditorSupport.MAX_BATCH_FILES)
        val out = ArrayList<PickedDocument>(capped.size)
        var batchBytes = 0L
        for (uri in capped) {
            val name = queryDisplayName(context, uri) ?: uri.lastPathSegment ?: "document"
            val declared = queryDeclaredSize(context, uri)
            if (declared != null && declared > ContentEditorSupport.MAX_FILE_BYTES) continue
            val bytes = runCatching {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            }.getOrNull() ?: continue
            if (bytes.isEmpty()) continue
            if (bytes.size.toLong() > ContentEditorSupport.MAX_FILE_BYTES) continue
            if (batchBytes + bytes.size > ContentEditorSupport.MAX_BATCH_BYTES) break
            batchBytes += bytes.size
            out += PickedDocument(uri, name, bytes)
        }
        out
    }

/**
 * 写出导出文件。
 *
 * 必须走 `ContentResolver`：SAF 给的是 `content://` 授权 URI，
 * 当文件路径用会失败或在部分设备上抛 SecurityException。
 * `"wt"` 表示截断写，避免在旧内容后面追加出一份坏文件。
 */
suspend fun writeDocument(context: Context, uri: Uri, bytes: ByteArray): String? =
    withContext(Dispatchers.IO) {
        runCatching {
            context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
        }.exceptionOrNull()?.message
    }

private fun queryDisplayName(context: Context, uri: Uri): String? = queryColumn(context, uri, android.provider.OpenableColumns.DISPLAY_NAME) { cursor, index -> cursor.getString(index) }

private fun queryDeclaredSize(context: Context, uri: Uri): Long? = queryColumn(context, uri, android.provider.OpenableColumns.SIZE) { cursor, index -> cursor.getLong(index) }

private fun <T> queryColumn(
    context: Context,
    uri: Uri,
    column: String,
    read: (android.database.Cursor, Int) -> T,
): T? = runCatching {
    context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(column)
        if (index >= 0 && cursor.moveToFirst() && !cursor.isNull(index)) read(cursor, index) else null
    }
}.getOrNull()

// ---------------------------------------------------------------- 表单组件

/** 编辑器主体滚动容器。 */
@Composable
fun EditorFormBody(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        content = content,
    )
}

/**
 * 折叠分区。
 *
 * 方案 §2：「不因移动端屏幕小而隐藏关键高级字段，可放入折叠高级区」——
 * 所以折叠是**默认展开可收起**，而不是默认藏起来；[collapsedByDefault] 只给
 * 真正次要的分组用。
 */
@Composable
fun EditorSection(
    title: String,
    modifier: Modifier = Modifier,
    collapsedByDefault: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    var expanded by remember(title) { mutableStateOf(!collapsedByDefault) }
    Column(modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(vertical = 8.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            Icon(
                imageVector = if (expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = if (expanded) "收起" else "展开",
            )
        }
        if (expanded) {
            Spacer(Modifier.height(6.dp))
            content()
        } else {
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
        }
    }
}

/** 多行文本字段（角色描述、世界书正文等）。[minLines] > 1 即视为多行。 */
@Composable
fun EditorTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    helper: String? = null,
    minLines: Int = 1,
    error: String? = null,
    enabled: Boolean = true,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        isError = error != null,
        supportingText = when {
            error != null -> {
                @Composable
                { Text(error, color = MaterialTheme.colorScheme.error) }
            }
            helper != null -> {
                @Composable
                { Text(helper) }
            }
            else -> null
        },
        minLines = minLines,
        maxLines = if (minLines == 1) 1 else 10,
        enabled = enabled,
    )
}

/**
 * 数值字段。
 *
 * 为什么不用 Slider 作为唯一输入：取值范围跨度太大（温度 0–2，token 上限 0–262144），
 * 而且方案要求与 PC 相同的钳位区间——滑条拖不出精确值，也表达不了「输入非法时怎么办」。
 * 这里文本为主输入，滑条只在连续区间上做辅助。
 */
@Composable
fun EditorNumberField(
    value: Double,
    onValueChange: (Double) -> Unit,
    label: String,
    range: ClosedFloatingPointRange<Double>,
    modifier: Modifier = Modifier,
    helper: String? = null,
    integerOnly: Boolean = false,
) {
    var text by remember { mutableStateOf(formatNumber(value, integerOnly)) }
    // 外部值变化（切换预设、放弃草稿）要回灌输入框，否则留下陈旧文本
    LaunchedEffect(value) { if (text.toDoubleOrNull() != value) text = formatNumber(value, integerOnly) }
    val invalid = text.isNotEmpty() && text.toDoubleOrNull() == null
    OutlinedTextField(
        value = text,
        onValueChange = { next ->
            text = next
            next.toDoubleOrNull()?.let { onValueChange(clamp(it, range)) }
        },
        label = { Text(label) },
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = if (integerOnly) KeyboardType.Number else KeyboardType.Decimal),
        isError = invalid,
        supportingText = when {
            invalid -> {
                @Composable
                { Text("请输入数字", color = MaterialTheme.colorScheme.error) }
            }
            helper != null -> {
                @Composable
                { Text(helper) }
            }
            else -> null
        },
    )
    if (!integerOnly && range.endInclusive > range.start) {
        val floatRange = range.start.toFloat()..range.endInclusive.toFloat()
        Slider(
            value = clamp(value, range).toFloat(),
            onValueChange = { next ->
                onValueChange(next.toDouble())
                text = formatNumber(next.toDouble(), false)
            },
            valueRange = floatRange,
        )
    }
}

@Composable
fun EditorSwitchRow(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    label: String,
    description: String? = null,
    enabled: Boolean = true,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            if (description != null) {
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

@Composable
fun EditorCheckboxRow(checked: Boolean, onCheckedChange: (Boolean) -> Unit, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onCheckedChange)
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

/** 一行说明文字（导入报告、兼容性提示等）。 */
@Composable
fun EditorNote(text: String, isError: Boolean = false) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    )
}

/**
 * 删除确认：显示影响范围。
 *
 * 方案 §2 不允许在用户不知情时改掉引用关系，所以 [impact] 必须如实展示；
 * [deleteBlocked] 为真时确认按钮不可点（有引用且该实体不支持自动解绑）。
 */
@Composable
fun DeleteImpactDialog(
    itemName: String,
    impact: BindingImpact,
    extraWarning: String? = null,
    deleteBlocked: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val references = when {
        impact.isEmpty -> "当前没有被其它数据引用。"
        else -> buildString {
            append("它正被引用：")
            val parts = ArrayList<String>()
            if (impact.sessions > 0) parts += "${impact.sessions} 个会话"
            if (impact.characters > 0) parts += "${impact.characters} 个角色"
            append(parts.joinToString("、"))
            append(if (deleteBlocked) "。请先处理引用再删除。" else "，删除时会一并解绑。")
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("删除「$itemName」？") },
        text = {
            Column {
                Text(references)
                if (extraWarning != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(extraWarning, color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.height(8.dp))
                Text("删除会记录为一条删除变更，同步后其它设备上的该项也会被移除。")
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !deleteBlocked) { Text("删除") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/** 编辑器顶部操作行（保存 / 取消 / 更多）。 */
@Composable
fun EditorActionBar(
    dirty: Boolean,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    saveLabel: String = "保存",
    busy: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        TextButton(onClick = onCancel) { Text("取消") }
        Spacer(Modifier.weight(1f))
        trailing?.invoke()
        TextButton(onClick = onSave, enabled = dirty && !busy) { Text(saveLabel) }
    }
}

private fun clamp(value: Double, range: ClosedFloatingPointRange<Double>): Double =
    minOf(range.endInclusive, maxOf(range.start, value))

/**
 * 离开确认（方案 §2：「点击保存或**离开确认后**生成一个业务变更」）。
 *
 * 六个编辑器共用同一个判定，因为这里最容易漏：返回箭头、系统返回键、操作行的「取消」
 * 三条出口只要有一条没接上判断，用户就会遇到「没被问就丢了半篇内容」。
 * 接了问但没接「放弃」的清理，又会留下永远恢复不完的草稿。
 *
 * 三条出口的语义按 [ContentDraftAutosaver] 的注释区分：
 * 「保存并离开」落一次业务变更并清草稿；「放弃草稿并离开」只清草稿；
 * 「继续编辑」什么都不做，自动保存照旧。
 */
@Composable
fun rememberEditorExitGuard(
    dirty: Boolean,
    onSaveAndClose: () -> Unit,
    onDiscardAndClose: () -> Unit,
    onLeave: () -> Unit,
): EditorExitGuard {
    val prompted = remember { mutableStateOf(false) }
    val requestLeave: () -> Unit = {
        if (dirty) prompted.value = true else onLeave()
    }
    BackHandler(enabled = !prompted.value) { requestLeave() }
    if (prompted.value) {
        AlertDialog(
            onDismissRequest = { prompted.value = false },
            title = { Text("有未保存的修改") },
            text = {
                Text(
                    "修改已经存进本机草稿，但没有保存为一次变更。" +
                        "选「放弃草稿并离开」会同时丢掉这份草稿。",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        prompted.value = false
                        onSaveAndClose()
                    },
                ) { Text("保存并离开") }
            },
            dismissButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { prompted.value = false }) { Text("继续编辑") }
                    TextButton(
                        onClick = {
                            prompted.value = false
                            onDiscardAndClose()
                        },
                    ) { Text("放弃草稿并离开", color = MaterialTheme.colorScheme.error) }
                }
            },
        )
    }
    return EditorExitGuard(requestLeave)
}

/** [rememberEditorExitGuard] 的返回值：把三条出口收敛成一个 `requestLeave`。 */
class EditorExitGuard internal constructor(val requestLeave: () -> Unit)

private fun formatNumber(value: Double, integerOnly: Boolean): String =
    if (integerOnly || value == value.toLong().toDouble()) value.toLong().toString() else value.toString()
