// 动作目录的运行期视图：装载、允许清单校验、参数校验、执行。
// 目录仍是唯一真源（tools/pc-agent/catalog/*.json）；这里只负责按目录执行，不硬编码业务逻辑。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { CATALOG_DIR } from '../platform.mjs'

export const OPTIONAL_PARAM = Symbol('optional')

/** 读取目录并建立 id → action 索引（只包含 status=mapped 的可执行动作） */
export function loadActions(dir = CATALOG_DIR) {
  if (!existsSync(dir)) return { all: new Map(), executable: new Map(), docs: [] }
  const docs = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    .map((name) => ({ file: name, ...JSON.parse(readFileSync(resolve(dir, name), 'utf8')) }))

  const all = new Map()
  const executable = new Map()
  for (const doc of docs) {
    for (const action of doc.actions ?? []) {
      const entry = { ...action, namespace: doc.namespace, doc }
      all.set(action.id, entry)
      if (action.status === 'mapped') executable.set(action.id, entry)
    }
  }
  return { all, executable, docs }
}

export function describeAction(action) {
  return {
    id: action.id,
    apiPath: action.apiPath,
    namespace: action.namespace,
    description: action.description,
    layer: action.layer,
    write: action.write === true,
    cancelable: action.cancelable,
    params: action.params,
    returns: action.returns,
    assertions: action.assertions ?? [],
    evidence: action.evidence ?? [],
  }
}

/**
 * 参数校验：按契约参数表检查数量与必填项。
 * 不做类型强校验（产品接口自己会校验），但拒绝明显的缺参/多参，让失败发生在调用前。
 */
export function validateArgs(action, args) {
  const params = action.params ?? []
  if (!Array.isArray(args)) return '参数必须是数组'
  const required = params.filter((param) => param.required)
  if (args.length < required.length) {
    return `参数不足：${action.id} 需要至少 ${required.length} 个参数（${params.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ')}），实际 ${args.length} 个`
  }
  if (args.length > params.length && !params.some((param) => param.rest)) {
    return `参数过多：${action.id} 最多 ${params.length} 个参数（${params.map((p) => p.name).join(', ')}），实际 ${args.length} 个`
  }
  return null
}

/** 写动作必须在会话允许清单内；读动作默认放行 */
export function checkPermission(action, allowedWriteModules) {
  if (action.write !== true) return null
  if (allowedWriteModules.includes(action.namespace)) return null
  return `未授权写动作：${action.id}（模块 ${action.namespace}）。启动会话时用 --allow-write ${action.namespace} 显式授权`
}

/**
 * 在真实页面里执行动作。
 * - contract 来源：按 apiPath 取到 window.api 上的方法并调用（参数作为结构化值传入，不拼接脚本文本）；
 * - tool 来源：交给对应适配器（当前为 UI 声明式步骤）。
 */
export async function dispatchAction(page, action, args) {
  if (action.origin === 'tool') {
    const { runUiAction } = await import('./ui-adapter.mjs')
    if (action.adapter !== 'ui') {
      const error = new Error(`未知工具动作适配器：${action.adapter}（${action.id}）`)
      error.code = 'ADAPTER_UNKNOWN'
      throw error
    }
    const outcome = await runUiAction(page, action, args)
    return { __value: outcome.value, __steps: outcome.steps }
  }
  return page.evaluate(async ({ apiPath, args: callArgs }) => {
    const segments = apiPath.split('.').slice(2) // 去掉 window.api 前缀（两段）
    let target = window.api
    for (const segment of segments.slice(0, -1)) {
      target = target?.[segment]
      if (!target) return { __dispatchError: `接口路径不存在：${apiPath}` }
    }
    const fn = target?.[segments.at(-1)]
    if (typeof fn !== 'function') return { __dispatchError: `不是可调用方法：${apiPath}` }
    try {
      const value = await fn.apply(target, callArgs)
      return { __value: value === undefined ? null : value }
    } catch (error) {
      return { __callError: String(error?.message ?? error) }
    }
  }, { apiPath: action.apiPath, args })
}

export function unwrapDispatch(outcome) {
  if (outcome && typeof outcome === 'object' && '__dispatchError' in outcome) {
    const error = new Error(outcome.__dispatchError)
    error.code = 'ACTION_NOT_FOUND'
    throw error
  }
  if (outcome && typeof outcome === 'object' && '__callError' in outcome) {
    const error = new Error(outcome.__callError)
    error.code = 'ACTION_FAILED'
    throw error
  }
  return outcome?.__value ?? null
}
