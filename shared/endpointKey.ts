/**
 * 端点键（主计划 W1 §5.3 / §4.4）：标准化 + 不可逆短哈希 —— 纯函数，无 IO。
 *
 * 观测与用量档案都只依赖本模块产出的指纹：
 * - 先移除凭据、query 与 fragment，再统一小写 host/protocol、去尾斜杠；
 * - 指纹为 FNV-1a 32 位短哈希，只用于分桶隔离，不用于鉴权，也不可反推 URL。
 */

export function stripAfter(input: string, marker: string): string {
  const idx = input.indexOf(marker)
  return idx >= 0 ? input.slice(0, idx) : input
}

/**
 * 端点标准化：标准 URL 走 `URL` 组件的结构化清理与标准序列化；
 * 非标准输入（缺 scheme 等）走保守清理，保证同一输入总是得到同一结果、且不残留凭据。
 */
export function normalizeEndpoint(baseUrl: string): string {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/+$/, '')
  } catch {
    const withoutFragment = stripAfter(raw, '#')
    const withoutQuery = stripAfter(withoutFragment, '?')
    const withoutCredentials = withoutQuery.replace(/\/\/[^/@]*@/, '//')
    return withoutCredentials.replace(/\/+$/, '')
  }
}

/**
 * 端点指纹：FNV-1a 32 位（不可逆短哈希）。
 * 同一标准化地址跨进程稳定，不同地址不相互污染；空输入返回空串（旧记录缺省桶）。
 */
export function endpointFingerprint(baseUrl: string): string {
  const input = normalizeEndpoint(baseUrl)
  if (!input) return ''
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
