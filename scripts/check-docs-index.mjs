#!/usr/bin/env node
/**
 * 文档索引门禁（只读）：docs 下每个非归档 md 必须至少被另一份文档的相对链接引用，
 * 且 docs/README.md 必须链接各分类索引页。防止「新文档写完没人能发现」与「归档后再无入口」。
 * 运行：node scripts/check-docs-index.mjs（或 pnpm check:docs-index）
 * 退出码：0 通过；1 存在未登记文档 / 缺分类索引 / 解析失败。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docsDir = join(root, 'docs')
const indexFile = join(docsDir, 'README.md')
const errors = []

/** docs/README.md 必须登记的分类索引页（相对 docs/） */
const REQUIRED_INDEXES = [
  '架构/adr/README.md',
  'compose/README.md',
  '报告/归档/README.md',
  '方案/归档/README.md',
]

function collect(dir, { skipArchive = false } = {}, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || (skipArchive && entry.name === '归档')) continue
      collect(full, { skipArchive }, out)
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

/** 取文件里的相对链接目标（绝对路径）；跳过 URL scheme、纯锚点与代码块 */
function linkTargets(file) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
  const targets = []
  for (const m of text.matchAll(/\]\(\s*([^)\s]+?)(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = m[1].replace(/^<|>$/g, '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue
    const bare = raw.split('#')[0]
    if (!bare) continue
    targets.push(resolve(dirname(file), decodeURIComponent(bare)))
  }
  return targets
}

function findUnregistered(candidates, inboundMap) {
  return candidates.filter((f) => !inboundMap.has(f))
}

const sources = collect(docsDir).concat([join(root, 'README.md')])
const inbound = new Map()
for (const file of sources) {
  for (const target of linkTargets(file)) {
    if (target === file) continue // 自链不算登记
    if (!inbound.has(target)) inbound.set(target, new Set())
    inbound.get(target).add(file)
  }
}

// 门禁自检：比对函数必须能识别注入的孤立样本，否则「永远绿」形同虚设
{
  const probe = findUnregistered([join(docsDir, '__docs-index-probe__.md')], inbound)
  if (probe.length !== 1) errors.push('自检失败：孤立文档比对函数未能识别注入样本')
}

const indexLinks = new Set(linkTargets(indexFile))
if (indexLinks.size === 0) errors.push('docs/README.md 未解析到任何相对链接（fail-loud）')
for (const rel of REQUIRED_INDEXES) {
  const abs = join(docsDir, rel)
  if (!existsSync(abs)) {
    errors.push(`分类索引缺失：docs/${rel}`)
    continue
  }
  if (!indexLinks.has(abs)) errors.push(`docs/README.md 未登记分类索引：./${rel}`)
}

const candidates = collect(docsDir, { skipArchive: true }).filter((f) => f !== indexFile)
if (candidates.length === 0) errors.push('docs 下未扫描到待检文档（fail-loud）')
const unregistered = findUnregistered(candidates, inbound)
for (const file of unregistered) {
  errors.push(`未登记（docs 内无任何文档链接到它）：${relative(root, file).replace(/\\/g, '/')}`)
}

if (errors.length) {
  console.error('check-docs-index FAILED')
  for (const e of errors) console.error(' -', e)
  process.exit(1)
}
console.log('check-docs-index OK')
console.log(` 待检文档=${candidates.length}（不含 归档/） 分类索引=${REQUIRED_INDEXES.length} 未登记=0`)
