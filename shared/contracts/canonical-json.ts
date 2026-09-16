/**
 * RFC 8785 兼容 canonical JSON（阶段 1 契约）。
 * 与 shared/syncBaseline 同步语义；跨语言 golden 以 fixtures/canonical 为准。
 */
import { createHash } from 'node:crypto'

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue | undefined }

export function canonicalize(value: CanonicalJsonValue | undefined): string {
  return encode(value)
}

function encode(value: CanonicalJsonValue | undefined): string {
  if (value === undefined) return 'null'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON 不允许 NaN/Infinity')
    }
    if (Object.is(value, -0)) return '0'
    // ECMAScript number → JSON（与 JSON.stringify 数值语义一致）
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => encode(v)).join(',')}]`
  }
  const obj = value as { [k: string]: CanonicalJsonValue | undefined }
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(compareUtf16)
  const body = keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`).join(',')
  return `{${body}}`
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function sha256HexUtf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** payload 业务哈希：canonical JSON 的 SHA-256，格式 sha256:<lowercase hex> */
export function contentHash(payload: CanonicalJsonValue): string {
  return `sha256:${sha256HexUtf8(canonicalize(payload))}`
}

export function assertValidContentHash(hash: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`非法 contentHash: ${hash}`)
  }
}
