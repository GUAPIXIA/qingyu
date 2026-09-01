/** Qingyu Relay v1 shared wire contract. */
export const DEFAULT_RELAY_BASE_URL = 'https://cjbtj.xyz'

export const RELAY_PROTOCOL_VERSION = 1 as const
export const RELAY_MAX_JSON_BYTES = 256 * 1024

export type RelayRole = 'pc' | 'android'

export interface RelayFrame<T = unknown> {
  v: typeof RELAY_PROTOCOL_VERSION
  type: string
  id?: string
  replyTo?: string
  sentAt: number
  payload?: T
}

export interface RelayPcHelloPayload {
  deviceId: string
  appVersion: string
  protocolVersion: typeof RELAY_PROTOCOL_VERSION
  lastEventSeq?: number
  capabilities: string[]
}

export interface RelayRpcRequestPayload {
  commandId: string
  sourceDeviceId: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  body?: unknown
  deadlineAt: number
}

export interface RelayRpcResponsePayload {
  status: number
  headers: Record<string, string>
  body?: unknown
}

export interface RelayBridgeEventPayload {
  eventSeq: number
  event: string
  data?: unknown
  targetDeviceId?: string
}

export interface RelayPairingQr {
  version: 1
  scheme: 'qingyu-relay-pair'
  relayBaseUrl: string
  ticket: string
  /** 仅 PC 创建票据响应/面板使用；Android 扫码时可忽略。 */
  code?: string
  displayName: string
  expiresAt: number
}

export type RelayErrorCode =
  | 'INVALID_TOKEN'
  | 'DEVICE_REVOKED'
  | 'SPACE_DISABLED'
  | 'RESOURCE_NOT_FOUND'
  | 'PAIR_TICKET_INVALID'
  | 'PAIR_APPROVAL_TIMEOUT'
  | 'RATE_LIMITED'
  | 'PC_OFFLINE'
  | 'RPC_TIMEOUT'
  | 'UPGRADE_REQUIRED'

export interface RelayErrorBody {
  error: {
    code: RelayErrorCode
    message: string
    retryable: boolean
    requestId: string
    details?: Record<string, unknown>
  }
}

export const RELAY_FRAME_TYPES = new Set([
  'pc:hello', 'pc:ready', 'connection:ping', 'connection:pong',
  'rpc:request', 'rpc:response', 'rpc:error', 'rpc:cancel',
  'bridge:event', 'pair:requested', 'pair:approved', 'pair:rejected',
  'cache:snapshot', 'cache:delta', 'cache:accepted',
  'auth:expiring', 'server:maintenance',
])

export function relayFrame<T>(type: string, payload?: T, id?: string): RelayFrame<T> {
  return { v: RELAY_PROTOCOL_VERSION, type, id, sentAt: Date.now(), payload }
}

export function isRelayFrame(value: unknown): value is RelayFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<RelayFrame>
  return frame.v === RELAY_PROTOCOL_VERSION && typeof frame.type === 'string' &&
    Number.isFinite(frame.sentAt)
}
