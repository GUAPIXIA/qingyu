import type { CanonicalLorebookDocumentV2, JsonValue } from './domain/v2'
import type { LorebookCompatibilityIssue } from './adapters/types'

/**
 * 导入边界的安全与体积上限（方案 §15、§6.5）。
 * 只约束外部数据进入时的规模；用户后续编辑不在此限制范围内，
 * 存量世界书也不会因为上限调整而无法保存。
 */
export const LOREBOOK_IMPORT_LIMITS = {
  /** 单个导入文件的最大字节数（与自动匹配扫描的 20 MB 上限一致） */
  maxFileBytes: 20 * 1024 * 1024,
  /** 一次导入的最大条目数 */
  maxEntries: 20_000,
  /** 单条正文最大字符数 */
  maxEntryContentChars: 200_000,
  /** JSON 最大嵌套深度（防御超深结构导致遍历栈溢出） */
  maxJsonDepth: 64,
  /** 单条目 foreign 保留区最大字符数 */
  maxForeignCharsPerEntry: 32 * 1024,
  /** 整本书 foreign 保留区最大字符数 */
  maxForeignCharsPerBook: 512 * 1024,
  /** 正则 pattern 最大长度 */
  maxRegexPatternLength: 1000,
} as const

/** 允许的正则 flags 白名单（方案 §15：正则限制长度和 flags）。 */
export const LOREBOOK_REGEX_ALLOWED_FLAGS = 'gimsuy'

/**
 * 迭代检查 JSON 嵌套深度。递归遍历在超深结构上本身会栈溢出，
 * 因此这里使用显式栈，在到达上限时立即抛错。
 */
export function assertImportJsonDepth(
  value: unknown,
  maxDepth = LOREBOOK_IMPORT_LIMITS.maxJsonDepth,
): void {
  if (!value || typeof value !== 'object') return
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > maxDepth) {
      throw new Error(`JSON 嵌套深度超过限制（${maxDepth} 层），已拒绝导入`)
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        if (item && typeof item === 'object') stack.push({ value: item, depth: current.depth + 1 })
      }
    } else if (typeof current.value === 'object') {
      for (const item of Object.values(current.value as Record<string, unknown>)) {
        if (item && typeof item === 'object') stack.push({ value: item, depth: current.depth + 1 })
      }
    }
  }
}

function issue(
  severity: LorebookCompatibilityIssue['severity'],
  action: LorebookCompatibilityIssue['action'],
  code: string,
  path: string,
  message: string,
): LorebookCompatibilityIssue {
  return { severity, action, code, path, message }
}

function charsOf(value: JsonValue | undefined): number {
  return value === undefined ? 0 : JSON.stringify(value).length
}

/**
 * 对导入产物执行方案 §6.5/§15 的上限检查：
 * 超限的保留区丢弃并显式报告，正文/条目数超限则以 rejected 拒绝整个导入。
 * 直接在传入 document 上就地裁剪（导入产物是 adapter 新建的对象，无共享引用）。
 */
export function enforceImportDocumentLimits(
  document: CanonicalLorebookDocumentV2,
): LorebookCompatibilityIssue[] {
  const issues: LorebookCompatibilityIssue[] = []
  if (document.entries.length > LOREBOOK_IMPORT_LIMITS.maxEntries) {
    issues.push(issue('error', 'rejected', 'too_many_entries', '$.entries',
      `条目数 ${document.entries.length} 超过上限 ${LOREBOOK_IMPORT_LIMITS.maxEntries}，已拒绝导入`))
    return issues
  }

  let foreignBudget = LOREBOOK_IMPORT_LIMITS.maxForeignCharsPerBook
  const applyForeignCap = (
    foreign: Record<string, JsonValue> | undefined,
    path: string,
  ): Record<string, JsonValue> | undefined => {
    if (!foreign) return foreign
    let kept: Record<string, JsonValue> | undefined
    for (const [namespace, value] of Object.entries(foreign)) {
      const size = charsOf(value)
      if (size > LOREBOOK_IMPORT_LIMITS.maxForeignCharsPerEntry) {
        issues.push(issue('warning', 'dropped', 'foreign_entry_too_large', `${path}.${namespace}`,
          `未知字段保留区「${namespace}」（约 ${size} 字符）超过单条上限，已丢弃；正文与触发词不受影响`))
        continue
      }
      if (size > foreignBudget) {
        issues.push(issue('warning', 'dropped', 'foreign_budget_exhausted', `${path}.${namespace}`,
          `全书未知字段保留区总量超过上限（${LOREBOOK_IMPORT_LIMITS.maxForeignCharsPerBook} 字符），已丢弃「${namespace}」`))
        continue
      }
      foreignBudget -= size
      kept = { ...(kept ?? {}), [namespace]: value }
    }
    return kept
  }

  document.foreign = applyForeignCap(document.foreign, '$')
  document.entries.forEach((entry, index) => {
    const path = `$.entries[${index}]`
    if (entry.content.length > LOREBOOK_IMPORT_LIMITS.maxEntryContentChars) {
      issues.push(issue('error', 'rejected', 'entry_content_too_long', `${path}.content`,
        `条目正文 ${entry.content.length} 字符超过单条上限 ${LOREBOOK_IMPORT_LIMITS.maxEntryContentChars}，已拒绝导入`))
    }
    entry.foreign = applyForeignCap(entry.foreign, path)
    if (entry.activation.regex.enabled) {
      const flags = [...entry.activation.regex.flags]
        .filter((flag) => LOREBOOK_REGEX_ALLOWED_FLAGS.includes(flag))
        .join('')
      if (flags !== entry.activation.regex.flags) {
        issues.push(issue('warning', 'approximated', 'regex_flags_sanitized', `${path}.activation.regex`,
          `正则 flags「${entry.activation.regex.flags}」包含不支持或危险的标志，已调整为「${flags || '（无）'}」`))
        entry.activation.regex = { ...entry.activation.regex, flags }
      }
      const dropLongPatterns = (keys: string[]): string[] => keys.filter((key) => {
        if (key.length <= LOREBOOK_IMPORT_LIMITS.maxRegexPatternLength) return true
        issues.push(issue('warning', 'dropped', 'regex_pattern_too_long', `${path}.activation`,
          `正则表达式长度 ${key.length} 超过上限 ${LOREBOOK_IMPORT_LIMITS.maxRegexPatternLength}，该关键词已被丢弃`))
        return false
      })
      entry.activation.primaryKeys = dropLongPatterns(entry.activation.primaryKeys)
      entry.activation.secondaryKeys = dropLongPatterns(entry.activation.secondaryKeys)
    }
  })
  return issues
}
