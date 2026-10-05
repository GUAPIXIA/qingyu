import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * scripts/release-notes.mjs 是发版用的 ESM 脚本（无类型声明，不参与 tsc 项目），
 * 这里按运行时行为导入，锁住规范 §四.1 固定的 Release 正文格式。
 */
const releaseNotes = (await import('../scripts/release-notes.mjs')) as {
  extractChangelogSection: (changelog: string, version: string) => string | null
  buildReleaseNotes: (section: string, quarkUrl?: string) => string
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string

describe('release-notes：CHANGELOG 章节提取', () => {
  it('能提取当前版本章节，且不越界到下一版本', () => {
    const section = releaseNotes.extractChangelogSection(CHANGELOG, PKG_VERSION)
    expect(section).toBeTruthy()
    expect(section!.startsWith(`## [${PKG_VERSION}]`)).toBe(true)
    expect(section!.endsWith('\n')).toBe(false) // 末尾空行由 buildReleaseNotes 统一补
    // 越界检查：章节内不得出现任何后续 `## [` 标题
    expect(/^##\s*\[/m.test(section!.split('\n').slice(1).join('\n'))).toBe(false)
  })

  it('版本不存在时返回 null（且不会把 0.2 误配到 0.20.0）', () => {
    expect(releaseNotes.extractChangelogSection(CHANGELOG, '99.99.99')).toBeNull()
    expect(releaseNotes.extractChangelogSection(CHANGELOG, '0.2')).toBeNull()
  })
})

describe('release-notes：Release 正文格式（规范 §四.1）', () => {
  const section = releaseNotes.extractChangelogSection(CHANGELOG, PKG_VERSION)!
  const notes = releaseNotes.buildReleaseNotes(section)

  it('固定为「网盘链接块 + 更新日志」两段，首行不留临时说明', () => {
    const lines = notes.split('\n')
    expect(lines[0]).toBe('夸克网盘链接')
    expect(lines[1]).toBe('https://pan.quark.cn/s/a9853284d260')
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe('# 更新日志')
    expect(lines[4]).toBe('')
    expect(lines[5]).toMatch(new RegExp(`^## \\[${PKG_VERSION.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`))
  })

  it('版本章节与 CHANGELOG 逐字一致（顺序与内容都不许改写）', () => {
    expect(notes).toContain(`${section}\n`)
    const nonEmptySectionLines = section.split('\n').filter((line) => line.trim() !== '')
    for (const line of nonEmptySectionLines) {
      expect(notes).toContain(line)
    }
  })

  it('不包含「本次为 PC 端版本」等临时说明，也不写服务器下载地址', () => {
    expect(notes).not.toContain('本次为 PC 端版本')
    expect(notes).not.toContain('cjbtj.xyz')
  })

  it('网盘链接可覆盖（链接变化时由用户提供新链接）', () => {
    const custom = releaseNotes.buildReleaseNotes(section, 'https://pan.quark.cn/s/example')
    expect(custom.split('\n')[1]).toBe('https://pan.quark.cn/s/example')
  })
})
