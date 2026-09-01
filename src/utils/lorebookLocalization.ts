import type { Lorebook } from '../../shared/types'
import type { LorebookKeywordLocalizationSuggestion } from '../../shared/ipc-api'

const LATIN_WORD = /[A-Za-z]{2,}/

/** 只把确实含英文线索的条目交给模型，避免无意义地重写纯中文世界书。 */
export function isEnglishLoreEntry(entry: Lorebook['entries'][number]): boolean {
  return LATIN_WORD.test(`${entry.keywords.join(' ')} ${entry.content}`)
}

/** 保留原关键词，以大小写不敏感方式去重追加用户确认过的别名；写入生成来源（方案 7.5）。 */
export function appendLocalizedKeywords(
  lorebook: Lorebook,
  suggestions: LorebookKeywordLocalizationSuggestion[],
): Lorebook['entries'] {
  const aliasesByEntry = new Map(suggestions.map((item) => [item.entryId, item]))
  return lorebook.entries.map((entry) => {
    const suggestion = aliasesByEntry.get(entry.id)
    if (!suggestion?.aliases.length) return entry
    const seen = new Set(entry.keywords.map((keyword) => keyword.trim().toLocaleLowerCase()).filter(Boolean))
    const appended: string[] = []
    for (const alias of suggestion.aliases) {
      const normalized = alias.trim().toLocaleLowerCase()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      appended.push(alias)
    }
    if (appended.length === 0) return entry
    // 生成来源记录（provider/model/时间）：仅追溯展示，不参与匹配。
    const keywordProvenance = { ...(entry.keywordProvenance ?? {}) }
    if (suggestion.source) {
      for (const alias of appended) {
        keywordProvenance[alias] = { ...suggestion.source }
      }
    }
    return {
      ...entry,
      keywords: [...entry.keywords, ...appended],
      ...(suggestion.source ? { keywordProvenance } : {}),
    }
  })
}
