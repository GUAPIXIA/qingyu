#!/usr/bin/env node
/**
 * 仓库级依赖边界检查（结构阶段 5）。
 *
 * 覆盖（方案 §5.4）：
 *   1. shared 纯核心：不得依赖 Electron/React/Zustand/DOM/Node fs、不得引用 PC 源码或 @qingyu/spatial-core。
 *   2. PC（src + electron）：不得引用 spatial-board 内部源码。
 *   3. spatial-board：不得反向依赖 PC（src/electron/shared）；仅允许 @qingyu/spatial-core 公开入口。
 *   4. packages/spatial-core：无宿主/共享依赖（不引用 shared、PC、画板、React/Electron/Zustand）。
 *   5. features 交叉导入：src/features/<a> 不得导入其它 feature 的内部实现（白名单登记理由）。
 *   6. features 循环：feature 间相对导入不得成环。
 *
 * 说明：传输层「仓储写实现」由 scripts/check-write-bypass.mjs 负责；本脚本聚焦依赖方向闭环。
 * 纯文本匹配仅作辅助（如 shared 的 window./document. 使用），不单独作为依赖结论。
 *
 * 用法：
 *   node scripts/check-boundaries.mjs             # 正常检查
 *   node scripts/check-boundaries.mjs --self-test # 负例自检：注入违例必须被拦截
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const posix = (p) => p.split(sep).join('/')

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|mjs|jsx)$/

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name)) out.push(full)
  }
  return out
}

function extractImports(source) {
  const specs = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"`]+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source)) !== null) specs.push(m[1])
  }
  return specs
}

/** 去注释后用于文本辅助检查 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const ALIAS_PREFIXES = [['@/', 'src/'], ['~/', 'src/']]

/** 把 import 说明符解析为仓库内相对路径（posix）；包名返回 null。 */
function resolveSpec(callerRel, spec) {
  if (!spec.startsWith('.')) {
    for (const [alias, target] of ALIAS_PREFIXES) {
      if (spec.startsWith(alias)) return target + spec.slice(alias.length)
    }
    return null
  }
  const callerDir = callerRel.includes('/') ? callerRel.slice(0, callerRel.lastIndexOf('/')) : ''
  return posix(join(callerDir, spec))
}

function inDir(rel, dir) { return rel === dir || rel.startsWith(`${dir}/`) }

// ---- 规则实现（纯函数，便于负例自检） ----

const SHARED_PLATFORM_PKGS = [
  'electron', 'react', 'react-dom', 'zustand', 'react-easy-crop', '@xyflow/react',
]
/** 共享核心禁止的宿主文件系统入口（node:crypto/path 等纯算法保留） */
const SHARED_FORBIDDEN_NODE = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'node:child_process', 'node:worker_threads']
const SHARED_FORBIDDEN_PREFIXES = ['src/', 'electron/', 'spatial-board/', 'packages/spatial-core', '@qingyu/']

