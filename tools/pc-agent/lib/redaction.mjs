// 结果脱敏：按动作登记的 redactKeys 在返回给调用方之前剔除敏感字段（方案 §4.4、§8）。
// 只做按 key 名的递归剔除，不做内容识别；剔除结果记录到动作证据里，便于审计“确实脱敏过”。
const DEFAULT_CREDENTIAL_KEYS = ['apikey', 'apikeys', 'token', 'secret', 'password', 'credential', 'spacekey', 'privatekey']

export function normalizeKeys(keys) {
  return (keys ?? []).map((key) => String(key).toLowerCase())
}

/**
 * 深拷贝并剔除匹配的键。
 * @returns {{ value: unknown, removed: string[] }} removed 为被剔除的路径列表（如 `providers[0].apiKey`）
 */
export function redactResult(value, keys) {
  const wanted = normalizeKeys(keys)
  if (wanted.length === 0) return { value, removed: [] }
  const removed = []
  const walk = (input, path) => {
    if (Array.isArray(input)) return input.map((item, index) => walk(item, `${path}[${index}]`))
    if (input && typeof input === 'object') {
      const output = {}
      for (const [key, item] of Object.entries(input)) {
        const nextPath = path ? `${path}.${key}` : key
        if (wanted.includes(key.toLowerCase())) {
          removed.push(nextPath)
          continue
        }
        output[key] = walk(item, nextPath)
      }
      return output
    }
    return input
  }
  return { value: walk(value, ''), removed }
}

/** 便捷：默认凭据键集合（供动作登记复用） */
export function credentialKeys() {
  return [...DEFAULT_CREDENTIAL_KEYS]
}

/** 结果里是否仍残留凭据键（用于自测与门禁式检查） */
export function findCredentialKeys(value, keys = DEFAULT_CREDENTIAL_KEYS) {
  const wanted = normalizeKeys(keys)
  const hits = []
  const walk = (input, path) => {
    if (Array.isArray(input)) return input.forEach((item, index) => walk(item, `${path}[${index}]`))
    if (input && typeof input === 'object') {
      for (const [key, item] of Object.entries(input)) {
        const nextPath = path ? `${path}.${key}` : key
        if (wanted.includes(key.toLowerCase())) hits.push(nextPath)
        walk(item, nextPath)
      }
    }
  }
  walk(value, '')
  return hits
}
