/**
 * CORS 允许来源解析
 * 修复：空数组是 truthy，[] || 默认值恒为 [] 导致跨域全拒。
 * 提取为独立函数以便单测。
 */

/** 解析 ALLOWED_ORIGINS 环境变量，空/空白时回退默认来源 */
function resolveAllowedOrigins(envValue, fallback = ['http://localhost:3000']) {
  const origins = (envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return origins.length > 0 ? origins : fallback
}

module.exports = { resolveAllowedOrigins }
