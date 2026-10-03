/**
 * 已删除共享转发路径门禁（2026-10-02 阶段 5）。
 *
 * 背景：19 个 src 共享转发文件已在阶段 1 删除，消费者统一指向 shared/chat-core。
 * 本门禁防止旧路径被重新引入（新建同路径文件、或从已删除路径导入）。
 *
 * 用法：node scripts/check-forwarders.mjs
 * 退出码：0 = 通过；1 = 发现违规引用。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'

const ROOT = resolve(process.cwd())

// 阶段 1 删除的转发层（相对 src/）
const FORWARDERS = [
  'context/contextBuilder',
  'store/chatConstants',
  'store/chatTypes',
  'store/contextShared',
  'store/generatedReplyPipeline',
  'utils/chatTemplates',
  'utils/lorebook',
  'utils/lorebookRenderer',
  'utils/lorebookRetrieval',
  'utils/macros',
  'utils/memory',
  'utils/memoryWindow',
  'utils/messagePostProcess',
  'utils/promptConverters',
  'utils/regex',
  'utils/tokenCounter',
  'utils/variables',
  'utils/vector',
  'components/chat/aiInputHelper',
]

const SCAN_DIRS = ['src', 'electron', 'shared', 'tests', 'scripts', 'tools']
const violations = []

// 1) 转发文件不应被重新创建
for (const f of FORWARDERS) {
  const p = resolve(ROOT, 'src', `${f}.ts`)
  if (existsSync(p)) violations.push(`转发文件被重新创建：src/${f}.ts`)
}

// 2) 任何源码/脚本不应从旧转发路径导入（含相对路径解析）
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const p = resolve(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) yield p
  }
}

for (const dir of SCAN_DIRS) {
  const abs = resolve(ROOT, dir)
  if (!existsSync(abs)) continue
  for (const file of walk(abs)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const src = readFileSync(file, 'utf8')
    if (!src.includes('import') && !src.includes('require(') && !src.includes('vi.mock')) continue
    const specs = src.match(/['"](?:\.\.?\/)[^'"]+['"]/g) || []
    for (const m of specs) {
      const spec = m.slice(1, -1).replace(/\\/g, '/')
      // 只检查从 tests/src 出发能解析到 src 旧路径的引用
      const fromDir = rel.replace(/\/[^/]+$/, '')
      const short = spec.replace(/^(?:\.\.?\/)+/, '')
      const up = (spec.match(/\.\.\//g) || []).length
      const parts = fromDir.split('/').slice(0, Math.max(0, fromDir.split('/').length - up))
      const resolved = [...parts, short].join('/')
      for (const f of FORWARDERS) {
        if (resolved === `src/${f}` || resolved === f) {
          violations.push(`${rel} -> ${spec}（旧转发路径）`)
        }
      }
    }
  }
}

if (violations.length) {
  console.error('发现已删除转发路径的新引用（阶段 1 约定：统一引用 shared/chat-core）：')
  for (const v of violations) console.error('  - ' + v)
  process.exit(1)
}
console.log(`check-forwarders：通过（${FORWARDERS.length} 个旧路径无新引用）`)