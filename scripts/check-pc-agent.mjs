#!/usr/bin/env node
/**
 * 外部 Agent 工具门禁：动作目录 ↔ 产品契约漂移检查（对应方案 v2 §5.5）。
 *
 * 默认校验（致命项，非零退出）：
 *  1. 每个 window.api 契约成员要么在 catalog 中有登记，要么在 catalog.exclusions.json 中带原因豁免；
 *  2. catalog 无悬空映射（指向已不存在的契约成员）；
 *  3. 动作 id 唯一、状态合法；status=mapped 的动作已填 description 与合法 layer；
 *  4. catalog 中的签名与契约一致（产品改接口后未重新生成即失败）；
 *  5. 豁免条目必须带 reason，且指向仍然存在的契约成员；
 *  6. docs/pc-agent/能力矩阵.md 与 catalog 渲染结果一致（矩阵陈旧即失败）。
 *
 * 另加 --require-covered：仍有 unregistered 成员时失败（阶段 5 用，日常不启用）。
 * 用法：node scripts/check-pc-agent.mjs [--json] [--require-covered]
 */
import { readFileSync } from 'node:fs'
import { loadContract, contractSummary } from '../tools/pc-agent/lib/ipc-contract.mjs'
import {
  MATRIX_PATH,
  loadCatalog,
  loadExclusions,
  validateCatalog,
} from '../tools/pc-agent/lib/catalog-model.mjs'

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const requireCovered = args.has('--require-covered')

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

let contract
let catalog
let exclusions
let matrixText
try {
  contract = loadContract()
  catalog = loadCatalog()
  exclusions = loadExclusions()
  matrixText = readIfExists(MATRIX_PATH)
} catch (error) {
  console.error('check-pc-agent FAILED')
  console.error(' - 读取契约/目录时出错：', error.message)
  process.exit(2)
}

const missingMatrix = matrixText === null
const result = validateCatalog({
  contract,
  catalog,
  exclusions,
  matrixText: missingMatrix ? '' : matrixText,
  requireCovered,
})

if (missingMatrix) {
  result.errors.push('能力矩阵文件不存在：docs/pc-agent/能力矩阵.md\n    处理：运行 pnpm pc-agent:catalog 生成')
}

const summary = contractSummary(contract)

if (asJson) {
  console.log(JSON.stringify({
    contract: summary,
    coverage: result.coverage,
    perNamespace: result.perNamespace,
    errors: result.errors,
    warnings: result.warnings,
    ok: result.errors.length === 0,
  }, null, 2))
  process.exit(result.errors.length === 0 ? 0 : 1)
}

if (result.errors.length > 0) {
  console.error('check-pc-agent FAILED')
  for (const error of result.errors) console.error(' -', error)
  process.exit(1)
}

console.log('check-pc-agent OK')
console.log(` 契约 ${summary.contractPath}（哈希 ${summary.contractHash}）`)
console.log(` 命名空间 ${summary.namespaces} · 契约成员 ${summary.members}`)
console.log(` 目录登记 mapped=${result.coverage.mapped} · pending=${result.coverage.pending} · unregistered=${result.coverage.unregistered} · 豁免=${result.coverage.excluded} · 工具动作=${result.coverage.toolActions}`)
if (result.coverage.pending > 0) {
  console.log(` 说明：${result.coverage.pending} 个成员已确认登记但需要模型/网络/原生对话框等环境才能验证（原因见能力矩阵）`)
}
if (result.coverage.unregistered > 0) {
  console.log(` 提示：${result.coverage.unregistered} 个成员尚未处理（阶段 3 逐批补全；阶段 5 用 --require-covered 收紧）`)
}
for (const warning of result.warnings) console.log(' ! ', warning)
