#!/usr/bin/env node
/**
 * 轻语发布说明生成脚本（GitHub Release 正文）
 *
 * 背景：发布规范（docs/规范/项目更新与上传规范.md §四.1）要求 Release 正文固定为
 * 「网盘链接块 + 更新日志」两段，且版本章节必须与 CHANGELOG.md 逐字一致。
 * 手工复制容易漏行、改动标点或带入临时说明，故用本脚本生成。
 *
 * 用法：
 *   node scripts/release-notes.mjs                       # 取 package.json 版本，写入 release-v2/release-notes-<x.y.z>.md
 *   node scripts/release-notes.mjs 0.21.0                # 指定版本（必须与 package.json 一致，否则报错）
 *   node scripts/release-notes.mjs --stdout              # 只打印，不写文件
 *   node scripts/release-notes.mjs --out <路径>          # 自定义输出路径
 *   node scripts/release-notes.mjs --quark <链接>        # 覆盖网盘链接
 *   node scripts/release-notes.mjs --allow-mismatch      # 允许版本与 package.json 不一致（仅预览用）
 *   node scripts/release-notes.mjs --check <文件>        # 校验已有说明文件与重新生成的内容一致
 *
 * 退出码：0 成功；1 失败（版本缺失、CHANGELOG 无该章节、版本不一致、--check 不一致）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md')
const PKG_PATH = path.join(ROOT, 'package.json')

/** 网盘备用下载链接：长期有效的文件夹分享链接，随每次发版沿用（见规范 §四.1） */
const DEFAULT_QUARK_URL = 'https://pan.quark.cn/s/a9853284d260'
const NOTES_HEADER = '夸克网盘链接'

function fail(message) {
  console.error(`[release-notes] ${message}`)
  process.exit(1)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从 CHANGELOG 文本中取出指定版本的章节（含 `## [x.y.z] - 日期` 标题行，不含后续章节）。
 * 找不到时返回 null。
 */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const heading = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  // 去掉章节尾部空行，保证生成结果只有一处行尾换行
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

/** 按规范 §四.1 组装 Release 正文：网盘链接块 + 更新日志 */
export function buildReleaseNotes(section, quarkUrl = DEFAULT_QUARK_URL) {
  return `${NOTES_HEADER}\n${quarkUrl}\n\n# 更新日志\n\n${section}\n`
}

function parseArgs(argv) {
  const options = { version: null, out: null, quark: DEFAULT_QUARK_URL, stdout: false, check: null, allowMismatch: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--stdout') options.stdout = true
    else if (arg === '--allow-mismatch') options.allowMismatch = true
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--quark') options.quark = argv[++i]
    else if (arg === '--check') options.check = argv[++i]
    else if (arg.startsWith('-')) fail(`未知参数：${arg}`)
    else if (options.version === null) options.version = arg
    else fail(`多余参数：${arg}`)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(PKG_PATH)) fail(`未找到 package.json：${PKG_PATH}`)
  if (!fs.existsSync(CHANGELOG_PATH)) fail(`未找到 CHANGELOG.md：${CHANGELOG_PATH}`)

  const pkgVersion = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version
  const version = options.version || pkgVersion

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`版本号格式无效：${version}（应为 x.y.z）`)
  }
  if (version !== pkgVersion && !options.allowMismatch) {
    fail(
      `版本 ${version} 与 package.json 的 ${pkgVersion} 不一致。` +
        '发布说明必须对应实际发布版本（规范 §四.1）；仅预览时加 --allow-mismatch。'
    )
  }

  const section = extractChangelogSection(fs.readFileSync(CHANGELOG_PATH, 'utf8'), version)
  if (!section) {
    fail(`CHANGELOG.md 中没有版本 ${version} 的章节（应形如 "## [${version}] - YYYY-MM-DD"）。请先归档 [Unreleased]。`)
  }

  const notes = buildReleaseNotes(section, options.quark)

  if (options.check) {
    if (!fs.existsSync(options.check)) fail(`待校验文件不存在：${options.check}`)
    // 只忽略 CRLF 与末尾空行：GitHub 上手工编辑过的正文常多一个尾部空行（渲染不可见），
    // 其余任何字符差异都必须报错，否则「与 CHANGELOG 逐字一致」的约束就失效了。
    const normalize = (text) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '\n')
    const existing = normalize(fs.readFileSync(options.check, 'utf8'))
    if (existing !== normalize(notes)) {
      fail(`说明文件与重新生成的内容不一致：${options.check}`)
    }
    console.log(`[release-notes] 校验通过：${options.check} 与 CHANGELOG ${version} 章节一致（仅忽略末尾空行）`)
    return
  }

  if (options.stdout) {
    process.stdout.write(notes)
    return
  }

  const outPath = options.out || path.join(ROOT, 'release-v2', `release-notes-${version}.md`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, notes, 'utf8')
  console.log(`[release-notes] 已生成 ${path.relative(ROOT, outPath)}（版本 ${version}，正文取自 CHANGELOG.md）`)
  console.log(`[release-notes] 发版步骤见 docs/规范/项目更新与上传规范.md §三，格式约定见 §四.1`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
