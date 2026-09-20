package com.qingyu.companion.ui.startup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.migration.LegacyCacheImporter
import com.qingyu.companion.local.migration.LegacyCacheReader
import com.qingyu.companion.local.migration.LegacyCacheScan
import com.qingyu.companion.local.migration.LegacyImportChoice
import com.qingyu.companion.local.migration.LegacyImportResult
import com.qingyu.companion.local.migration.LegacyImportWarning
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 阶段 3 S3-07：本地初始化 / 旧缓存迁移向导状态。
 *
 * 三选一（[LegacyImportChoice]），不存在第四条路径，也不存在「先跳过以后再进旧模式」。
 */
sealed interface LocalSetupState {
    data object Scanning : LocalSetupState

    /** 无旧缓存：直接创建本地资料（不需要用户做迁移决定）。 */
    data object FreshLocal : LocalSetupState

    /** 检测到旧缓存：必须由用户显式选择。 */
    data class DecideMigration(
        val scan: LegacyCacheScan,
        val warnings: List<LegacyImportWarning>,
    ) : LocalSetupState

    data object Importing : LocalSetupState

    data class ImportFailed(val message: String) : LocalSetupState

    data class Done(val result: LegacyImportResult) : LocalSetupState

    /** 用户选择「退出升级，暂不启动新版」。 */
    data object Aborted : LocalSetupState

    /** 用户选择「备份旧缓存后不导入」。 */
    data object BackedUpAndSkipped : LocalSetupState
}

/**
 * 本地初始化向导（不访问网络）。
 *
 * 迁移失败语义（阶段 3 §5 回滚）：
 * 删除未提交的新主库内容 → 输出诊断 → 停留在迁移修复页；
 * **绝不** destructive fallback，也**绝不**改写旧缓存。
 */
class LocalSetupViewModel(
    private val store: LocalStore,
    private val reader: LegacyCacheReader,
    private val importer: LegacyCacheImporter,
) : ViewModel() {

    private val _state = MutableStateFlow<LocalSetupState>(LocalSetupState.Scanning)
    val state: StateFlow<LocalSetupState> = _state.asStateFlow()

    init {
        scan()
    }

    fun scan() {
        _state.value = LocalSetupState.Scanning
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    if (!reader.legacyDatabaseExists()) {
                        return@runCatching LocalSetupState.FreshLocal
                    }
                    // 先做只读快照：绝不把旧库原地交给新版 Room
                    val snapshot = reader.snapshotLegacyCache()
                    if (!snapshot.created) return@runCatching LocalSetupState.FreshLocal
                    val db = reader.openSnapshot()
                        ?: return@runCatching LocalSetupState.DecideMigration(
                            LegacyCacheScan(extraWarnings = listOf("旧缓存快照无法打开，只能备份后不导入")),
                            emptyList(),
                        )
                    try {
                        if (reader.isCorrupted(db)) {
                            return@runCatching LocalSetupState.DecideMigration(
                                LegacyCacheScan(extraWarnings = listOf("旧缓存已损坏，只能备份后不导入")),
                                emptyList(),
                            )
                        }
                        val scan = reader.scan(db)
                        LocalSetupState.DecideMigration(scan, importer.evaluate(scan))
                    } finally {
                        db.close()
                    }
                }.getOrElse { error ->
                    LocalSetupState.ImportFailed("扫描旧缓存失败：${error.message ?: error::class.simpleName}")
                }
            }
            _state.value = result
        }
    }

    fun choose(choice: LegacyImportChoice) {
        when (choice) {
            LegacyImportChoice.AbortUpgrade -> {
                // 不改写旧库、不创建新资料；进程内只显示提示，由用户主动退出
                _state.value = LocalSetupState.Aborted
            }
            LegacyImportChoice.BackupAndSkip -> viewModelScope.launch {
                _state.value = withContext(Dispatchers.IO) {
                    try {
                        // 快照已经落盘即为「备份」；随后初始化本地资料但不导入任何旧内容
                        reader.snapshotLegacyCache()
                        store.initDeviceState()
                        LocalSetupState.BackedUpAndSkipped
                    } catch (error: Throwable) {
                        LocalSetupState.ImportFailed(
                            "备份旧缓存失败：${error.message ?: error::class.simpleName}",
                        )
                    }
                }
            }
            LegacyImportChoice.ImportAsLocalCopy -> viewModelScope.launch {
                _state.value = LocalSetupState.Importing
                val outcome = withContext(Dispatchers.IO) {
                    runCatching {
                        val db = reader.openSnapshot()
                            ?: throw IllegalStateException("旧缓存快照不存在")
                        try {
                            store.initDeviceState()
                            importer.importInto(db, store)
                        } finally {
                            db.close()
                        }
                    }
                }
                _state.value = outcome.fold(
                    onSuccess = { LocalSetupState.Done(it) },
                    onFailure = { error ->
                        // 阶段 3 §5：失败时删除未提交的新主库内容，停留在迁移修复页。
                        val cleared = runCatching { clearUncommittedLocalData() }.isSuccess
                        LocalSetupState.ImportFailed(
                            "导入失败：${error.message ?: error::class.simpleName}" +
                                if (cleared) "（已回滚未提交的本地数据，可重新执行）" else "（回滚未完成，请勿重试直到问题修复）",
                        )
                    },
                )
            }
        }
    }

    /**
     * 回滚未提交的导入结果：逐条删除已导入实体（写 tombstone），
     * 不触碰旧缓存快照，也不做 destructive 清库。
     */
    private suspend fun clearUncommittedLocalData() {
        store.listCharacters().forEach { store.deleteCharacter(it.id) }
        store.listSessions().forEach { store.deleteSession(it.id) }
    }
}
