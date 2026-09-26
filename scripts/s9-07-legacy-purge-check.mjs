#!/usr/bin/env node
/**
 * S9-07 验收：旧伴侣链路引用清零扫描。
 *
 * 用法：
 *   node scripts/s9-07-legacy-purge-check.mjs
 *
 * 退出码 0 = 清零；1 = 仍有生产/测试引用（列出文件）。
 * 扫描目标见 docs/方案/安卓独立客户端与主动同步/S9-07-旧伴侣链路删除清单.md
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

/** 禁止出现的生产符号（出现在源码即失败；文档/本脚本/方案目录除外） */
const FORBIDDEN = [
  'OnlineChatRepository',
  'QingyuApi',
  'buildBridgeRouter',
  'RelayAgent',
  'RelayRpcDispatcher',
  '/relay/v1/bridge',
  'companionLegacy',
  'PhoneConnectionSection',
  'usePairApproval',
]

const SKIP_DIR_PARTS = [
  join('docs', '方案'),
  join('docs', '报告'),
  join('docs', '架构'),
  join('docs', 'compose'),
  'node_modules',
  '.git',
  '.tmp-archive',
  'dist',
  'build',
  'coverage',
  '.poc-tmp',
  '合并前备份-20260820',
]

const INCLUDE_EXT = new Set(['.ts', '.tsx', '.kt', '.js', '.mjs', '.cjs'])

function shouldSkip(full) {
  const rel = relative(ROOT, full)
  return SKIP_DIR_PARTS.some((p) => rel.startsWith(p) || rel.includes(`\\${p}\\`) || rel.includes(`/${p}/`))
}

function walk(dir, out = []) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const full = join(dir, name)
    if (shouldSkip(full)) continue
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (INCLUDE_EXT.has(name.slice(name.lastIndexOf('.')))) out.push(full)
  }
  return out
}

function main() {
  const files = walk(ROOT)
  const hits = []
  for (const file of files) {
    const rel = relative(ROOT, file)
    if (rel.endsWith('s9-07-legacy-purge-check.mjs')) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const sym of FORBIDDEN) {
      if (text.includes(sym)) {
        const line = text.split('\n').findIndex((l) => l.includes(sym)) + 1
        hits.push({ file: rel, symbol: sym, line })
      }
    }
  }

  if (hits.length === 0) {
    console.log('S9-07 purge check: OK（0 命中）')
    process.exit(0)
  }
  console.error(`S9-07 purge check: FAILED（${hits.length} 命中）`)
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  ${h.symbol}`)
  }
  process.exit(1)
}

main()
