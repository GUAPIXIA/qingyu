#!/usr/bin/env node
// 从产品契约生成/刷新动作目录骨架，并渲染能力矩阵。
// 已由人工填写的字段会被保留；契约中已消失的登记默认保留并报告，需显式 --prune 才删除。
//
// 用法：
//   node tools/pc-agent/catalog.generate.mjs            # 生成/刷新（有悬空登记则报错退出）
//   node tools/pc-agent/catalog.generate.mjs --prune    # 一并删除悬空登记
//   node tools/pc-agent/catalog.generate.mjs --dry-run  # 只报告不写盘
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { contractSummary, loadContract } from './lib/ipc-contract.mjs'
import {
  CATALOG_DIR,
  MATRIX_PATH,
  buildSkeleton,
  indexDocs,
  loadCatalog,
  loadExclusions,
  mergeCatalog,
  renderMatrix,
} from './lib/catalog-model.mjs'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const prune = args.has('--prune')

const contract = loadContract()
const existing = loadCatalog()
const exclusions = loadExclusions()
const summary = contractSummary(contract)

const { docs, dropped } = mergeCatalog(buildSkeleton(contract), existing)

if (dropped.length > 0 && !prune && !dryRun) {
  console.error(`✗ 发现 ${dropped.length} 条登记指向契约中已不存在的方法（悬空登记）：`)
  for (const item of dropped) console.error(`  - ${item.apiPath}（模块 ${item.namespace}，状态 ${item.status}）`)
  console.error('  处理：确认产品接口移除后加 --prune 删除这些登记；若是契约引用写错，先修契约。')
  process.exit(1)
}

const matrix = renderMatrix({ contract, catalog: { docs, ...indexDocs(docs) }, exclusions })

if (dryRun) {
  console.log(`[dry-run] 契约 ${summary.contractPath}（哈希 ${summary.contractHash}）：命名空间 ${summary.namespaces}，成员 ${summary.members}`)
  console.log(`[dry-run] 将写入 ${docs.length} 个目录文件与能力矩阵；悬空登记 ${dropped.length} 条（${prune ? '将删除' : '将保留并报错'}）`)
  process.exit(0)
}

mkdirSync(CATALOG_DIR, { recursive: true })
for (const doc of docs) {
  writeFileSync(resolve(CATALOG_DIR, `${doc.namespace}.json`), `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}
mkdirSync(dirname(MATRIX_PATH), { recursive: true })
writeFileSync(MATRIX_PATH, matrix, 'utf8')

console.log(`✓ 已刷新动作目录：${docs.length} 个模块文件 → tools/pc-agent/catalog/`)
console.log('✓ 已渲染能力矩阵：docs/pc-agent/能力矩阵.md')
console.log(`  契约：${summary.contractPath}（哈希 ${summary.contractHash}）· 命名空间 ${summary.namespaces} · 成员 ${summary.members}`)
if (dropped.length > 0) console.log(`  已删除悬空登记：${dropped.length} 条`)
