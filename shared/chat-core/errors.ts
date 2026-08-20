/**
 * V12-02 共享契约：领域错误（实施方案 §15）
 *
 * 所有 AI/Provider/持久化/权限错误先脱敏再映射为 DomainError，
 * 客户端据 code 决定重试/提示，不暴露供应商原文、本地路径、stack。
 */

export type DomainErrorCode =
  | 'INVALID_COMMAND'
  | 'UNAUTHORIZED'
  | 'VERSION_INCOMPATIBLE'
  | 'SESSION_NOT_FOUND'
  | 'CHARACTER_NOT_FOUND'
  | 'TASK_CONFLICT'
  | 'TASK_NOT_FOUND'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CONTEXT_TOO_LARGE'
  | 'INVALID_MODEL_RESPONSE'
  | 'TOOL_PERMISSION_DENIED'
  | 'TOOL_FAILED'
  | 'PERSISTENCE_FAILED'
  | 'TASK_INTERRUPTED'
  | 'UNKNOWN'

export interface DomainError {
  code: DomainErrorCode
  message: string
  retryable: boolean
  safeDetails?: Record<string, string | number | boolean>
}

/** 供应商/内部错误 -> DomainError 的映射表（脱敏后） */
const RETRYABLE_CODES = new Set<DomainErrorCode>([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PERSISTENCE_FAILED',
])

export function createDomainError(
  code: DomainErrorCode,
  message: string,
  opts?: { retryable?: boolean; safeDetails?: DomainError['safeDetails'] },
): DomainError {
  return {
    code,
    message,
    retryable: opts?.retryable ?? RETRYABLE_CODES.has(code),
    safeDetails: opts?.safeDetails,
  }
}

/** 简易脱敏：剥离 API Key / Bearer / 文件绝对路径（供错误映射前使用） */
export function sanitizeErrorMessage(raw: string): string {
  return raw
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
    .replace(/Bearer\s+[a-zA-Z0-9._-]{10,}/gi, 'Bearer ***')
    .replace(/[A-Z]:\\[^\s"]+/g, '<path>')
    .replace(/\/[^\s"]+\.(?:json|log|db)/g, '<path>')
    .slice(0, 500)
}
