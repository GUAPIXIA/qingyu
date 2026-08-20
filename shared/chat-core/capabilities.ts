/**
 * V12-02 共享契约：能力常量（实施方案 §6.5 版本协商）
 *
 * 客户端通过 /server/info 或 /api/v2/capabilities 协商：
 *   { apiVersion: 2, capabilities: [...] }
 * 单个 apiVersion 无法表达增量能力，需 capabilities 细粒度开关。
 */

export const API_VERSION = 2 as const

export const CAPABILITIES = [
  'authenticated_media',
  'group_ai',
  'memory_v2',
  'task_resume',
  'ws_replay',
  'mcp_permission',
] as const

export type Capability = typeof CAPABILITIES[number]

export function hasCapability(list: readonly string[], cap: Capability): boolean {
  return list.includes(cap)
}
