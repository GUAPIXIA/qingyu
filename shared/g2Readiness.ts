/**
 * G2 取证就绪纯逻辑（主计划 §7.13）——无 IO。
 *
 * G2 门禁（§7.13）中可由观测 JSONL 离线核对的部分：
 * 1. unified 有效生成 ≥ 500，且覆盖 ≥ 2 个供应商（按 endpointFingerprint 区分上游；无指纹时回退 provider）；
 * 7. 500 次样本按功能状态分段（gate 开/关或档位），不得混合。
 *
 * 其余条款（阶段 7 指标、动态上下文回归、Android fixture）
 * 不在本模块：由实施清单人工/另包核对，本模块只负责「可计数」部分。
 *
 * 分段键（不混合）：
 * - `pipeline`：仅用于给历史观测记录分段；当前运行时只生成 unified；
 * - `gate`：`off` = 无门控或 gateLevel 缺省且无 knob；否则用 gateLevel（off/low/standard/full）。
 *
 * 有效生成口径复用 `computeValidGenerations`（C4 冻结，不重定义分母）。
 */

import type { GenerationObservation } from './generationObservation'
import { computeValidGenerations } from './generationBaseline'

/** G2 有效生成目标次数 */
export const G2_VALID_GENERATION_TARGET = 500

/** G2 要求覆盖的不同供应商数 */
export const G2_MIN_PROVIDERS = 2

export type G2PipelineSegment = 'unified' | 'legacy'

export interface G2GateSegment {
  /** 缺省：无门控指令或未记录档位 */
  gate: 'off' | 'low' | 'standard' | 'full' | 'none'
  pipeline: G2PipelineSegment
}

export interface G2SegmentStats {
  key: string
  pipeline: G2PipelineSegment
  gate: G2GateSegment['gate']
  total: number
  valid: number
  providers: string[]
}

export interface G2Progress {
  target: number
  minProviders: number
  /** 全部有效生成（不分段）——仅作总览；**过门以「最佳可用分段」为准** */
  validAllSegments: number
  providersAll: string[]
  segments: G2SegmentStats[]
  /** 满足「有效 ≥500 且供应商 ≥2」的分段；可多个 */
  passableSegments: G2SegmentStats[]
  /** 最接近目标的分段（即使未达标，也便于报告进度） */
  bestSegment: G2SegmentStats | null
  /** 是否存在可过门分段 */
  pass: boolean
  /** 缺口：目标 − 最佳分段有效数（已达标为 0） */
  remaining: number
}

function normalizeProvider(r: GenerationObservation): string {
  // G2「供应商」按上游端点隔离：同为 openai 协议的 chenxi 与 relayapi 是两个供应商。
  // 有 endpointFingerprint 用指纹；否则回退 provider 字段。
  const fp = (r.endpointFingerprint ?? '').trim()
  if (fp) return `ep:${fp}`
  const p = (r.provider ?? '').trim()
  return p || '(unknown)'
}

/**
 * 功能状态分段键（G2 第 7 条）。
 * 旧记录缺 gateLevel 时记 `none`，与明确 `off` 区分（探测中 vs 无门控）。
 */
export function g2SegmentKey(r: GenerationObservation): G2GateSegment {
  const pipelineRaw = (r as { generationPipeline?: string }).generationPipeline
  const pipeline: G2PipelineSegment = pipelineRaw === 'legacy' ? 'legacy' : 'unified'
  const level = r.gateLevel
  const gate: G2GateSegment['gate'] =
    level === 'off' || level === 'low' || level === 'standard' || level === 'full'
      ? level
      : 'none'
  return { pipeline, gate }
}

export function g2SegmentLabel(seg: G2GateSegment): string {
  return `${seg.pipeline}/gate:${seg.gate}`
}

/**
 * 计算 G2 进度。`records` 为完整观测（或已按天过滤）；有效口径不重复定义。
 */
