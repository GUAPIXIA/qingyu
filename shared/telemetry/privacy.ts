/**
 * S9-06 遥测与隐私约束。
 *
 * 只收集用户明确同意的匿名运行指标：版本、阶段、错误码、耗时、条目/字节区间、冲突类型。
 * 禁止正文、实体 ID、URL、模型密钥、设备名、公钥、密文和空间 ID 原值。
 * 支持完全关闭，不影响功能。
 */

export type TelemetryBucket =
  | 'app_version'
  | 'stage'
  | 'error_code'
  | 'duration_ms'
  | 'item_count_bucket'
  | 'byte_count_bucket'
  | 'conflict_kind'

export interface TelemetryConsent {
  /** 用户明确同意后才可上报；默认 false */
  granted: boolean
  /** 可随时关闭；关闭后 [redactForTelemetry] 应返回 null */
  enabled: boolean
  updatedAt: number
}

export const TELEMETRY_DEFAULT_CONSENT: TelemetryConsent = {
  granted: false,
  enabled: false,
  updatedAt: 0,
}

/** 允许的遥测字段名白名单 */
export const ALLOWED_TELEMETRY_KEYS = new Set<TelemetryBucket>([
  'app_version',
  'stage',
  'error_code',
  'duration_ms',
  'item_count_bucket',
  'byte_count_bucket',
  'conflict_kind',
])

/** 敏感键名（出现即丢弃整段值，不做“部分脱敏”） */
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /apikey/i,
  /api_key/i,
  /token/i,
  /private/i,
  /credential/i,
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /spaceid/i,
  /space_id/i,
  /deviceid/i,
  /device_id/i,
  /publickey/i,
  /public_key/i,
  /ciphertext/i,
  /body/i,
  /payload/i,
  /prompt/i,
  /content/i,
  /text/i,
  /message/i,
  /url/i,
  /href/i,
  /path/i,
  /filename/i,
  /entityid/i,
  /entity_id/i,
  /name/i,
  /displayname/i,
  /display_name/i,
]

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key))
}

/** 条目/字节计数落到区间桶，避免精确规模指纹 */
export function countBucket(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n === 0) return '0'
  if (n <= 10) return '1-10'
  if (n <= 100) return '11-100'
  if (n <= 1000) return '101-1k'
  if (n <= 10_000) return '1k-10k'
  if (n <= 100_000) return '10k-100k'
  return '100k+'
}

export function byteBucket(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n === 0) return '0'
  if (n <= 1024) return '1B-1KB'
  if (n <= 64 * 1024) return '1KB-64KB'
  if (n <= 1024 * 1024) return '64KB-1MB'
  if (n <= 8 * 1024 * 1024) return '1MB-8MB'
  return '8MB+'
}

export interface TelemetryEvent {
  stage?: string
  errorCode?: string
  durationMs?: number
  itemCount?: number
  byteCount?: number
  conflictKind?: string
  appVersion?: string
}

/**
 * 将事件收成白名单字段；未同意或关闭时返回 null。
 * 任何敏感键、URL、实体 ID 形状的值一律丢弃。
 */
export function redactForTelemetry(
  event: Record<string, unknown>,
  consent: TelemetryConsent,
  appVersion?: string,
): Record<string, string | number> | null {
  if (!consent.granted || !consent.enabled) return null

  const out: Record<string, string | number> = {}
  if (typeof appVersion === 'string' && appVersion.length <= 32) {
    out.app_version = appVersion
  }

  for (const [rawKey, rawValue] of Object.entries(event)) {
    const key = rawKey.replace(/([A-Z])/g, '_$1').toLowerCase()
    const inputAliases = new Set(['item_count', 'byte_count'])
    if (!ALLOWED_TELEMETRY_KEYS.has(key as TelemetryBucket) && !inputAliases.has(key)) continue
    if (isSensitiveKey(rawKey)) continue

    if (key === 'duration_ms') {
      const n = Number(rawValue)
      if (Number.isFinite(n) && n >= 0) out.duration_ms = Math.round(n)
      continue
    }
    if (key === 'item_count' || key === 'item_count_bucket') {
      out.item_count_bucket = typeof rawValue === 'string' && key.endsWith('_bucket')
        ? rawValue
        : countBucket(Number(rawValue))
      continue
    }
    if (key === 'byte_count' || key === 'byte_count_bucket') {
      out.byte_count_bucket = typeof rawValue === 'string' && key.endsWith('_bucket')
        ? rawValue
        : byteBucket(Number(rawValue))
      continue
    }

    // stage / error_code / conflict_kind / app_version：短枚举，禁止长文本与 URL
    if (typeof rawValue === 'string') {
      if (/https?:\/\//i.test(rawValue)) continue
      if (rawValue.length > 64) continue
      if (/[/\\]{2,}/.test(rawValue)) continue
      out[key] = rawValue
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      out[key] = rawValue
    }
  }

  // 强制桶化（若调用方直接传了精确计数）
  if (typeof out.item_count_bucket === 'number') {
    out.item_count_bucket = countBucket(out.item_count_bucket)
  }
  if (typeof out.byte_count_bucket === 'number') {
    out.byte_count_bucket = byteBucket(out.byte_count_bucket)
  }

  return Object.keys(out).length > 0 ? out : null
}

/** 完全关闭遥测：不影响任何功能路径 */
export function isTelemetryAllowed(consent: TelemetryConsent): boolean {
  return consent.granted === true && consent.enabled === true
}
