/**
 * 正则规则引擎（纯函数，可测试）
 *
 * 覆盖路线图 1.6 的增强能力：
 * - 触发器（triggerPattern：文本匹配才执行）
 * - 停止字符串（stopStrings：output 命中后终止生成）
 * - 阶段（stage：text / markdown，markdown 仅在 output 的 text 规则之后应用）
 * - 分组（group：仅元数据，UI 组织用）
 * - 安全正则（长度 + ReDoS 防护）
 */

import type { RegexRule } from '../../shared/types'

/** 正则长度上限（防 ReDoS / 超长模式） */
const MAX_PATTERN_LENGTH = 500
/** 单次替换处理的文本长度上限 */
const MAX_TEXT_LENGTH = 200_000

/**
 * 安全创建正则：限制模式长度与标志合法性。
 * 失败返回 null。
 */
export function safeRegExp(pattern: string, flags?: string): RegExp | null {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return null
  try {
    return new RegExp(pattern, flags ?? 'g')
  } catch {
    return null
  }
}

/** 规则是否作用于指定 scope */
export function ruleMatchesScope(rule: RegexRule, scope: 'input' | 'output'): boolean {
  return rule.scope === scope || rule.scope === 'both'
}

/**
 * 规则是否作用于指定处理阶段。
 * text 阶段：input + output 均应用；markdown 阶段：仅 output（渲染前文本）。
 */
export function ruleMatchesStage(rule: RegexRule, scope: 'input' | 'output', stage: 'text' | 'markdown'): boolean {
  const ruleStage = rule.stage ?? 'text'
  if (stage === 'text') return ruleStage === 'text'
  // markdown 阶段仅 output
  if (scope !== 'output') return false
  return ruleStage === 'markdown'
}

/**
 * 触发条件检查：triggerPattern 为空 = 总是执行；
 * 非空时文本须匹配 triggerPattern 才执行。
 */
export function ruleTriggers(rule: RegexRule, text: string): boolean {
  if (!rule.triggerPattern?.trim()) return true
  const regex = safeRegExp(rule.triggerPattern.trim(), rule.triggerFlags || 'i')
  if (!regex) return false
  return regex.test(text)
}

export interface ApplyResult {
  text: string
  /** 实际应用的规则数 */
  applied: number
  /** 匹配到并发生了替换的规则数 */
  matched: number
}

/**
 * 应用单条规则（scope/stage/trigger 已过滤的场景由调用方控制，本函数只做触发检查 + 替换）。
 * @returns 替换后的文本 + 是否发生替换
 */
export function applyRuleOnce(text: string, rule: RegexRule): { text: string; replaced: boolean } {
  if (!rule.enabled || !rule.pattern?.trim()) return { text, replaced: false }
  if (!ruleTriggers(rule, text)) return { text, replaced: false }
  const regex = safeRegExp(rule.pattern.trim(), rule.flags || 'g')
  if (!regex) return { text, replaced: false }
  if (text.length > MAX_TEXT_LENGTH) return { text, replaced: false }
  try {
    const next = text.replace(regex, rule.replacement ?? '')
    return { text: next, replaced: next !== text }
  } catch {
    return { text, replaced: false }
  }
}

/**
 * 按顺序应用匹配 scope + stage 的规则（稳定顺序：规则列表原序）。
 */
export function applyRegexRules(
  text: string,
  rules: RegexRule[],
  scope: 'input' | 'output',
  stage: 'text' | 'markdown',
): ApplyResult {
  if (!text || rules.length === 0) return { text, applied: 0, matched: 0 }
  let result = text
  let applied = 0
  let matched = 0
  for (const rule of rules) {
    if (!rule.enabled) continue // M-30 修复：禁用的规则不计入 applied
    if (!ruleMatchesScope(rule, scope)) continue
    if (!ruleMatchesStage(rule, scope, stage)) continue
    applied++
    const r = applyRuleOnce(result, rule)
    if (r.replaced) matched++
    result = r.text
  }
  return { text: result, applied, matched }
}

/**
 * output 两阶段应用（增量共享：单聊 applyRegex 与群聊本地包装收敛于此）。
 * output 规则先 text 阶段后 markdown 阶段链式应用（渲染前文本）。
 */
export function applyOutputRegexRules(text: string, rules: RegexRule[]): string {
  if (!text || rules.length === 0) return text
  let result = applyRegexRules(text, rules, 'output', 'text').text
  result = applyRegexRules(result, rules, 'output', 'markdown').text
  return result
}

/**
 * 查找文本中第一个停止字符串的位置（按最短命中优先，保持列表顺序）。
 * 未命中返回 -1。
 */
export function findStopIndex(text: string, stopStrings: string[]): number {
  if (!text || !stopStrings?.length) return -1
  let best = -1
  for (const s of stopStrings) {
    if (!s) continue
    const idx = text.indexOf(s)
    if (idx !== -1 && (best === -1 || idx < best)) best = idx
  }
  return best
}

/**
 * 按停止字符串截断文本。
 * @returns 截断后的文本 + 是否命中
 */
export function truncateAtStop(text: string, stopStrings: string[]): { text: string; stopped: boolean } {
  const idx = findStopIndex(text, stopStrings)
  if (idx === -1) return { text, stopped: false }
  return { text: text.slice(0, idx).trimEnd(), stopped: true }
}

/** 提取所有启用 output 规则的停止字符串（去空去重，流式检测用） */
export function collectStopStrings(rules: RegexRule[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!ruleMatchesScope(rule, 'output')) continue
    if (rule.stage === 'markdown') continue // markdown 阶段在渲染层，不做流式终止
    for (const s of rule.stopStrings ?? []) {
      const t = s?.trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        result.push(t)
      }
    }
  }
  return result
}
