#!/usr/bin/env node
/**
 * 依赖边界检查：确保 spatial-board 不反向依赖轻语 PC 运行时代码。
 * 对应 docs/方案/空间画板-PC禁改清单-阶段0.md §5。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(root, 'src')

/** 允许的纯领域包（阶段 2：核心已提取为本地包，画板通过公开入口引用） */
const ALLOWED_PACKAGES = ['@qingyu/spatial-core']

/** 禁止出现的 import 来源（前缀或精确匹配） */
const FORBIDDEN_IMPORT_PATTERNS = [
  // PC 渲染层 / 主进程 / 共享契约
  /(^|\/)src\//,
  /(^|\/)electron\//,
  /(^|\/)shared\//,
  // 路径别名指向 PC
  /^@\//,
  /^@shared\//,
  /^@electron\//,
  // 相对路径逃逸出 spatial-board
  /^(\.\.\/)+src(\/|$)/,
  /^(\.\.\/)+electron(\/|$)/,
  /^(\.\.\/)+shared(\/|$)/,
]

const FORBIDDEN_PKG_PREFIXES = [
  // 未来若 PC 改成 workspace 包，这里继续拦
]

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue
      out.push(...walk(full))
    } else if (/\.(ts|tsx|mts|cts|js|mjs|jsx)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

function extractImports(source) {
  const specs = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source)) !== null) {
      specs.push(m[1])
    }
  }
  return specs
}

function checkFile(file) {
  const rel = relative(root, file).split(sep).join('/')
  const source = readFileSync(file, 'utf8')
  const violations = []
  for (const spec of extractImports(source)) {
    // 允许的纯领域包（唯一例外，且必须走公开入口）
    if (ALLOWED_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) continue
    for (const re of FORBIDDEN_IMPORT_PATTERNS) {
      if (re.test(spec)) {
        violations.push({ file: rel, spec, reason: `匹配禁用模式 ${re}` })
      }
    }
    for (const prefix of FORBIDDEN_PKG_PREFIXES) {
      if (spec === prefix || spec.startsWith(`${prefix}/`)) {
        violations.push({ file: rel, spec, reason: `禁用包 ${prefix}` })
      }
    }
  }
  return violations
}

function checkPackageJson() {
  const pkgPath = join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const violations = []
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  }
  for (const name of Object.keys(deps)) {
    if (ALLOWED_PACKAGES.includes(name)) continue
    if (name === 'qingyu' || (name.startsWith('qingyu-') && name !== 'qingyu-spatial-board') || name.startsWith('@qingyu/')) {
      violations.push({
        file: 'package.json',
        spec: name,
        reason: '不得依赖 PC 主包或其它 qingyu 内部包（仅允许 @qingyu/spatial-core）',
      })
    }
    if (FORBIDDEN_PKG_PREFIXES.some((p) => name === p || name.startsWith(`${p}/`))) {
      violations.push({ file: 'package.json', spec: name, reason: '禁用包' })
    }
  }
  return violations
}

const files = walk(srcRoot)
const violations = []
for (const f of files) {
  violations.push(...checkFile(f))
}
violations.push(...checkPackageJson())

if (violations.length === 0) {
  console.log(`check:boundary OK — 扫描 ${files.length} 个源文件，无 PC 反向依赖。`)
  process.exit(0)
}

console.error('check:boundary FAILED — 发现 PC 反向依赖：')
for (const v of violations) {
  console.error(`  ${v.file} → ${v.spec}  (${v.reason})`)
}
process.exit(1)
