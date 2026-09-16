/**
 * 版本向量：wire/schema 中 counter 为无前导零十进制字符串，不经 JS Number。
 */

export type DeviceId = string
export type CounterDecimal = string

/** device → 十进制字符串 counter；零值可省略，不序列化 */
export type VersionVector = Readonly<Record<DeviceId, CounterDecimal>>

export interface Dot {
  deviceId: DeviceId
  counter: CounterDecimal
}

export type VectorCompare = 'equal' | 'dominates' | 'dominated' | 'concurrent'

export const UINT64_MAX = (1n << 64n) - 1n

export function parseCounter(raw: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`非法 counter（须无前导零）: ${raw}`)
  }
  const v = BigInt(raw)
  if (v > UINT64_MAX) throw new Error(`counter 溢出 UInt64: ${raw}`)
  return v
}

export function formatCounter(v: bigint): CounterDecimal {
  if (v < 0n || v > UINT64_MAX) throw new RangeError('counter 超出 UInt64')
  return v.toString(10)
}

export function bumpDot(vv: VersionVector, deviceId: DeviceId): { vector: VersionVector; dot: Dot } {
  const cur = parseCounter(vv[deviceId] ?? '0')
  if (cur === UINT64_MAX) throw new Error(`设备 counter 已达上限: ${deviceId}`)
  const next = formatCounter(cur + 1n)
  return { vector: { ...vv, [deviceId]: next }, dot: { deviceId, counter: next } }
}

export function mergeVectors(a: VersionVector, b: VersionVector): VersionVector {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out: Record<string, string> = {}
  for (const k of keys) {
    const av = a[k] !== undefined ? parseCounter(a[k]) : 0n
    const bv = b[k] !== undefined ? parseCounter(b[k]) : 0n
    const max = av > bv ? av : bv
    if (max > 0n) out[k] = formatCounter(max)
  }
  return Object.freeze(out)
}

/** 返回 a 相对 b 的关系：dominates=a≥b 且 ≠；dominated=a≤b 且 ≠；concurrent=各有过大分量 */
export function compareVectors(a: VersionVector, b: VersionVector): VectorCompare {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  let aGe = true
  let bGe = true
  for (const k of keys) {
    const av = a[k] !== undefined ? parseCounter(a[k]) : 0n
    const bv = b[k] !== undefined ? parseCounter(b[k]) : 0n
    if (av > bv) bGe = false
    if (bv > av) aGe = false
  }
  if (aGe && bGe) return 'equal'
  if (aGe) return 'dominates'
  if (bGe) return 'dominated'
  return 'concurrent'
}

export function equalsVector(a: VersionVector, b: VersionVector): boolean {
  return compareVectors(a, b) === 'equal'
}

/** 零向量 */
export function emptyVector(): VersionVector {
  return Object.freeze({})
}

export function vectorFromPairs(pairs: Array<[DeviceId, CounterDecimal]>): VersionVector {
  const out: Record<string, string> = {}
  for (const [d, c] of pairs) {
    const n = parseCounter(c)
    if (n > 0n) out[d] = formatCounter(n)
  }
  return Object.freeze(out)
}
