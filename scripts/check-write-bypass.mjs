#!/usr/bin/env node
/**
 * 阶段 2 写入口绕过检测（静态启发式）。
 * 枚举 electron/ipc 与 electron/bridge 中仍直接 writeJson/writeFileSync 的域文件，
 * 输出报告供收口进度审计。退出码 0（仅报告），--strict 时若仍有高风险域则 exit 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')

const SCAN_DIRS = ['electron/ipc', 'electron/bridge', 'electron/services']
const WRITE_PATTERNS = [
  /writeJson\s*\(/,
  /writeFileSync\s*\(/,
  /writeFile\s*\(/,
  /renameSync\s*\(/,
]
const REPO_MARKERS = [
  /journalPutIfEnabled/,
  /putWithJournal/,
  /tombstoneWithJournal/,
  /ensureSyncDomain/,
]

/** 已知高风险同步域文件（阶段 2 收口清单） */
const HIGH_RISK = [
  'ipc/character.ts',
  'ipc/chat.ts',
  'ipc/group.ts',
  'ipc/lorebook.ts',
  'ipc/preset.ts',
  'ipc/quickReply.ts',
  'ipc/usage.ts',
  'bridge/routes.ts',
  'bridge/chatService.ts',
]

function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try {
      entries = readdirSync(d)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) stack.push(p)
      else if (name.endsWith('.ts')) out.push(p)
    }
  }
  return out
}

const report = []
for (const dirName of SCAN_DIRS) {
  const abs = join(root, dirName)
  for (const file of walk(abs)) {
    const rel = file.slice(root.length + 1).replace(/\\/g, '/')
    const text = readFileSync(file, 'utf8')
    const writes = WRITE_PATTERNS.filter((re) => re.test(text)).length
    if (!writes) continue
    const journaled = REPO_MARKERS.some((re) => re.test(text))
    const high = HIGH_RISK.some((h) => rel.endsWith(h))
    report.push({ rel, writes, journaled, high })
  }
}

const highOpen = report.filter((r) => r.high && !r.journaled)
const highDone = report.filter((r) => r.high && r.journaled)
const otherWrite = report.filter((r) => !r.high)

console.log('check-write-bypass')
console.log(` files-with-writes=${report.length}`)
console.log(` high-risk journaled=${highDone.length}/${HIGH_RISK.length}`)
for (const r of highDone) console.log(`  OK ${r.rel}`)
for (const r of highOpen) console.log(`  OPEN ${r.rel} writes~${r.writes}`)
console.log(` other-write-files=${otherWrite.length}`)

if (strict && highOpen.length) {
  console.error('strict: 仍有高风险域未接 Repository journal')
  process.exit(1)
}
