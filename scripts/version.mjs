#!/usr/bin/env node
/**
 * 轻语版本管理脚本
 * 用法：
 *   node scripts/version.mjs status
 *   node scripts/version.mjs patch|minor|major
 *   node scripts/version.mjs prerelease --pre alpha|beta|rc
 *   node scripts/version.mjs release
 *   node scripts/version.mjs set 0.12.0-beta.1 [--sync-android]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PKG_PATH = path.join(ROOT, 'package.json')
const TOML_PATH = path.join(ROOT, 'android/gradle/libs.versions.toml')

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

function updateToml(versionName) {
  if (!fs.existsSync(TOML_PATH)) return false
  let content = fs.readFileSync(TOML_PATH, 'utf8')
  const next = content.replace(/^(appVersionName\s*=\s*")[^"]+(")/m, `$1${versionName}$2`)
  if (next !== content) {
    fs.writeFileSync(TOML_PATH, next, 'utf8')
    return true
  }
  return false
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
  node scripts/version.mjs release
  node scripts/version.mjs set <version> [--sync-android]
`)
  process.exit(0)
}

if (cmd === 'status') {
  const pkg = readPkg()
  console.log(`package.json version: ${pkg.version}`)
  try {
    const { execSync } = await import('node:child_process')
    const tag = execSync('git describe --tags --abbrev=0 2>nul || git tag --list | sort -V | tail -1', { cwd: ROOT, encoding: 'utf8' }).trim()
    console.log(`最近 Tag: ${tag || '(无)'}`)
    if (tag) {
      const cleanTag = tag.replace(/^v/, '')
      if (cleanTag !== pkg.version) console.log(`提示: package.json 与 Tag 不一致（开发中属正常，发布前需对齐）`)
    }
  } catch {}
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
  if (args.includes('--sync-android')) {
    const ok = updateToml(target)
    console.log(ok ? `已同步 android/libs.versions.toml -> ${target}` : '未更新 TOML（文件不存在或无需变更）')
  }
  process.exit(0)
}

const pkg = readPkg()
const current = pkg.version
const preFlag = args.indexOf('--pre') !== -1 ? args[args.indexOf('--pre') + 1] : null
const syncAndroid = args.includes('--sync-android')

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
if (syncAndroid) {
  const ok = updateToml(next)
  console.log(ok ? `已同步 android/libs.versions.toml -> ${next}` : '未更新 TOML')
}
