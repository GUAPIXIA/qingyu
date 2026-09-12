/**
 * 阶段 C：设置同步 v2（docs/已移除/安卓端优化实施文档-2026-08-29.md §7）。
 *
 * 设计要点：
 * - 保留旧 GET/PATCH /api/v1/settings 不变，新增快照端点（可协商 capability）；
 * - `MobileSafeSettings`：可安全同步给安卓端的设置子集——以旧 toApiSettings 字段为准，
 *   剔除 PC 显示偏好（fontSize/themeColor/bubbleStyle/messageWidth/messageSpacing，
 *   避免与 Android 本机显示互相覆盖），并绝不包含 apiKey/connectionProfiles/provider 凭据；
 * - revision = sha256(stableStringify(mobileSafeSettings))：内容寻址、无需计数器等
 *   所有写路径配合，PC 重启后仍稳定；对客户端是不透明字符串；
 *   （注：文档 §7 C-02 描述为"移动端安全子集的稳定 JSON 哈希"，哈希范围取安全子集
 *   而非全量 toApiSettings——PC 仅改显示偏好不应令手机端 revision 作废造成假 409。）
 * - PATCH：baseRevision 不符 → 409 settings_conflict（携带 current 快照）；
 *   字段逐一做类型 + 范围验证，非法字段进 rejectedFields，不影响合法字段应用。
 */
import { createHash } from 'node:crypto'
import type { Settings } from '../../shared/types'
import type { NarrativeMode } from '../../shared/types'
import { DEFAULT_OMNISCIENT_NARRATIVE_RULES, isNarrativeMode, resolveNarrativeMode } from '../../shared/narrativeMode'

// ===================== 数据模型 =====================

/** 可同步给移动端的设置子集（白名单；不含任何凭据与 PC 显示偏好） */
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

/** 快照端点能力声明（与 /server/info capabilities 对齐） */
export const SETTINGS_SNAPSHOT_CAPABILITIES = [
  'settings_snapshot_v2',
  'settings_events_v1',
  'pairing_qr_v2',
] as const

/**
 * 快照 schemaVersion。
 *
 * v3：安全子集移除 `imageGenSize`（改用工作流节点级覆盖）。
 * v4：安全子集移除 `imageGenAutoEnabled`（自动生图功能整体下线）。
 * 端点协议本身未变，故 capability 仍为 `settings_snapshot_v2`，
 * 旧版 Android 继续走快照路径，缺失字段由其 DTO 默认值兜底。
 */
export const SETTINGS_SNAPSHOT_SCHEMA_VERSION = 4

export interface SettingsSnapshot {
  schemaVersion: 4
  revision: string
  updatedAt: number
  values: MobileSafeSettings
  capabilities: string[]
}

export interface SettingsPatchRequest {
  baseRevision: string
  patch: Partial<MobileSafeSettings>
  sourceDeviceId?: string
}

export interface RejectedField {
  field: string
  reason: string
}

export interface SettingsPatchResponse extends SettingsSnapshot {
  appliedFields: string[]
  rejectedFields: RejectedField[]
}

/** PATCH 校验上下文：activeModel 需要 Profile 模型列表、activePresetId 需要真实 preset id */
export interface SettingsValidationContext {
  /** 当前 Profile 可用模型 id 列表；null = 无法获取（跳过存在性校验，仅校验类型） */
  knownModelIds: string[] | null
  /** 当前存在的预设 id（内置 + 自定义） */
  knownPresetIds: string[]
}

// ===================== 稳定序列化 / revision =====================

/**
 * 递归 key 排序的稳定 JSON 序列化（自实现，不引入 json-stable-stringify 依赖）。
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

// ===================== 安全子集提取 =====================

/**
 * Settings -> MobileSafeSettings（字段/默认值与旧 toApiSettings 保持一致，
 * 额外剔除 PC 显示偏好：fontSize/themeColor/bubbleStyle/messageWidth/messageSpacing）。
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

/** 读取设置并生成当前快照（revision 对同一安全子集恒定） */
export function buildSettingsSnapshot(settings: Settings, now = Date.now()): SettingsSnapshot {
  const values = toMobileSafeSettings(settings)
  return {
    schemaVersion: SETTINGS_SNAPSHOT_SCHEMA_VERSION,
    revision: computeRevision(values),
    updatedAt: now,
    values,
    capabilities: [...SETTINGS_SNAPSHOT_CAPABILITIES],
  }
}

/** 两份设置之间安全子集发生变化的字段名（供设置变更事件计算 changedFields） */
export function diffMobileSafeFields(before: Settings, after: Settings): string[] {
  const a = toMobileSafeSettings(before)
  const b = toMobileSafeSettings(after)
  return (Object.keys(b) as Array<keyof MobileSafeSettings>)
    .filter((key) => stableStringify(a[key]) !== stableStringify(b[key]))
}

