#!/usr/bin/env node
/**
 * 轻语版本管理脚本（PC 单端版本线）
 *
 * 安卓端已于 2026-10-14 从 PC 仓解绑：安卓版本线由 qingyu-android 独立仓自行维护，
 * 本脚本不再读写 `android/` 下的 TOML／README／CHANGELOG，也不再有 `--sync-android`。
 *
 * 用法：
 *   node scripts/version.mjs status                  # 校验 package.json 与 CHANGELOG.md 一致
 *   node scripts/version.mjs patch|minor|major       # PC 版本 bump
 *   node scripts/version.mjs prerelease --pre alpha|beta|rc
 *   node scripts/version.mjs release [patch|minor|major]
 *   node scripts/version.mjs set 0.12.0-beta.1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PKG_PATH = path.join(ROOT, 'package.json')
const ROOT_CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md')

function parseVersion(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/)
  if (!m) throw new Error(`无法解析版本: ${v}`)
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, preNum: m[5] ? +m[5] : null, raw: v }
}

function formatVersion(o) {
  let s = `${o.major}.${o.minor}.${o.patch}`
  if (o.pre) s += `-${o.pre}.${o.preNum}`
  return s
}

function readPkg() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'))
}
function writePkg(pkg) {
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

// ---- 文档版本行：CHANGELOG 不作为权威来源，只校验与对齐（仅动版本行，不改正文说明） ----
function readDocVersions() {
  const pcChangelog = { name: null, fileExists: fs.existsSync(ROOT_CHANGELOG_PATH) }
  if (pcChangelog.fileExists) {
    const content = fs.readFileSync(ROOT_CHANGELOG_PATH, 'utf8')
    pcChangelog.name = (content.match(/^## \[(?!Unreleased\])([^\]]+)\]/m) || [])[1] || null
  }
  return { pcChangelog }
}

// ---- 一致性校验：PC package.json 与 CHANGELOG.md 必须内部一致 ----
function collectIssues() {
  const issues = []
  const pkg = readPkg()
  const docs = readDocVersions()

  if (!docs.pcChangelog.fileExists) {
    issues.push(`CHANGELOG.md 缺失`)
  } else if (docs.pcChangelog.name === null) {
    issues.push(`CHANGELOG.md 未找到正式版本记录行（## [x.y.z]）`)
  } else if (docs.pcChangelog.name !== pkg.version) {
    issues.push(`CHANGELOG.md 最新版本 "${docs.pcChangelog.name}" != PC ${pkg.version}`)
  }
  return { issues, pkg, docs }
}

function bump(current, cmd, opts) {
  const v = parseVersion(current)
  switch (cmd) {
    case 'major': return formatVersion({ major: v.major + 1, minor: 0, patch: 0, pre: null, preNum: null })
    case 'minor': return formatVersion({ major: v.major, minor: v.minor + 1, patch: 0, pre: null, preNum: null })
    case 'patch': return formatVersion({ major: v.major, minor: v.minor, patch: v.patch + 1, pre: null, preNum: null })
    case 'prerelease': {
      const pre = opts.pre || 'alpha'
      if (v.pre === pre) return formatVersion({ ...v, preNum: v.preNum + 1 })
      return formatVersion({ ...v, pre, preNum: 1 })
    }
    case 'release': {
      if (!v.pre) throw new Error('当前不是预发布版本，无需 release')
      return formatVersion({ major: v.major, minor: v.minor, patch: v.patch, pre: null, preNum: null })
    }
    default: throw new Error(`未知命令: ${cmd}`)
  }
}

const args = process.argv.slice(2)
const cmd = args[0]

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`用法:
  node scripts/version.mjs status
  node scripts/version.mjs patch|minor|major
  node scripts/version.mjs prerelease --pre alpha|beta|rc
  node scripts/version.mjs release [patch|minor|major]
  node scripts/version.mjs set <version>
`)
  process.exit(0)
}

if (cmd === 'status') {
  // 单端版本一致性校验：PC package.json / CHANGELOG.md
  const { issues, pkg, docs } = collectIssues()
  console.log(`PC package.json:     ${pkg.version}`)
  console.log(`CHANGELOG.md:         最新记录 ${docs.pcChangelog.name ?? '(未找到)'}`)
  try {
    const { execSync } = await import('node:child_process')
    const tag = execSync('git describe --tags --abbrev=0 2>nul || git tag --list | sort -V | tail -1', { cwd: ROOT, encoding: 'utf8' }).trim()
    console.log(`最近 Tag: ${tag || '(无)'}`)
    if (tag) {
      const cleanTag = tag.replace(/^v/, '')
      if (cleanTag !== pkg.version) console.log(`提示: package.json 与 Tag 不一致（开发中属正常，发布前需对齐）`)
    }
  } catch {}
  if (issues.length) {
    console.error(`\n✖ 版本不一致（${issues.length} 处）:`)
    issues.forEach((s) => console.error(`  - ${s}`))
    console.error(`\n修复: 对齐 package.json 与 CHANGELOG.md 的版本行`)
    process.exit(1)
  }
  console.log(`\n✔ 版本一致：PC ${pkg.version}`)
  process.exit(0)
}

if (cmd === 'release') {
  // PC 发布：预发布版本转为正式版；已是正式版本则仅执行终检
  const pkg = readPkg()
  const current = pkg.version
  const bumpArg = args[1] && !args[1].startsWith('--') ? args[1] : null
  let target
  try {
    if (bumpArg) target = bump(current, bumpArg, {})
    else if (parseVersion(current).pre) target = bump(current, 'release', {})
    else target = current // 已是正式发布版本：不 bump，仅执行终检
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  if (target !== current) {
    pkg.version = target
    writePkg(pkg)
    console.log(`PC 版本: ${current} -> ${target}`)
  } else {
    console.log(`PC 版本: ${target}（发布版本，无需 bump）`)
  }
  const { issues } = collectIssues()
  if (issues.length) {
    console.error(`✖ 发布终检未通过:`)
    issues.forEach((s) => console.error(`  - ${s}`))
    process.exit(1)
  }
  console.log(`\n✔ PC 发布版本已就绪: ${target}`)
  process.exit(0)
}

if (cmd === 'set') {
  const target = args[1]
  if (!target) { console.error('请提供版本号，如 0.12.0-beta.1'); process.exit(1) }
  parseVersion(target) // 校验
  const pkg = readPkg()
  const prev = pkg.version
  pkg.version = target
  writePkg(pkg)
  console.log(`版本: ${prev} -> ${target}`)
  process.exit(0)
}

const pkg = readPkg()
const current = pkg.version
const preFlag = args.indexOf('--pre') !== -1 ? args[args.indexOf('--pre') + 1] : null

let next
try {
  next = bump(current, cmd, { pre: preFlag })
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

pkg.version = next
writePkg(pkg)
console.log(`版本: ${current} -> ${next}`)