/** 返回该文件的所有违规（每条 { file, spec, rule, reason }） */
export function checkFile(callerRel, source) {
  const violations = []
  const specs = extractImports(source)
  const resolved = specs.map((s) => [s, resolveSpec(callerRel, s)])
  const isTest = /\/__tests__\//.test(callerRel) || /\.(test|spec)\./.test(callerRel)

  // 规则 1：shared 纯核心（测试允许使用 Node fs 与夹具路径）
  if (inDir(callerRel, 'shared') && !isTest) {
    for (const [spec, res] of resolved) {
      const bare = spec.split('/')[0]
      if (SHARED_PLATFORM_PKGS.includes(bare) || SHARED_FORBIDDEN_NODE.includes(spec)) {
        violations.push({ file: callerRel, spec, rule: 'shared-platform', reason: `shared 不得依赖平台/宿主包 ${spec}` })
        continue
      }
      if (spec.startsWith('@qingyu/')) {
        violations.push({ file: callerRel, spec, rule: 'shared-platform', reason: 'shared 不得依赖 @qingyu 本地包' })
        continue
      }
      if (res && SHARED_FORBIDDEN_PREFIXES.some((p) => p.endsWith('/') ? res.startsWith(p) : res === p || res.startsWith(`${p}/`))) {
        violations.push({ file: callerRel, spec, rule: 'shared-platform', reason: `shared 不得引用 PC/画板/核心包路径 ${res}` })
      }
    }
    // 文本兜底（辅助）：仅匹配真实宿主访问模式，避免同名局部变量误报
    const code = stripComments(source)
    if (/\bwindow\s*\.\s*api\b/.test(code) || /\bglobalThis\s*\.\s*(window|document)\b/.test(code)) {
      violations.push({ file: callerRel, spec: '(window.api/globalThis)', rule: 'shared-platform', reason: 'shared 不得访问宿主全局（window.api）' })
    }
  }

  // 规则 2：PC 不得引用画板内部
  if (inDir(callerRel, 'src') || inDir(callerRel, 'electron')) {
    for (const [spec, res] of resolved) {
      const target = res ?? spec
      if (inDir(target, 'spatial-board') || /(^|\/)spatial-board\/src(\/|$)/.test(spec)) {
        violations.push({ file: callerRel, spec, rule: 'pc-no-board-internals', reason: `PC 不得引用画板内部路径 ${target}` })
      }
    }
  }

  // 规则 3：画板不得反向依赖 PC/共享
  if (inDir(callerRel, 'spatial-board/src')) {
    for (const [spec, res] of resolved) {
      if (spec === '@qingyu/spatial-core' || spec.startsWith('@qingyu/spatial-core/')) continue
      if (spec.startsWith('@qingyu/')) {
        violations.push({ file: callerRel, spec, rule: 'board-no-pc', reason: '画板仅可依赖 @qingyu/spatial-core' })
        continue
      }
      const target = res ?? spec
      if (inDir(target, 'src') || inDir(target, 'electron') || inDir(target, 'shared') || inDir(target, 'packages')) {
        violations.push({ file: callerRel, spec, rule: 'board-no-pc', reason: `画板不得反向依赖 ${target}` })
      }
    }
  }

  // 规则 4：spatial-core 纯领域包
  if (inDir(callerRel, 'packages/spatial-core/src')) {
    for (const [spec, res] of resolved) {
      const bare = spec.split('/')[0]
      if (['electron', 'react', 'react-dom', 'zustand', '@xyflow/react'].includes(bare)) {
        violations.push({ file: callerRel, spec, rule: 'core-purity', reason: `spatial-core 不得依赖 ${bare}` })
        continue
      }
      if (spec.startsWith('@qingyu/')) {
        violations.push({ file: callerRel, spec, rule: 'core-purity', reason: 'spatial-core 不得依赖 @qingyu 包' })
        continue
      }
      const target = res ?? spec
      if (inDir(target, 'src') || inDir(target, 'electron') || inDir(target, 'shared') || inDir(target, 'spatial-board')) {
        violations.push({ file: callerRel, spec, rule: 'core-purity', reason: `spatial-core 不得依赖宿主路径 ${target}` })
      }
    }
  }

  // 规则 5：features 交叉导入（白名单登记）
  const featureOf = (rel) => {
    const m = /^src\/features\/([^/]+)\//.exec(rel)
    return m ? m[1] : null
  }
  const callerFeature = featureOf(callerRel)
  if (callerFeature) {
    for (const [spec, res] of resolved) {
      if (!res || !inDir(res, 'src/features')) continue
      const targetFeature = /^src\/features\/([^/]+)\//.exec(res)?.[1]
      if (!targetFeature || targetFeature === callerFeature) continue
      if (FEATURE_CROSS_ALLOWLIST.some(([a, b]) => a === callerFeature && b === targetFeature)) continue
      violations.push({ file: callerRel, spec, rule: 'features-cross', reason: `features/${callerFeature} 不得导入 features/${targetFeature} 内部实现` })
    }
  }

  return violations
}

/**
 * feature 交叉导入白名单：仅允许「通用基础设施型 feature」被消费，且登记理由。
 * 新增条目必须写明消费者与退出条件（方案 §5.4）。
 */