// ===================== PATCH 字段验证 =====================

type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string }

function isPlainString(v: unknown): v is string {
  return typeof v === 'string'
}

/** 各字段的类型 + 范围验证器（文档 §7 C-03 表格；未列字段按类型宽松校验） */
const FIELD_VALIDATORS: Record<
  keyof MobileSafeSettings,
  (value: unknown, ctx: SettingsValidationContext) => ValidationResult
> = {
  userName: (v) => (!isPlainString(v) ? { ok: false, reason: 'invalid_type' }
    : v.length > 10_000 ? { ok: false, reason: 'too_long' } : { ok: true, value: v }),
  userDescription: (v) => (!isPlainString(v) ? { ok: false, reason: 'invalid_type' }
    : v.length > 50_000 ? { ok: false, reason: 'too_long' } : { ok: true, value: v }),
  userPersona: (v) => (!isPlainString(v) ? { ok: false, reason: 'invalid_type' }
    : v.length > 50_000 ? { ok: false, reason: 'too_long' } : { ok: true, value: v }),
  // 1~32 字符（trim 后）
  translationTargetLang: (v) => {
    if (!isPlainString(v)) return { ok: false, reason: 'invalid_type' }
    const trimmed = v.trim()
    if (trimmed.length < 1 || trimmed.length > 32) return { ok: false, reason: 'invalid_length' }
    return { ok: true, value: trimmed }
  },
  streamOutput: (v) => (typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, reason: 'invalid_type' }),
  showTokenCount: (v) => (typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, reason: 'invalid_type' }),
  autoScroll: (v) => (typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, reason: 'invalid_type' }),
  htmlRendering: (v) => (typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, reason: 'invalid_type' }),
  autoTitle: (v) => (typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, reason: 'invalid_type' }),
  defaultNarrativeMode: (v) => (isNarrativeMode(v)
    ? { ok: true, value: v } : { ok: false, reason: 'invalid_enum' }),
  omniscientNarrativeRules: (v) => (!isPlainString(v)
    ? { ok: false, reason: 'invalid_type' }
    : !v.trim() ? { ok: false, reason: 'empty_value' }
      : v.length > 50_000 ? { ok: false, reason: 'too_long' }
        : { ok: true, value: v }),
  exampleDialogMode: (v) => (v === 'always' || v === 'first_turn' || v === 'off'
    ? { ok: true, value: v } : { ok: false, reason: 'invalid_enum' }),
  // 0~1
  lorebookRatio: (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: 'invalid_type' }
    if (v < 0 || v > 1) return { ok: false, reason: 'out_of_range' }
    return { ok: true, value: v }
  },
  // 必须存在于当前 Profile 模型列表，或允许空值（=跟随 Profile 默认）
  activeModel: (v, ctx) => {
    if (!isPlainString(v)) return { ok: false, reason: 'invalid_type' }
    if (v === '') return { ok: true, value: v }
    if (ctx.knownModelIds && !ctx.knownModelIds.includes(v)) return { ok: false, reason: 'unknown_model' }
    return { ok: true, value: v }
  },
  // null 或真实存在的 preset id
  activePresetId: (v, ctx) => {
    if (v === null) return { ok: true, value: null }
    if (!isPlainString(v)) return { ok: false, reason: 'invalid_type' }
    if (!ctx.knownPresetIds.includes(v)) return { ok: false, reason: 'unknown_preset' }
    return { ok: true, value: v }
  },
}

export interface ValidatedPatch {
  /** 通过验证、允许写入的字段 */
  accepted: Partial<MobileSafeSettings>
  rejected: RejectedField[]
}

/**
 * 验证 PATCH 载荷：白名单 + 逐字段类型/范围校验。
 * 未知/非白名单字段（含 PC-only 显示偏好、任何凭据字段）进入 rejected，
 * 不影响合法字段应用。
 */
export function validateSettingsPatch(
  patch: Record<string, unknown>,
  ctx: SettingsValidationContext,
): ValidatedPatch {
  const accepted: Partial<MobileSafeSettings> = {}
  const rejected: RejectedField[] = []
  for (const [field, value] of Object.entries(patch ?? {})) {
    const validator = FIELD_VALIDATORS[field as keyof MobileSafeSettings]
    if (!validator) {
      rejected.push({ field, reason: 'field_not_allowed' })
      continue
    }
    const result = validator(value, ctx)
    if (result.ok) {
      accepted[field as keyof MobileSafeSettings] = result.value as never
    } else {
      rejected.push({ field, reason: result.reason })
    }
  }
  return { accepted, rejected }
}
