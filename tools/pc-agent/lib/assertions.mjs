// 有限、可复核的状态断言（方案 §6.1）。
// 只提供有限操作，输出 expected/actual；不做任意表达式求值。
export const ASSERT_OPERATORS = ['equals', 'contains', 'length', 'exists', 'absent', 'gte']

export function resolvePath(value, path) {
  if (!path) return value
  return String(path).split('.').reduce((current, segment) => {
    if (current === null || current === undefined) return undefined
    const match = /^([^\[\]]*)((?:\[\d+\])*)$/.exec(segment)
    if (!match) return undefined
    let next = current
    if (match[1]) next = next?.[match[1]]
    for (const index of match[2].match(/\d+/g) ?? []) next = next?.[Number(index)]
    return next
  }, value)
}

export function compare(actual, operator, expected) {
  switch (operator) {
    case 'equals':
      return { pass: deepEqual(actual, expected), expected, actual }
    case 'contains':
      if (Array.isArray(actual)) return { pass: actual.some((item) => deepEqual(item, expected)), expected, actual }
      return { pass: typeof actual === 'string' && actual.includes(String(expected)), expected, actual }
    case 'length':
      return { pass: (actual?.length ?? -1) === expected, expected, actual: actual?.length ?? null }
    case 'exists':
      return { pass: actual !== undefined && actual !== null, expected: '存在', actual: actual ?? null }
    case 'absent':
      return { pass: actual === undefined || actual === null, expected: '不存在', actual: actual ?? null }
    case 'gte':
      return { pass: typeof actual === 'number' && actual >= expected, expected, actual }
    default:
      return { pass: false, expected: operator, actual, error: `不支持的断言操作符：${operator}` }
  }
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

/**
 * 执行一条断言规格。
 * spec = { name?, action, args?, where?, path?, op, expected }
 * where（可选，单条件）= { path, equals }，用于在列表结果中先定位目标对象（如按会话 id），
 * 避免用下标碰运气；不做多条件组合，保持有限与可复核。
 * 返回 { name, op, path, expected, actual, pass }
 */
export async function runAssertionSpec(spec, { invokeAction, sessionId }) {
  if (!spec || !spec.action) throw new Error('断言规格缺少 action')
  if (!ASSERT_OPERATORS.includes(spec.op)) throw new Error(`不支持的断言操作符：${spec.op}`)

  const { result } = await invokeAction(spec.action, spec.args ?? [], { sessionId, purpose: 'assert', allowWrite: false })

  let source = result
  if (spec.where) {
    // where.list 支持“结果是对象、目标数组在其字段里”的形状（如 quickReply.listAll 的 global）
    const list = spec.where.list ? resolvePath(result, spec.where.list) : result
    const items = Array.isArray(list) ? list : []
    source = items.find((item) => compare(resolvePath(item, spec.where.path), spec.where.op ?? 'equals', spec.where.equals).pass)
    if (source === undefined) {
      return {
        name: spec.name ?? `${spec.action} ${spec.op}`,
        target: spec.action,
        where: spec.where,
        path: spec.path ?? null,
        op: spec.op,
        expected: spec.expected,
        actual: null,
        pass: false,
        error: `未找到满足 where 的对象：${spec.where.list ? `${spec.where.list}.` : ''}${spec.where.path} = ${JSON.stringify(spec.where.equals)}（列表长度 ${items.length}）`,
      }
    }
  }

  const actual = resolvePath(source, spec.path)
  const outcome = compare(actual, spec.op, spec.expected)
  return {
    name: spec.name ?? `${spec.action}${spec.path ? `.${spec.path}` : ''} ${spec.op}`,
    target: spec.action,
    where: spec.where ?? null,
    path: spec.path ?? null,
    op: spec.op,
    expected: outcome.expected,
    actual: outcome.actual,
    pass: Boolean(outcome.pass),
    error: outcome.error ?? null,
  }
}

/** 断言集合判断器：布尔表达式形式的复合断言不做支持，保持有限与可复核 */
export function summarizeAssertions(records) {
  return {
    total: records.length,
    passed: records.filter((item) => item.pass).length,
    failed: records.filter((item) => !item.pass).length,
  }
}