export const FEATURE_CROSS_ALLOWLIST = [
  ['chat', 'lorebook'],
  ['group-chat', 'lorebook'],
]

/** feature 间依赖图 + 环检测（仅统计白名单允许的边也要无环） */
export function buildFeatureGraph(files) {
  const edges = new Map()
  for (const { rel, source } of files) {
    const a = /^src\/features\/([^/]+)\//.exec(rel)?.[1]
    if (!a) continue
    for (const spec of extractImports(source)) {
      const res = resolveSpec(rel, spec)
      if (!res || !inDir(res, 'src/features')) continue
      const b = /^src\/features\/([^/]+)\//.exec(res)?.[1]
      if (!b || b === a) continue
      if (!edges.has(a)) edges.set(a, new Set())
      edges.get(a).add(b)
    }
  }
  return edges
}

export function findFeatureCycles(graph) {
  const cycles = []
  const state = new Map()
  const stack = []
  const dfs = (node) => {
    state.set(node, 1)
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        const start = stack.indexOf(next)
        cycles.push([...stack.slice(start), next])
      } else if (!state.has(next)) dfs(next)
    }
    stack.pop()
    state.set(node, 2)
  }
  for (const node of graph.keys()) if (!state.has(node)) dfs(node)
  return cycles
}

// ---- 扫描与主流程 ----

const SCAN_DIRS = ['src', 'electron', 'shared', 'packages/spatial-core/src', 'spatial-board/src']

function scanRepo() {
  const files = []
  for (const dir of SCAN_DIRS) {
    for (const full of walk(join(REPO, dir))) {
      const rel = posix(relative(REPO, full))
      files.push({ rel, source: readFileSync(full, 'utf8') })
    }
  }
  return files
}

function runSelfTest() {
  const cases = [
    ['shared/chat-core/x.ts', "import { app } from 'electron'\n", 'shared-platform'],
    ['shared/chat-core/x.ts', "import { useStore } from '../../src/store/useChatStore'\n", 'shared-platform'],
    ['shared/chat-core/x.ts', 'const a = window.api.chat\n', 'shared-platform'],
    ['src/pages/x.ts', "import m from '../../spatial-board/src/store/spatialStore'\n", 'pc-no-board-internals'],
    ['spatial-board/src/store/x.ts', "import { useChatStore } from '../../../src/store/useChatStore'\n", 'board-no-pc'],
    ['packages/spatial-core/src/x.ts', "import { X } from '../../../src/features/chat/x'\n", 'core-purity'],
    ['src/features/chat/x.ts', "import { y } from '../group-chat/y'\n", 'features-cross'],
  ]
  let failed = 0
  for (const [file, source, rule] of cases) {
    const hits = checkFile(file, source).filter((v) => v.rule === rule)
    if (hits.length === 0) { console.error(`  ✗ 负例未被拦截: ${file} → ${rule}`); failed++ }
    else console.log(`  ✓ 负例被拦截: ${rule}`)
  }
  // 环检测负例
  const g = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]])
  if (findFeatureCycles(g).length === 0) { console.error('  ✗ 循环负例未被拦截'); failed++ }
  else console.log('  ✓ 负例被拦截: features-cycle')
  if (failed > 0) { console.error(`负例自检失败 ${failed} 项`); process.exit(1) }
  console.log('check:boundaries 负例自检通过（8 项）')
  process.exit(0)
}

if (process.argv.includes('--self-test')) runSelfTest()

const files = scanRepo()
const violations = []
for (const { rel, source } of files) violations.push(...checkFile(rel, source))
for (const cycle of findFeatureCycles(buildFeatureGraph(files))) {
  violations.push({ file: cycle[0], spec: cycle.join(' → '), rule: 'features-cycle', reason: 'feature 间导入成环' })
}

if (violations.length === 0) {
  console.log(`check:boundaries OK — 扫描 ${files.length} 个源文件，依赖方向符合规则。`)
  process.exit(0)
}
console.error(`check:boundaries FAILED — ${violations.length} 处边界违规：`)
for (const v of violations) console.error(`  [${v.rule}] ${v.file} → ${v.spec}  (${v.reason})`)
process.exit(1)
