/**
 * 阶段8（主计划 W4 §4.5）：单聊门控会话状态（进程内存，渲染层）。
 *
 * - 开关：`Settings.reasoningGateEnabled`（默认关闭）。关闭时完全不介入，
 *   主对话保持 `reasoningMode` 旧路径（W11 清理旧分支前的回退面）。
 * - 起步档：默认 `standard`；deepseek-v4 系沿用既有"主对话关闭推理"产品意图（off）。
 * - 会话熔断：同一 (provider+model) 连续两次降档恢复失败后，后续请求从 `low` 起步，
 *   且熔断提示只展示一次（阶段8 §4.5）。
 */

import { endpointFingerprint } from '../../shared/endpointKey'
import {
  resolveDefaultGateLevel,
  resolveReasoningGate,
  type ReasoningGateLevel,
  type ResolvedReasoningGate,
} from '../../shared/reasoningGate'
import { useSettingsStore } from './useSettingsStore'
import { cachedReasoningSamplesFor } from './usageProfileCache'
import type { Settings } from '../../shared/types'

/** 连续降档失败达到该次数即熔断（阶段8 §4.5：连续 2 次） */
export const GATE_BREAKER_THRESHOLD = 2

const failures = new Map<string, number>()
const noticeShown = new Set<string>()

export interface GateScopeInput {
  provider: string
  baseUrl: string
  model: string
  /** 任务维度：方向等辅助任务单独计熔断，不影响主对话起步档 */
  task?: string
}

/** 作用域键（JSON 数组，避免分隔符碰撞） */
export function gateScopeKeyOf(scope: GateScopeInput): string {
  return JSON.stringify([
    scope.provider ?? '',
    endpointFingerprint(scope.baseUrl ?? ''),
    scope.model ?? '',
    scope.task ?? 'main',
  ])
}

export function isReasoningGateEnabled(_settings: Pick<Settings, 'reasoningGateEnabled'> | undefined): boolean {
  // W11（§7.14）：G1 已通过，门控视为常开；旧字段忽略（兼容读）。
  void _settings
  return true
}

/**
 * 主对话起步档：deepseek-v4 系沿用既有"关闭推理"意图（off），其余按端点默认（standard）。
 * kill switch 关闭或缺少连接信息时返回 undefined = 不介入。
 */
export function resolveChatGateLevel(input: {
  settings: Pick<Settings, 'reasoningGateEnabled' | 'reasoningEffort'> | undefined
  provider?: string
  baseUrl?: string
  model: string
}): ReasoningGateLevel | undefined {
  const enabled = isReasoningGateEnabled(input.settings)
  if (!input.model) return undefined
  const scope = { provider: input.provider ?? '', baseUrl: input.baseUrl ?? '', model: input.model }
  // 熔断：连续降档失败后从更低档起步（阶段8 §4.5）
  if (enabled && isGateBreakerTripped(scope)) return 'low'
  if (enabled && input.settings?.reasoningEffort && input.settings.reasoningEffort !== 'auto') {
    return input.settings.reasoningEffort
  }
  return resolveDefaultGateLevel({ model: input.model, enabled })
}

/**
 * 便捷包装：按当前连接档案与开关解析本轮门控，返回可直接展开进计划/预算输入的对象。
 * 缺省（开关关闭/缺少信息）返回空对象 = 不介入。
 */
export function withReasoningGate(
  profile: { provider: string; baseUrl: string; model: string } | null | undefined,
  activeModel?: string,
  /** 降档恢复专用：直接指定本轮档位（跳过开关/熔断起步档解析） */
  levelOverride?: ReasoningGateLevel,
): { reasoningGate?: ResolvedReasoningGate } {
  if (!profile) return {}
  const model = activeModel || profile.model
  if (!model) return {}
  const level = levelOverride ?? resolveChatGateLevel({
    settings: useSettingsStore.getState().settings,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model,
  })
  if (!level) return {}
  // W1/§5.4：把用量档案回读的近期推理样本带进门控解析，使**不可信门控**的保守余量
  // 由实测 P90 驱动（静态档案余量在实测端点偏低，是"推理吃满正文为 0"的直接原因）。
  const samples = cachedReasoningSamplesFor({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model,
  })
  return {
    reasoningGate: resolveReasoningGate({
      model,
      requestedLevel: level,
      enabled: true,
      ...(samples ? { recentReasoningTokens: samples } : {}),
    }),
  }
}

export function isGateBreakerTripped(scope: GateScopeInput): boolean {
  return (failures.get(gateScopeKeyOf(scope)) ?? 0) >= GATE_BREAKER_THRESHOLD
}

/** 降档恢复失败：累计连续失败次数（达到阈值后后续请求从 low 起步） */
export function noteGateRecoveryFailure(scope: GateScopeInput): void {
  const key = gateScopeKeyOf(scope)
  failures.set(key, (failures.get(key) ?? 0) + 1)
}

/** 降档恢复成功：清零连续失败计数 */
export function noteGateRecoverySuccess(scope: GateScopeInput): void {
  failures.delete(gateScopeKeyOf(scope))
}

/** 熔断提示只展示一次：返回 true 表示本次应当提示 */
export function claimGateBreakerNotice(scope: GateScopeInput): boolean {
  const key = gateScopeKeyOf(scope)
  if (noticeShown.has(key)) return false
  noticeShown.add(key)
  return true
}

/** 测试专用：清空会话状态 */
export function resetReasoningGateStateForTests(): void {
  failures.clear()
  noticeShown.clear()
}
