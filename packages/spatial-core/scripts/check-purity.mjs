#!/usr/bin/env node
/**
 * 核心包纯依赖检查（阶段 2）：
 * - src 不得出现任何 bare import（本包零依赖，只允许 './x.ts' 相对导入）
 * - src 不得访问 window/document/localStorage/electron/fs 等宿主能力
 * - src 不得越过包边界引用 PC 仓库（src/、electron/、shared/、spatial-board/）
 * 用法：node packages/spatial-core/scripts/check-purity.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(pkgRoot, 'src')

const FORBIDDEN_SPEC_PATTERNS = [
  // 非相对导入（bare / 别名 / 绝对）一律禁止：核心包不依赖任何外部包
  { re: /^[^.]/, reason: 'bare import（核心包必须零依赖）' },
  { re: /^\.\.\//, reason: '越过包边界的相对导入' },
  { re: /^@\//, reason: 'PC 路径别名' },
  { re: /^@shared\//, reason: 'shared 路径别名' },
]

const FORBIDDEN_SOURCE_PATTERNS = [
  { re: /\bwindow\s*\./, reason: 'window 访问' },
  { re: /\bdocument\s*\./, reason: 'document 访问' },
  { re: /\blocalStorage\b/, reason: 'localStorage 访问' },
  { re: /\brequire\s*\(/, reason: 'require 调用' },
]
// 说明：react / zustand / electron / node:* 等依赖已由 bare-import 规则覆盖，
// 不在源码文本上做词匹配（避免注释中的框架名误报）。

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (/\.ts$/.test(name)) out.push(full)
  }
  return out
}

const violations = []
for (const file of walk(srcRoot)) {
  const rel = relative(pkgRoot, file).split(sep).join('/')
  const source = readFileSync(file, 'utf8')
  const importSpecs = [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1])
  for (const spec of importSpecs) {
    for (const { re, reason } of FORBIDDEN_SPEC_PATTERNS) {
      if (re.test(spec)) violations.push({ rel, what: spec, reason })
    }
  }
  for (const { re, reason } of FORBIDDEN_SOURCE_PATTERNS) {
    if (re.test(source)) violations.push({ rel, what: re.source, reason })
  }
}

if (violations.length > 0) {
  console.error('check:purity FAILED — 核心包出现依赖违规：')
  for (const v of violations) console.error(`  ${v.rel} → ${v.what} (${v.reason})`)
  process.exit(1)
}
console.log('check:purity OK — spatial-core 零外部依赖、无宿主访问。')