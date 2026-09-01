export interface AllowedRoute { method: string; path: string; cacheable: boolean; queueWhenOffline: boolean }

const ROUTES = [
  ['GET', /^\/api\/v1\/server\/info$/, false, false],
  ['GET', /^\/api\/v1\/characters$/, true, false],
  ['GET', /^\/api\/v1\/sessions$/, true, false],
  ['GET', /^\/api\/v1\/sessions\/[^/]+\/messages$/, true, false],
  ['POST', /^\/api\/v1\/sessions\/[^/]+\/messages$/, false, true],
  ['POST', /^\/api\/v1\/sessions\/[^/]+\/swipe$/, false, false],
  ['POST', /^\/api\/v1\/sessions\/[^/]+\/translate$/, false, false],
  ['GET', /^\/api\/v1\/settings\/snapshot$/, true, false],
] as const

export function normalizeBridgePath(rawPath: string): string {
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) throw new Error('invalid path')
  if (/%2f|%5c/i.test(rawPath) || rawPath.includes('..') || rawPath.includes('//')) throw new Error('invalid path')
  let decoded: string
  try { decoded = decodeURIComponent(rawPath) } catch { throw new Error('invalid path encoding') }
  if (decoded.includes('..') || decoded.includes('//') || decoded.includes('://')) throw new Error('invalid path')
  return decoded
}

export function matchAllowedRoute(method: string, rawPath: string): AllowedRoute | null {
  const path = normalizeBridgePath(rawPath)
  const normalizedMethod = method.toUpperCase()
  for (const [allowedMethod, pattern, cacheable, queueWhenOffline] of ROUTES) {
    if (normalizedMethod === allowedMethod && pattern.test(path)) return { method: normalizedMethod, path, cacheable, queueWhenOffline }
  }
  return null
}
