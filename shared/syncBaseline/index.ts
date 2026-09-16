/**
 * 阶段 0 spike：跨端确定性基线算法（TS 参考实现）。
 * 不进入生产路径；Kotlin 等价实现以 shared/fixtures/cross-platform 对齐。
 */

export type JsonObject = { [key: string]: JsonValue }
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** RFC 8785 兼容子集：对象键按 UTF-16 码元序排序，丢弃 undefined。 */
export function canonicalJson(value: JsonValue | undefined): string {
  return encode(value)
}

function encode(value: JsonValue | undefined): string {
  if (value === undefined) return 'null'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return encodeNumber(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => encode(v)).join(',')}]`
  const entries = Object.keys(value as JsonObject)
    .filter((k) => (value as JsonObject)[k] !== undefined)
    .sort(compareUtf16)
    .map((k) => `${JSON.stringify(k)}:${encode((value as JsonObject)[k])}`)
  return `{${entries.join(',')}}`
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError('canonicalJson 不支持非有限数字')
  if (Object.is(n, -0)) return '0'
  return JSON.stringify(n)
}

import { createHash } from 'node:crypto'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** ULID：48bit 时间 + 80bit 随机，Crockford Base32，字典序=时间序。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function encodeTime(ms: number, len = 10): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffffffffffff) {
    throw new RangeError('ULID 时间超出 48bit')
  }
  let out = ''
  let n = ms
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[n % 32] + out
    n = Math.floor(n / 32)
  }
  return out
}

export function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length !== 10) throw new RangeError('ULID 随机部分必须是 10 字节')
  let out = ''
  let bits = 0
  let acc = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(acc >>> bits) & 31]
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31]
  return out.slice(0, 16)
}

export function ulid(now: number, random: Uint8Array): string {
  return encodeTime(now) + encodeRandom(random)
}

/** 版本向量：counter 为十进制字符串（无前导零）。 */
export type VersionVector = Readonly<Record<string, string>>

const UINT64_MAX = (1n << 64n) - 1n

export function parseCounter(raw: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`非法 counter: ${raw}`)
  }
  const v = BigInt(raw)
  if (v > UINT64_MAX) throw new Error(`counter 溢出: ${raw}`)
  return v
}

export function formatCounter(v: bigint): string {
  if (v < 0n || v > UINT64_MAX) throw new RangeError('counter 超出 UInt64')
  return v.toString(10)
}

export function bumpDot(vv: VersionVector, deviceId: string): VersionVector {
  const cur = parseCounter(vv[deviceId] ?? '0')
  return { ...vv, [deviceId]: formatCounter(cur + 1n) }
}

export function mergeVectors(a: VersionVector, b: VersionVector): VersionVector {
  const out: Record<string, string> = {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const av = a[k] ? parseCounter(a[k]) : 0n
    const bv = b[k] ? parseCounter(b[k]) : 0n
    out[k] = formatCounter(av > bv ? av : bv)
  }
  return out
}

/** 返回 'a'支配 | 'b'支配 | 'concurrent' | 'equal' */
export function compareVectors(a: VersionVector, b: VersionVector): 'a' | 'b' | 'concurrent' | 'equal' {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  let aGe = true
  let bGe = true
  for (const k of keys) {
    const av = a[k] ? parseCounter(a[k]) : 0n
    const bv = b[k] ? parseCounter(b[k]) : 0n
    if (av > bv) bGe = false
    if (bv > av) aGe = false
  }
  if (aGe && bGe) return 'equal'
  if (aGe) return 'a'
  if (bGe) return 'b'
  return 'concurrent'
}

export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

export function assertPayloadWithinLimit(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload 超过 2MiB: ${bytes}`)
  }
}

export interface BlobChunkPlan {
  chunkIndex: number
  plainOffset: number
  plainLength: number
}

export function planBlobChunks(totalPlainBytes: number, chunkSize = 256 * 1024): BlobChunkPlan[] {
  if (totalPlainBytes < 0) throw new RangeError('非法长度')
  if (chunkSize <= 0) throw new RangeError('非法分块')
  const plans: BlobChunkPlan[] = []
  let offset = 0
  let index = 0
  while (offset < totalPlainBytes) {
    const plainLength = Math.min(chunkSize, totalPlainBytes - offset)
    plans.push({ chunkIndex: index, plainOffset: offset, plainLength })
    offset += plainLength
    index += 1
  }
  return plans
}
