/**
 * 阶段 D（D-02）：配对二维码载荷（PC 生成 / Android 解析共用契约，零依赖纯函数）。
 *
 * v2 载荷含 serverId / capabilities / expiresAt / endpoints，安卓端可稳定识别同一 PC、
 * 按能力协商新协议、校验时效。旧格式（{host,port,fingerprint}）继续输出为 legacy，
 * PC UI 默认渲染 v2，并提供"旧版兼容"切换到 legacy（旧 Android 至少一个发布周期可扫码配对）。
 *
 * 安卓端解析规则（对齐）：JSON.parse 后
 *   - 含 version===2 && scheme==="qingyu-pair" -> 按 v2 处理（校验 expiresAt/pairingCode）；
 *   - 否则若含 host & port & fingerprint -> 按旧格式处理（pairingCode=fingerprint）。
 */

/** QR v2 端点安全等级：当前桥接为局域网明文；TLS 预留 */
export type PairingEndpointSecurity = 'LOCAL_CLEARTEXT' | 'TLS'

export interface PairingQrEndpoint {
  host: string
  port: number
  security: PairingEndpointSecurity
}

/** 配对 QR v2 载荷（文档 §8 D-02） */
export interface PairingQrPayloadV2 {
  version: 2
  scheme: 'qingyu-pair'
  /** 稳定服务器 ID（bridgeIdentity.json uuid，跨重启/换网卡不变） */
  serverId: string
  /** PC 展示名（hostname） */
  displayName: string
  /** REST 协议版本 */
  apiVersion: number
  /** 能力声明（与 /server/info capabilities 同集合的子集） */
  capabilities: string[]
  /** 一次性配对码（与旧 fingerprint 同值） */
  pairingCode: string
  /** 到期时间戳（ms）；过期扫码必须被拒绝 */
  expiresAt: number
  endpoints: PairingQrEndpoint[]
  /** 证书固定（未启用 TLS 时为 null） */
  certificatePin: string | null
}

/** 旧版载荷（0.16.x 及更早 Android PairingQrPayload 期望的顶层形状） */
export interface PairingQrPayloadLegacy {
  host: string
  port: number
  fingerprint: string
}

export interface PairingQrV2Input {
  serverId: string
  displayName: string
  apiVersion: number
  capabilities: string[]
  pairingCode: string
  expiresAt: number
  endpoints: PairingQrEndpoint[]
}

export function buildPairingQrV2(input: PairingQrV2Input): PairingQrPayloadV2 {
  return {
    version: 2,
    scheme: 'qingyu-pair',
    serverId: input.serverId,
    displayName: input.displayName,
    apiVersion: input.apiVersion,
    capabilities: [...input.capabilities],
    pairingCode: input.pairingCode,
    expiresAt: input.expiresAt,
    endpoints: input.endpoints.map((e) => ({ ...e })),
    certificatePin: null,
  }
}

export function buildPairingQrLegacy(host: string, port: number, pairingCode: string): PairingQrPayloadLegacy {
  return { host, port, fingerprint: pairingCode }
}

/** 解析结果（判别联合）：供测试与 PC 侧往返验证 */
export type ParsedPairingQr =
  | { kind: 'v2'; payload: PairingQrPayloadV2 }
  | { kind: 'legacy'; payload: PairingQrPayloadLegacy }
  | { kind: 'invalid'; reason: string }

/**
 * 解析扫码得到的 QR 字符串（v2 优先，旧格式降级）。
 * 安卓端应以等价逻辑实现；PC 单测用它做生成->解析往返验证。
 */
export function parsePairingQr(raw: string, now = Date.now()): ParsedPairingQr {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { kind: 'invalid', reason: 'not_json' }
  }
  if (typeof json !== 'object' || json === null) return { kind: 'invalid', reason: 'not_object' }
  const obj = json as Record<string, unknown>

  if (obj.version === 2) {
    if (obj.scheme !== 'qingyu-pair') return { kind: 'invalid', reason: 'unknown_scheme' }
    if (typeof obj.serverId !== 'string' || !obj.serverId) return { kind: 'invalid', reason: 'missing_serverId' }
    if (typeof obj.pairingCode !== 'string' || !obj.pairingCode) return { kind: 'invalid', reason: 'missing_pairingCode' }
    if (typeof obj.expiresAt !== 'number') return { kind: 'invalid', reason: 'missing_expiresAt' }
    if (obj.expiresAt < now) return { kind: 'invalid', reason: 'expired' }
    if (!Array.isArray(obj.endpoints) || obj.endpoints.length === 0) return { kind: 'invalid', reason: 'missing_endpoints' }
    const endpoints = (obj.endpoints as unknown[]).flatMap((e) => {
      const ep = e as Partial<PairingQrEndpoint>
      return typeof ep?.host === 'string' && typeof ep?.port === 'number'
        ? [{ host: ep.host, port: ep.port, security: ep.security === 'TLS' ? 'TLS' as const : 'LOCAL_CLEARTEXT' as const }]
        : []
    })
    if (endpoints.length === 0) return { kind: 'invalid', reason: 'malformed_endpoints' }
    return {
      kind: 'v2',
      payload: {
        version: 2,
        scheme: 'qingyu-pair',
        serverId: obj.serverId,
        displayName: typeof obj.displayName === 'string' ? obj.displayName : '',
        apiVersion: typeof obj.apiVersion === 'number' ? obj.apiVersion : 1,
        capabilities: Array.isArray(obj.capabilities) ? obj.capabilities.filter((c): c is string => typeof c === 'string') : [],
        pairingCode: obj.pairingCode,
        expiresAt: obj.expiresAt,
        endpoints,
        certificatePin: typeof obj.certificatePin === 'string' ? obj.certificatePin : null,
      },
    }
  }

  // 旧格式降级
  if (typeof obj.host === 'string' && typeof obj.port === 'number' && typeof obj.fingerprint === 'string') {
    return { kind: 'legacy', payload: { host: obj.host, port: obj.port, fingerprint: obj.fingerprint } }
  }
  return { kind: 'invalid', reason: 'unknown_format' }
}
