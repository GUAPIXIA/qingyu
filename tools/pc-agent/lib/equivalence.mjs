// 双入口等价比较（方案 §9 阶段 2 退出条件）：同一动作经 CLI 与 MCP 必须得到等价结果。
// 只比较协议层可比的字段；operationId、sessionId、耗时、证据属于传输/会话上下文，不参与比较。
export const COMPARED_FIELDS = ['status', 'action', 'layer', 'invoked', 'verified']

export function normalizeOutcome(outcome) {
  const normalized = {}
  for (const field of COMPARED_FIELDS) normalized[field] = outcome?.[field] ?? null
  normalized.result = outcome?.result ?? null
  return normalized
}

function deepEqual(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => deepEqual(left[key], right[key]))
  }
  return false
}

/** 比较两个入口对同一动作的返回；返回 { equivalent, differences } */
export function compareOutcomes(cliOutcome, mcpOutcome) {
  const left = normalizeOutcome(cliOutcome)
  const right = normalizeOutcome(mcpOutcome)
  const differences = []
  for (const field of [...COMPARED_FIELDS, 'result']) {
    if (!deepEqual(left[field], right[field])) {
      differences.push({
        field,
        cli: summarize(left[field]),
        mcp: summarize(right[field]),
      })
    }
  }
  return { equivalent: differences.length === 0, differences }
}

function summarize(value) {
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return `object(keys=${Object.keys(value).length})`
  return String(value).slice(0, 120)
}

/** 判断一行 stdout 是否为合法 JSON-RPC 消息（用于 MCP stdout 纯净性检查） */
export function isJsonRpcLine(line) {
  const text = line.trim()
  if (!text) return true
  try {
    const parsed = JSON.parse(text)
    return Boolean(parsed && parsed.jsonrpc === '2.0' && (typeof parsed.method === 'string' || typeof parsed.id !== 'undefined'))
  } catch {
    return false
  }
}
