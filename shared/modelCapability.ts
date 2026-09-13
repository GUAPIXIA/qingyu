/**
 * 阶段8/W6（主计划 §7.8）：运行时能力纠正的端点隔离数据层——纯函数，无 IO。
 *
 * 规则：
 * - 纠正按 (provider + 端点指纹 + model) 隔离：同名模型在不同端点互不影响；
 * - 只允许收紧：合并时取 min（由 resolveModelOutputProfile 保证），本模块只存事实；
 * - 用户覆盖由调用方传入（设置层），优先级高于内置能力、低于"错误只收紧"的物理事实。
 */

import { endpointFingerprint } from './endpointKey'
import {
  resolveModelOutputProfile,
  type ModelCapabilityCorrection,
  type ModelOutputProfile,
  type ModelProfileUserOverride,
} from './modelOutputProfile'

export interface CapabilityScope {
  provider: string
  baseUrl: string
  model: string
}

/** 端点级键：与用量档案/门控探测同一指纹口径（不含凭据与完整 URL） */
export function capabilityScopeKey(scope: CapabilityScope): string {
  return JSON.stringify([
    scope.provider ?? '',
    endpointFingerprint(scope.baseUrl ?? ''),
    scope.model ?? '',
  ])
}

export interface ModelCapabilityStore {
  /** 记录一次纠正（同键多次记录取"最近一次"，收紧语义由解析器保证） */
  noteCorrection(scope: CapabilityScope, correction: ModelCapabilityCorrection): void
  getCorrection(scope: CapabilityScope): ModelCapabilityCorrection | null
  /** 重置单个端点或全部（供"重置模型探测"入口复用） */
  reset(scope?: CapabilityScope): void
  size(): number
}

export function createModelCapabilityStore(): ModelCapabilityStore {
  const corrections = new Map<string, ModelCapabilityCorrection>()
  return {
    noteCorrection(scope, correction) {
      if (!scope.model) return
      corrections.set(capabilityScopeKey(scope), correction)
    },
    getCorrection(scope) {
      return corrections.get(capabilityScopeKey(scope)) ?? null
    },
    reset(scope) {
      if (!scope) {
        corrections.clear()
        return
      }
      corrections.delete(capabilityScopeKey(scope))
    },
    size() {
      return corrections.size
    },
  }
}

/**
 * 端点级完整解析：内置能力 → 用户覆盖 → 该端点的运行时纠正（只能收紧）。
 * 调用方必须传入该端点的纠正记录，绝不能拿其他端点的记录来"借用"能力。
 */
export function resolveEndpointOutputProfile(input: {
  model: string
  scope: CapabilityScope
  store: ModelCapabilityStore
  userOverride?: ModelProfileUserOverride
}): ModelOutputProfile {
  const correction = input.store.getCorrection(input.scope)
  return resolveModelOutputProfile(input.model, {
    userOverride: input.userOverride,
    ...(correction ? { runtimeCorrection: correction } : {}),
  })
}
