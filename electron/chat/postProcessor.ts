 
/**
 * V12-07 PostProcessor：统一 output 正则与 stopStrings（实施方案 §13.1 步骤 14）
 *
 * - 两阶段：text 先，markdown 后（与 src/utils/regex 语义一致）
 * - stopStrings 截断在正则之后
 */
import { applyOutputRegexRules, truncateAtStop, collectStopStrings } from '../../src/utils/regex'
import type { RegexRule } from '../../shared/types'
import { readRules } from '../ipc/regex'

export interface PostProcessResult {
  text: string
  truncated: boolean
}

export function postProcessOutput(raw: string, rules?: RegexRule[]): PostProcessResult {
  const r = rules ?? readRules()
  const text = applyOutputRegexRules(raw, r)
  const { text: truncated, stopped } = truncateAtStop(text, collectStopStrings(r))
  return { text: truncated, truncated: stopped }
}

export function getStopStrings(rules?: RegexRule[]): string[] {
  return collectStopStrings(rules ?? readRules())
}
