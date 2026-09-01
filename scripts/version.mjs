#!/usr/bin/env node
/**
 * 轻语版本管理脚本（PC 与 Android 各自维护独立版本）
 * 用法：
 *   node scripts/version.mjs status                  # 分别校验 PC 与 Android 的版本及更新日志
 *   node scripts/version.mjs patch|minor|major       # PC 版本 bump（--sync-android 同步安卓与文档）
 *   node scripts/version.mjs prerelease --pre alpha|beta|rc
 *   node scripts/version.mjs release [patch|minor|major] [--sync-android]
 *                                                    # PC 发布；仅显式指定时同步 Android
 *   node scripts/version.mjs android [version] [--bump-code]
 *                                                    # 设置 Android 独立版本并同步其文档
 *   node scripts/version.mjs set 0.12.0-beta.1 [--sync-android]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PKG_PATH = path.join(ROOT, 'package.json')
const TOML_PATH = path.join(ROOT, 'android/gradle/libs.versions.toml')
const ANDROID_README_PATH = path.join(ROOT, 'android/README.md')
const ANDROID_CHANGELOG_PATH = path.join(ROOT, 'android/CHANGELOG.md')
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

// ---- Android TOML：只解析/替换 appVersionName、appVersionCode 两行的值，注释与格式保持原样 ----
function readAndroidVersion() {
  // 读取 TOML 中的版本值（带注释的行不受影响，仅按行首键名匹配）
  const content = fs.readFileSync(TOML_PATH, 'utf8')
  const name = (content.match(/^appVersionName\s*=\s*"([^"]+)"/m) || [])[1] || null
  const codeStr = (content.match(/^appVersionCode\s*=\s*"(\d+)"/m) || [])[1] || null
  return { name, code: codeStr === null ? null : +codeStr }
}

function setAndroidVersion(target) {
  // 以 target（默认取 PC package.json.version）为权威同步 TOML：
  // versionName 变化时 versionCode 必须严格增大（默认 +1），保证 APK 可覆盖安装
  if (!fs.existsSync(TOML_PATH)) {
    console.error(`未找到 Android TOML: ${path.relative(ROOT, TOML_PATH)}`)
    return null
  }
  const cur = readAndroidVersion()
  const name = target || readPkg().version
  const bumpCode = args.includes('--bump-code')
  let code
  if (cur.name === name && !bumpCode) {
    code = cur.code // 已同步：不动 versionCode，纯 no-op
  } else {
    // versionName 变化（或 --bump-code 强制）：versionCode 必须严格增大，默认 +1
    code = (cur.code ?? 0) + 1
  }
  if (cur.code !== null && code < cur.code) {
    // 防御：任何路径都不允许 versionCode 回退（no-op 时 code === cur.code 属正常）
    console.error(`versionCode 必须严格增大（当前 ${cur.code}，目标 ${code}）`)
    return null
  }
  let content = fs.readFileSync(TOML_PATH, 'utf8')
  const next = content
    .replace(/^(appVersionName\s*=\s*")[^"]+(")/m, `$1${name}$2`)
    .replace(/^(appVersionCode\s*=\s*")[^"]+(")/m, `$1${code}$2`)
  if (next !== content) fs.writeFileSync(TOML_PATH, next, 'utf8')
  return { name, code, changed: next !== content, fromName: cur.name, fromCode: cur.code }
}

// ---- 文档版本行：README/CHANGELOG 不作为权威来源，只校验与对齐（仅动版本行，不改正文说明） ----
function readDocVersions() {
  const readme = { name: null, build: null, fileExists: fs.existsSync(ANDROID_README_PATH) }
  if (readme.fileExists) {
    const content = fs.readFileSync(ANDROID_README_PATH, 'utf8')
    const line = (content.match(/^当前版本 .*$/m) || [null])[0]
    if (line) {
      readme.name = (line.match(/\*\*([^*]+)\*\*/) || [])[1] || null
      readme.build = (line.match(/build (\d+)/) || [])[1] ? +line.match(/build (\d+)/)[1] : null
    }
  }
  const changelog = { name: null, fileExists: fs.existsSync(ANDROID_CHANGELOG_PATH) }
  if (changelog.fileExists) {
    const content = fs.readFileSync(ANDROID_CHANGELOG_PATH, 'utf8')
    changelog.name = (content.match(/^## \[([^\]]+)\]/m) || [])[1] || null
  }
  const pcChangelog = { name: null, fileExists: fs.existsSync(ROOT_CHANGELOG_PATH) }
  if (pcChangelog.fileExists) {
    const content = fs.readFileSync(ROOT_CHANGELOG_PATH, 'utf8')
    pcChangelog.name = (content.match(/^## \[(?!Unreleased\])([^\]]+)\]/m) || [])[1] || null
  }
  return { readme, changelog, pcChangelog }
}

function syncDocs(name, code) {
  // 对齐 android/README.md 版本行与 android/CHANGELOG.md 最新版本行
  const done = []
  if (fs.existsSync(ANDROID_README_PATH)) {
    const content = fs.readFileSync(ANDROID_README_PATH, 'utf8')
    const next = content.replace(
      /^当前版本 \*\*[^*]+\*\*（build \d+[^）]*）。/m,
      `当前版本 **${name}**（build ${code}，Android 独立版本）。`
    )
    if (next !== content) {
      fs.writeFileSync(ANDROID_README_PATH, next, 'utf8')
      done.push('android/README.md')
    }
  }
  if (fs.existsSync(ANDROID_CHANGELOG_PATH)) {
    const content = fs.readFileSync(ANDROID_CHANGELOG_PATH, 'utf8')
    // 只替换最新一条记录的行首版本号，日期与正文说明保持原样
    const next = content.replace(/^(## \[)[^\]]+(\])/m, `$1${name}$2`)
    if (next !== content) {
      fs.writeFileSync(ANDROID_CHANGELOG_PATH, next, 'utf8')
      done.push('android/CHANGELOG.md')
    }
  }
  return done
}

// ---- 一致性校验：PC 与 Android 独立；各自的清单、README、CHANGELOG 必须内部一致 ----
function collectIssues() {
  const issues = []
  const pkg = readPkg()
  const androidExists = fs.existsSync(TOML_PATH)
  const android = androidExists ? readAndroidVersion() : { name: null, code: null }
  const docs = readDocVersions()

  if (!androidExists) {
    issues.push(`Android TOML 缺失: android/gradle/libs.versions.toml`)
  } else {
    if (android.name === null) issues.push(`Android appVersionName 缺失`)
    if (android.code === null) issues.push(`Android appVersionCode 缺失或不是纯数字`)
  }
  if (!docs.readme.fileExists) {
    issues.push(`android/README.md 缺失`)
  } else {
    if (docs.readme.name === null) issues.push(`android/README.md 未找到版本行（应以「当前版本 **x.y.z**（build N…)」开头）`)
    else {
      if (android.name !== null && docs.readme.name !== android.name) issues.push(`android/README.md 版本 "${docs.readme.name}" != Android ${android.name}`)
      if (android.code !== null && docs.readme.build !== android.code) issues.push(`android/README.md build ${docs.readme.build} != Android versionCode ${android.code}`)
    }
  }
  if (!docs.changelog.fileExists) {
    issues.push(`android/CHANGELOG.md 缺失`)
  } else {
    if (docs.changelog.name === null) issues.push(`android/CHANGELOG.md 未找到版本记录行（## [x.y.z]）`)
    else if (android.name !== null && docs.changelog.name !== android.name) issues.push(`android/CHANGELOG.md 最新版本 "${docs.changelog.name}" != Android ${android.name}`)
  }
  if (!docs.pcChangelog.fileExists) {
    issues.push(`CHANGELOG.md 缺失`)
  } else if (docs.pcChangelog.name === null) {
    issues.push(`CHANGELOG.md 未找到正式版本记录行（## [x.y.z]）`)
  } else if (docs.pcChangelog.name !== pkg.version) {
    issues.push(`CHANGELOG.md 最新版本 "${docs.pcChangelog.name}" != PC ${pkg.version}`)
  }
  return { issues, pkg, android, docs }
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
  node scripts/version.mjs patch|minor|major [--sync-android]
  node scripts/version.mjs prerelease --pre alpha|beta|rc
  node scripts/version.mjs release [patch|minor|major] [--sync-android]
  node scripts/version.mjs android [version] [--bump-code]
  node scripts/version.mjs set <version> [--sync-android]
`)
  process.exit(0)
}

if (cmd === 'status') {
  // 独立版本一致性校验：PC package/CHANGELOG；Android TOML/README/CHANGELOG
  const { issues, pkg, android, docs } = collectIssues()
  console.log(`PC package.json:     ${pkg.version}`)
  console.log(`Android TOML:        ${android.name ?? '(缺失)'} / versionCode ${android.code ?? '-'}`)
  console.log(`android/README.md:   ${docs.readme.name ?? '(未找到)'} / build ${docs.readme.build ?? '-'}`)
  console.log(`android/CHANGELOG.md: 最新记录 ${docs.changelog.name ?? '(未找到)'}`)
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
    console.error(`\n修复: 分别对齐 package.json/CHANGELOG.md 与 Android TOML/README/CHANGELOG`)
    process.exit(1)
  }
  console.log(`\n✔ 版本一致：PC ${pkg.version}；Android ${android.name} / build ${android.code}`)
  process.exit(0)
}

if (cmd === 'android') {
  // Android 独立版本；显式版本变化时 versionCode 严格 +1（--bump-code 可强制 +1）
  const targetArg = args[1] && !args[1].startsWith('--') ? args[1] : readAndroidVersion().name
  if (!targetArg) { console.error('请提供 Android 版本号，如 0.2.0'); process.exit(1) }
  parseVersion(targetArg)
  const r = setAndroidVersion(targetArg)
  if (!r) process.exit(1)
  if (r.changed) {
    console.log(`Android: ${r.fromName}/${r.fromCode ?? '-'} -> ${r.name}/${r.code}${r.fromName !== r.name ? '（versionName 变化，versionCode 递增）' : '（--bump-code 强制递增）'}`)
    const synced = syncDocs(r.name, r.code)
    if (synced.length) console.log(`已对齐文档版本行: ${synced.join(', ')}`)
  } else {
    console.log(`Android 已同步: ${r.name} / versionCode ${r.code}（无变更）`)
    const synced = syncDocs(r.name, r.code)
    if (synced.length) console.log(`已对齐文档版本行: ${synced.join(', ')}`)
  }
  const { issues } = collectIssues()
  if (issues.length) {
    console.error(`✖ 同步后仍存在不一致:`)
    issues.forEach((s) => console.error(`  - ${s}`))
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === 'release') {
  // PC 发布：默认不改变 Android；仅 --sync-android 时显式同步为 PC 版本。
  const pkg = readPkg()
  const current = pkg.version
  const bumpArg = args[1] && !args[1].startsWith('--') ? args[1] : null
  let target
  try {
    if (bumpArg) target = bump(current, bumpArg, {})
    else if (parseVersion(current).pre) target = bump(current, 'release', {})
    else target = current // 已是正式发布版本：不 bump，仅执行同步与终检
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  if (target !== current) {
    pkg.version = target
    writePkg(pkg)
    console.log(`PC 版本: ${current} -> ${target}`)
  } else {
    console.log(`PC 版本: ${target}（发布版本，Android 保持独立版本）`)
  }
  if (args.includes('--sync-android')) {
    const r = setAndroidVersion(target)
    if (!r) process.exit(1)
    console.log(r.changed ? `Android: ${r.fromName}/${r.fromCode ?? '-'} -> ${r.name}/${r.code}` : `Android: ${r.name} / versionCode ${r.code}（无变更）`)
    const synced = syncDocs(target, r.code)
    if (synced.length) console.log(`已对齐 Android 文档版本行: ${synced.join(', ')}`)
  } else {
    const android = readAndroidVersion()
    console.log(`Android 保持独立版本: ${android.name} / versionCode ${android.code}`)
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
  if (args.includes('--sync-android')) {
    const r = setAndroidVersion(target)
    if (r) {
      console.log(r.changed ? `已同步 Android -> ${r.name} / versionCode ${r.code}` : 'Android 已是该版本（无需变更）')
      const synced = syncDocs(r.name, r.code)
      if (synced.length) console.log(`已对齐文档版本行: ${synced.join(', ')}`)
    }
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
  const r = setAndroidVersion(next)
  if (r) {
    console.log(r.changed ? `已同步 Android -> ${r.name} / versionCode ${r.code}` : 'Android 已是该版本（无需变更）')
    const synced = syncDocs(r.name, r.code)
    if (synced.length) console.log(`已对齐文档版本行: ${synced.join(', ')}`)
  }
}
