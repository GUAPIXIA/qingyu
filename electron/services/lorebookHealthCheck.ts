import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalLorebookDocumentV2 } from '../../shared/lorebook/domain/v2'
import type {
  LorebookHealthIssue,
  LorebookHealthIssueKind,
  LorebookHealthReport,
} from '../../shared/lorebook/health'
import { DIRS } from './storage'
import { readLorebookDocument } from './lorebookDocumentStore'
import { getVectorIndex } from './vectorStore'
import { isEmbeddingConfigured } from './embedding'
import { readSettingsFromDisk } from '../ipc/settings'
import { createLogger } from './logger'

const log = createLogger('lorebook-health')

export interface LorebookHealthIndexInfo {
  /** 该书当前模型空间下向量索引中已标记过期的条目数。 */
  staleCount: number
  /** 该书存在向量索引，但不是当前语义配置生成的（不会使用）。 */
  modelMismatch: boolean
}

export interface LorebookHealthInput {
  semanticAvailable: boolean
  indexInfo: Record<string, LorebookHealthIndexInfo | undefined>
}

function issue(
  kind: LorebookHealthIssueKind,
  bookId: string,
  bookName: string,
  detail: string,
  entryId?: string,
): LorebookHealthIssue {
  return { kind, bookId, bookName, detail, ...(entryId ? { entryId } : {}) }
}

function regexPatterns(entry: CanonicalLorebookDocumentV2['entries'][number]): string[] {
  return [...entry.activation.primaryKeys, ...entry.activation.secondaryKeys, ...entry.activation.aliases]
}

/** 死条目：启用了但按当前配置永远无法触发。判定与运行时 isSemanticDeadEntry 对齐。 */
function deadEntryReason(entry: CanonicalLorebookDocumentV2['entries'][number], semanticAvailable: boolean): string | null {
  if (!entry.enabled || entry.activation.mode === 'constant') return null
  // 运行时规则：只有显式 semanticRequired 才在无语义服务时整条停用（无论有无关键词）
  if (entry.activation.retrieval === 'semanticRequired' && !semanticAvailable) {
    return '语义必需（semanticRequired）条目在未配置语义服务时停用'
  }
  const hasKeywordPath = entry.activation.primaryKeys.length > 0
    || entry.activation.aliases.length > 0
    || entry.activation.regex.enabled
  if (!hasKeywordPath && entry.activation.retrieval === 'keyword') {
    return '关键词条目没有任何关键词或正则，无法触发'
  }
  // 无关键词的 semanticPreferred/hybrid 条目由本地词法检索兜底，不算死条目
  return null
}

/** 纯分析函数：对给定的 canonical 文档执行健康检查。 */
export function analyzeLorebookHealth(
  books: Array<{ id: string; name: string; document: CanonicalLorebookDocumentV2 }>,
  input: LorebookHealthInput,
): LorebookHealthReport {
  const issues: LorebookHealthIssue[] = []
  let entryCount = 0
  for (const { document } of books) {
    const bookId = document.id
    const bookName = document.name
    entryCount += document.entries.length

    const seen = new Set<string>()
    for (const entry of document.entries) {
      if (seen.has(entry.id)) {
        issues.push(issue('duplicate_id', bookId, bookName, `条目 ID 重复：${entry.id}`, entry.id))
      }
      seen.add(entry.id)

      if (entry.activation.regex.enabled) {
        for (const pattern of regexPatterns(entry)) {
          try {
            new RegExp(pattern, entry.activation.regex.flags)
          } catch (error) {
            issues.push(issue('invalid_regex', bookId, bookName,
              `正则 /${pattern}/${entry.activation.regex.flags} 无法编译：${error instanceof Error ? error.message : String(error)}`,
              entry.id))
          }
        }
      }

      const deadReason = deadEntryReason(entry, input.semanticAvailable)
      if (deadReason) issues.push(issue('dead_entry', bookId, bookName, deadReason, entry.id))

      if (entry.insertion.kind === 'outlet') {
        issues.push(issue('unexecutable_position', bookId, bookName,
          `命名 outlet「${entry.insertion.name}」在当前聊天协议下回退到 prompt_end`, entry.id))
      } else if (entry.insertion.kind === 'custom') {
        issues.push(issue('unexecutable_position', bookId, bookName,
          `自定义插入位置在当前聊天协议下回退到 prompt_end`, entry.id))
      }
    }

    const indexInfo = input.indexInfo[bookId]
    if (indexInfo?.staleCount) {
      issues.push(issue('stale_index', bookId, bookName,
        `${indexInfo.staleCount} 条向量已过期（内容已变化），重建索引后消除`))
    }
    if (indexInfo?.modelMismatch) {
      issues.push(issue('stale_index', bookId, bookName,
        '存在向量索引，但不是当前语义配置生成的，检索时不会使用'))
    }
  }

  const summary = issues.reduce((acc, item) => {
    acc[item.kind] += 1
    return acc
  }, { duplicate_id: 0, invalid_regex: 0, dead_entry: 0, unexecutable_position: 0, stale_index: 0 } as Record<LorebookHealthIssueKind, number>)

  return {
    checkedAt: Date.now(),
    bookCount: books.length,
    entryCount,
    issues,
    summary,
    ok: issues.length === 0,
  }
}

/** 收集磁盘上的世界书与向量索引状态并执行健康检查。 */
export function runLorebookHealthCheck(): LorebookHealthReport {
  const semanticTrigger = readSettingsFromDisk().semanticTrigger
  const semanticAvailable = semanticTrigger?.enabled === true
    && isEmbeddingConfigured({
      provider: semanticTrigger.provider,
      baseUrl: semanticTrigger.baseUrl,
      model: semanticTrigger.model,
      apiKey: semanticTrigger.apiKey ?? '',
    })

  const files = readdirSync(DIRS.lorebooks()).filter((name) => name.endsWith('.json'))
  const books: Array<{ id: string; name: string; document: CanonicalLorebookDocumentV2 }> = []
  const indexInfo: Record<string, LorebookHealthIndexInfo | undefined> = {}
  for (const file of files) {
    const document = readLorebookDocument(join(DIRS.lorebooks(), file))
    if (!document) continue
    books.push({ id: document.id, name: document.name, document })

    const configuredModel = semanticTrigger?.model
    const currentIndex = configuredModel ? getVectorIndex(document.id, {
      provider: semanticTrigger!.provider,
      model: configuredModel,
      modelId: semanticTrigger!.provider === 'local' ? configuredModel.split('@')[0] : undefined,
      modelVersion: semanticTrigger!.provider === 'local' ? configuredModel.split('@')[1] : undefined,
    }) : null
    const defaultIndex = getVectorIndex(document.id)
    indexInfo[document.id] = {
      staleCount: currentIndex ? (currentIndex.stale?.length ?? 0) : 0,
      modelMismatch: !currentIndex && !!defaultIndex,
    }
  }

  const report = analyzeLorebookHealth(books, { semanticAvailable, indexInfo })
  log.info('世界书健康检查完成', {
    books: report.bookCount,
    entries: report.entryCount,
    issues: report.issues.length,
  })
  return report
}