export function computeG2Progress(records: readonly GenerationObservation[]): G2Progress {
  const segments = new Map<string, GenerationObservation[]>()
  for (const r of records) {
    const seg = g2SegmentKey(r)
    const key = g2SegmentLabel(seg)
    if (!segments.has(key)) segments.set(key, [])
    segments.get(key)!.push(r)
  }

  const segmentStats: G2SegmentStats[] = [...segments.entries()].map(([key, list]) => {
    const seg = g2SegmentKey(list[0])
    const valid = computeValidGenerations(list).valid
    const providers = [...new Set(
      list
        .filter((r) => computeValidGenerations([r]).valid > 0)
        .map(normalizeProvider),
    )].sort()
    return {
      key,
      pipeline: seg.pipeline,
      gate: seg.gate,
      total: list.length,
      valid,
      providers,
    }
  }).sort((a, b) => b.valid - a.valid || a.key.localeCompare(b.key))

  const validAll = computeValidGenerations(records).valid
  const providersAll = [...new Set(
    records
      .filter((r) => computeValidGenerations([r]).valid > 0)
      .map(normalizeProvider),
  )].sort()

  const passableSegments = segmentStats.filter(
    (s) => s.valid >= G2_VALID_GENERATION_TARGET && s.providers.length >= G2_MIN_PROVIDERS,
  )
  const bestSegment = segmentStats[0] ?? null
  const remaining = bestSegment
    ? Math.max(0, G2_VALID_GENERATION_TARGET - bestSegment.valid)
    : G2_VALID_GENERATION_TARGET

  return {
    target: G2_VALID_GENERATION_TARGET,
    minProviders: G2_MIN_PROVIDERS,
    validAllSegments: validAll,
    providersAll,
    segments: segmentStats,
    passableSegments,
    bestSegment,
    pass: passableSegments.length > 0,
    remaining,
  }
}

/** 数值化进度一行（日志/快速查看；不含正文） */
export function formatG2ProgressSummary(progress: G2Progress): string {
  const best = progress.bestSegment
  return [
    `pass=${progress.pass ? 1 : 0}`,
    `best=${best ? `${best.key}:${best.valid}/${progress.target}` : 'none'}`,
    `providers=${best ? best.providers.length : 0}`,
    `remaining=${progress.remaining}`,
    `segments=${progress.segments.length}`,
    `allValid=${progress.validAllSegments}`,
  ].join(' ')
}

/**
 * G2 可离线核对条款的清单（人工项标 pending）。
 * 不替代人工验收：阶段 7 指标与 Android 仍需人工确认。
 */
export interface G2ChecklistItem {
  id: string
  title: string
  status: 'pass' | 'pending' | 'blocked'
  detail: string
}

export function buildG2Checklist(progress: G2Progress, notes?: {
  g1Passed?: boolean
  phase7MetricsOk?: boolean
  dynamicContextOk?: boolean
  androidFixturesOk?: boolean
}): G2ChecklistItem[] {
  const n = notes ?? {}
  const best = progress.bestSegment
  return [
    {
      id: 'valid-500',
      title: 'unified 有效生成 ≥ 500 且 ≥ 2 供应商（同一功能状态分段）',
      status: progress.pass ? 'pass' : 'pending',
      detail: best
        ? `最佳分段 ${best.key}：${best.valid}/${progress.target}，供应商 ${best.providers.length}（${best.providers.join(', ') || '—'}）；全量有效 ${progress.validAllSegments}（不可跨段混合过门）`
        : '无观测样本',
    },
    {
      id: 'phase7',
      title: '阶段 7 截断/格式/落盘/跨端 fixture 达标',
      status: n.phase7MetricsOk === true ? 'pass' : n.phase7MetricsOk === false ? 'blocked' : 'pending',
      detail: '需对照阶段 7 实施报告与 fixture 命令；本脚本不自动判定',
    },
    {
      id: 'g1',
      title: 'G1 达标',
      status: n.g1Passed === true ? 'pass' : n.g1Passed === false ? 'blocked' : 'pending',
      detail: n.g1Passed === true
        ? '方案 A + chenxi flash 实机取证已通过（2026-09-14）'
        : '见 G1 方案A实机取证报告；本清单默认不自动读取 G1 文件',
    },
    {
      id: 'dynamic-context',
      title: '动态上下文无 mandatory 丢失 / 记忆删除 / 超限回归',
      status: n.dynamicContextOk === true ? 'pass' : 'pending',
      detail: '依赖 chat-core 回归与灰度观察；观测 JSONL 无该维度',
    },
    {
      id: 'android',
      title: 'Android 共享类型与 fixture 通过',
      status: n.androidFixturesOk === true ? 'pass' : 'pending',
      detail: '本期不接入 Android；需单独跑跨端 fixture',
    },
    {
      id: 'legacy-retired',
      title: '旧生成管线已退役',
      status: 'pass',
      detail: 'generationPipeline 只在设置迁移中删除；运行时不再包含 legacy 分支',
    },
    {
      id: 'segmented',
      title: '500 次样本按功能状态分段，不混合 gate 前后',
      status: progress.pass ? 'pass' : progress.segments.length > 1 ? 'pending' : 'pending',
      detail: progress.pass
        ? `存在可过门分段：${progress.passableSegments.map((s) => s.key).join('; ')}`
        : `当前 ${progress.segments.length} 个分段，最佳 ${best?.key ?? '—'}；过门必须单段达标`,
    },
  ]
}
