import { resolve, normalize, sep } from 'node:path'
import { statSync } from 'node:fs'

/**
 * 校验 ID 字符串仅包含安全字符
 * 防止 ID 参数被用作路径穿越攻击
 */
export function safeId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('参数无效：ID 必须为非空字符串')
  }
  if (id.length > 256) {
    throw new Error('参数无效：ID 长度超过限制')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`参数无效：ID 包含非法字符: ${id.substring(0, 50)}`)
  }
  return id
}

/**
 * 校验路径是否在指定的基础目录下，防止路径穿越
 */
export function safePath(baseDir: string, ...segments: string[]): string {
  const normalized = normalize(joinSafe(baseDir, ...segments))
  const baseNormalized = normalize(baseDir) + sep
  if (!normalized.startsWith(baseNormalized)) {
    throw new Error(`路径穿越攻击被阻止: ${segments.join('/').substring(0, 100)}`)
  }
  return normalized
}

/** 安全的路径拼接，防止绝对路径注入 */
function joinSafe(base: string, ...segments: string[]): string {
  // 过滤所有以 / 或 \ 开头的参数，它们会覆盖基础路径
  const clean = segments.map((s) => {
    if (s.startsWith('/') || s.startsWith('\\') || s.startsWith('..')) {
      throw new Error(`路径穿越攻击被阻止: ${s.substring(0, 100)}`)
    }
    return s
  })
  return [base, ...clean].join('/')
}

/**
 * SSRF 防护：校验 URL 是否安全可访问
 * 拒绝私有 IP、localhost、特殊协议
 */
export function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    // 仅允许 http/https
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false
    }
    const hostname = url.hostname.toLowerCase()
    // 拒绝 localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return false
    }
    // 拒绝私有 IP 段
    if (hostname.match(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/)) {
      return false
    }
    // 拒绝云元数据端点
    if (hostname === '169.254.169.254') {
      return false
    }
    // 拒绝 IPv6 私有地址
    if (hostname.startsWith('fe80') || hostname.startsWith('fc') || hostname.startsWith('fd')) {
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * 擦除敏感信息（如 API Key）
 */
export function sanitizeApiKey(text: string): string {
  return text
    // sk-xxx 格式 (OpenAI/Claude 风格)
    .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***')
    // 通用 API key 格式 (key=value)
    .replace(/([?&]key=)[^&\s]+/gi, '$1***')
    // Authorization Bearer
    .replace(/(Bearer\s+)[^\s]+/gi, '$1***')
    // x-api-key / x-goog-api-key header values
    .replace(/(['"]?(?:x-)?api-?key['"]?\s*[:=]\s*['"]?)[^'"&,\s]+/gi, '$1***')
}
