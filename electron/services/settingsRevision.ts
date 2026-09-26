/**
 * PC 本地设置安全子集与内容寻址 revision。
 *
 * 从旧 bridge/settingsSync.ts 抽出：仅保留被 PC 本地写路径
 * （ipc/settings.ts 变更总线、domain/bootstrapScanners.ts 启动扫描）使用的
 * toMobileSafeSettings / computeRevision / diffMobileSafeFields。
 * 旧伴侣 PATCH/快照端点已随 /api/v1 一并删除。
 */
import { createHash } from 'node:crypto'
import type { Settings } from '../../shared/types'
import type { NarrativeMode } from '../../shared/types'
import { DEFAULT_OMNISCIENT_NARRATIVE_RULES, resolveNarrativeMode } from '../../shared/narrativeMode'

/** 可同步的设置子集（白名单；不含任何凭据与 PC 显示偏好） */
export interface MobileSafeSettings {
  userName: string
  userDescription: string
  userPersona: string
  activePresetId: string | null
  activeModel: string
  translationTargetLang: string
  streamOutput: boolean
  autoScroll: boolean
  showTokenCount: boolean
  htmlRendering: boolean
  exampleDialogMode: 'always' | 'first_turn' | 'off'
  lorebookRatio: number
  autoTitle: boolean
  defaultNarrativeMode: NarrativeMode
  omniscientNarrativeRules: string
}

/**
 * 递归 key 排序的稳定 JSON 序列化。
 * undefined/null 均序列化为 null；对象 key 按字典序输出，保证内容寻址稳定。
 */
export function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** revision = sha256(stableStringify(values))；对客户端为不透明字符串 */
export function computeRevision(values: MobileSafeSettings): string {
  return createHash('sha256').update(stableStringify(values)).digest('hex')
}

/**
 * Settings -> MobileSafeSettings（剔除 PC 显示偏好与凭据）。
 */
export function toMobileSafeSettings(s: Settings): MobileSafeSettings {
  return {
    userName: s.userName,
    userDescription: s.userDescription,
    userPersona: s.userPersona,
    activePresetId: s.activePresetId ?? null,
    activeModel: s.activeModel ?? '',
    translationTargetLang: s.translationTargetLang ?? '中文',
    streamOutput: s.streamOutput,
    autoScroll: s.autoScroll,
    showTokenCount: s.showTokenCount,
    htmlRendering: s.htmlRendering,
    exampleDialogMode: s.exampleDialogMode ?? 'always',
    lorebookRatio: s.lorebookRatio ?? 0.3,
    autoTitle: s.autoTitle ?? true,
    defaultNarrativeMode: resolveNarrativeMode(s.defaultNarrativeMode),
    omniscientNarrativeRules: s.omniscientNarrativeRules?.trim() || DEFAULT_OMNISCIENT_NARRATIVE_RULES,
  }
}

/** 两份设置之间安全子集发生变化的字段名（供设置变更事件计算 changedFields） */
export function diffMobileSafeFields(before: Settings, after: Settings): string[] {
  const a = toMobileSafeSettings(before)
  const b = toMobileSafeSettings(after)
  return (Object.keys(b) as Array<keyof MobileSafeSettings>)
    .filter((key) => stableStringify(a[key]) !== stableStringify(b[key]))
}
