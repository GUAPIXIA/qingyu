/**
 * 桥接层协议常量（阶段 C/D 能力协商，单点定义避免 routes/identity/mdns 循环依赖）。
 */

/** REST 协议版本（与安卓端 SUPPORTED_API_VERSION 对齐） */
export const API_VERSION = 1

/** 配对 QR 协议版本（D-02：v2 含 serverId/capabilities/expiresAt/endpoints） */
export const PAIR_VERSION = 2

/** 当前桥接 HTTP 是否启用 TLS（v1 局域网明文；预留字段供安卓端明示安全等级） */
export const TLS_ENABLED = false

/** QR v2 scheme 标识（安卓端按此识别载荷格式） */
export const PAIR_SCHEME = 'qingyu-pair'

/** 配对码默认有效期（与 auth.ts PAIR_CODE_TTL_MS 一致；QR expiresAt 展示用） */
export const PAIR_CODE_TTL_SEC = 5 * 60

/**
 * /server/info capabilities（Android 检测到对应 capability 才启用新端点/新协议，
 * 否则回退旧逻辑并在 UI 标注"旧版 PC"）。
 * - settings_snapshot_v2：GET/PATCH /api/v1/settings/snapshot（阶段 C）
 * - settings_events_v1：WS settings:updated 事件（阶段 C）
 * - pairing_qr_v2：QR v2 配对载荷（阶段 D）
 * - task_events_v2：/api/v2 任务事件流
 */
export const SERVER_CAPABILITIES = [
  'settings_snapshot_v2',
  'settings_events_v1',
  'pairing_qr_v2',
  'task_events_v2',
] as const
