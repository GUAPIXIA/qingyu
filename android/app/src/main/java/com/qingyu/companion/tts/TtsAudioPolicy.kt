package com.qingyu.companion.tts

/**
 * S6-03 TTS 音频归属策略（与同步/备份边界对齐）：
 *
 * - **默认缓存**：TTS 音频是可重合成的派生数据，不是用户主数据，
 *   不进 media manifest，不进用户主数据同步/备份（丢了可重建）；
 * - **用户显式保存**的音频才升级为用户数据，进 media manifest，随主数据同步/备份
 *   （manifest 的实际写入由 media 层负责，本层只做归属判定）。
 */
enum class TtsAudioScope {
    /** 默认：派生缓存。 */
    CACHE_ONLY,

    /** 用户显式保存：进 media manifest 并参与同步/备份。 */
    USER_SAVED,
}

object TtsAudioPolicy {

    /** 归属判定的唯一入口：只有用户显式保存才升级。 */
    fun scopeFor(explicitUserSave: Boolean): TtsAudioScope =
        if (explicitUserSave) TtsAudioScope.USER_SAVED else TtsAudioScope.CACHE_ONLY

    fun isUserPrimaryData(scope: TtsAudioScope): Boolean = scope == TtsAudioScope.USER_SAVED

    /** 仅用户主数据进 media manifest。 */
    fun entersMediaManifest(scope: TtsAudioScope): Boolean = scope == TtsAudioScope.USER_SAVED

    /** 缓存音频不作为用户主数据同步。 */
    fun participatesInUserSync(scope: TtsAudioScope): Boolean = scope == TtsAudioScope.USER_SAVED

    /** 缓存音频不进备份（派生数据可重建）。 */
    fun participatesInBackup(scope: TtsAudioScope): Boolean = scope == TtsAudioScope.USER_SAVED
}
