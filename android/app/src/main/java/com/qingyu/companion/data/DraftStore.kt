package com.qingyu.companion.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.draftDataStore by preferencesDataStore(name = "companion_drafts")

/**
 * 每会话草稿自动保存（路线图 5.2）：
 * - 按 sessionId 隔离
 * - 发送后清除
 * - 切换会话恢复
 */
class DraftStore(private val context: Context) {

    private fun key(sessionId: String) = stringPreferencesKey("draft_$sessionId")

    fun observeDraft(sessionId: String): Flow<String> =
        context.draftDataStore.data.map { prefs -> prefs[key(sessionId)] ?: "" }

    suspend fun getDraft(sessionId: String): String {
        val prefs = context.draftDataStore.data.first()
        return prefs[key(sessionId)] ?: ""
    }

    suspend fun saveDraft(sessionId: String, text: String) {
        if (text.isEmpty()) {
            context.draftDataStore.edit { it.remove(key(sessionId)) }
        } else {
            context.draftDataStore.edit { it[key(sessionId)] = text }
        }
    }

    suspend fun clearDraft(sessionId: String) {
        context.draftDataStore.edit { it.remove(key(sessionId)) }
    }
}
