import type { Capabilities, NegotiatedCapabilities } from './types'

export const SUPPORTED_PROTOCOL_VERSION = 1

/**
 * capability / schema 协商（S7-01）。
 *
 * - protocolVersion 取 min；低于 1 则失败（由调用方拒绝 session）
 * - features 取交集
 * - schemaVersions 逐实体取 min；对方有而我方无的实体类型列入 unsupported
 */
export function negotiateCapabilities(
  local: Capabilities,
  remote: Capabilities,
): NegotiatedCapabilities {
  const protocolVersion = Math.min(local.protocolVersion, remote.protocolVersion)
  const localFeatures = new Set(local.features)
  const features = [...remote.features].filter((f) => localFeatures.has(f)).sort()

  const schemaVersions: Record<string, number> = {}
  const unsupportedEntityTypes: string[] = []
  const allTypes = [...new Set([...Object.keys(local.schemaVersions), ...Object.keys(remote.schemaVersions)])].sort()
  for (const t of allTypes) {
    const lv = local.schemaVersions[t]
    const rv = remote.schemaVersions[t]
    if (lv === undefined || rv === undefined) {
      unsupportedEntityTypes.push(t)
      continue
    }
    schemaVersions[t] = Math.min(lv, rv)
  }
  return { protocolVersion, features, schemaVersions, unsupportedEntityTypes }
}

export function isProtocolCompatible(a: number, b: number): boolean {
  return Math.min(a, b) >= SUPPORTED_PROTOCOL_VERSION
}
