/**
 * 阶段8（主计划 W3 §7.5）：GateProbe 会话级记录（进程内存）。
 *
 * 规则（阶段8 §4.3）：
 * - 只有明确 400 字段拒绝才写 `knobAccepted:false`；网络错误/用户取消不写任何状态；
 * - 静默忽略（off 档仍出现推理）写 `disableIgnored:true`，该端点后续 off 落到 none；
 * - 记录按 (provider + 端点指纹 + model) 隔离，同名模型不同端点互不污染。
 *
 * 作用范围：本次应用运行（进程内存）。跨启动的持久化在阶段 8.3/W6 接入设置存储，
 * 本模块是该持久化落地前的唯一读写入口，避免出现第二份探测状态。
 */

import { endpointFingerprint } from '../../shared/endpointKey'
import {
  mergeGateProbe,
  type GateProbe,
  type GateProbeSignal,
} from '../../shared/reasoningGate'

export interface GateProbeScope {
  provider: string
  baseUrl: string
  model: string
}

const probes = new Map<string, GateProbe>()

function scopeKeyOf(scope: GateProbeScope): string {
  return [scope.provider ?? '', endpointFingerprint(scope.baseUrl ?? ''), scope.model ?? ''].join('\u0000')
}

/** 读取该端点的探测记录（无记录返回 null = 未探测，预算按不可信处理） */
export function getGateProbe(scope: GateProbeScope): GateProbe | null {
  return probes.get(scopeKeyOf(scope)) ?? null
}

/** 合并一次探测结论（信号来自适配器；缺省字段保持旧值） */
export function recordGateProbeSignal(scope: GateProbeScope, signal: GateProbeSignal): void {
  if (!scope.model) return
  const current = probes.get(scopeKeyOf(scope)) ?? null
  probes.set(scopeKeyOf(scope), mergeGateProbe(current, {
    knob: signal.knob,
    ...(signal.knobAccepted !== undefined ? { knobAccepted: signal.knobAccepted } : {}),
    ...(signal.disableIgnored ? { disableIgnored: true } : {}),
    ...(signal.reportsReasoningUsage ? { reportsReasoningUsage: true } : {}),
    updatedAt: Date.now(),
  }))
}

/** 测试专用：清空会话探测记录 */
export function resetGateProbesForTests(): void {
  probes.clear()
}

/** 诊断：当前记录的端点数量（不暴露地址，只暴露计数） */
export function gateProbeCount(): number {
  return probes.size
}
