/**
 * Markdown 导出转义工具单元测试（R5/N15 修复）
 */
import { describe, expect, it } from 'vitest'
import { escapeMarkdownContent } from '../markdown'

describe('escapeMarkdownContent', () => {
  it('转义标题/斜体/代码/粗体等特殊字符', () => {
    expect(escapeMarkdownContent('# 标题')).toBe('\\# 标题')
    expect(escapeMarkdownContent('*斜体*')).toBe('\\*斜体\\*')
    expect(escapeMarkdownContent('`代码`')).toBe('\\`代码\\`')
    expect(escapeMarkdownContent('**粗体**')).toBe('\\*\\*粗体\\*\\*')
    expect(escapeMarkdownContent('[链接](x)')).toBe('\\[链接\\](x)')
    expect(escapeMarkdownContent('{大括号}')).toBe('\\{大括号\\}')
    expect(escapeMarkdownContent('下_划_线')).toBe('下\\_划\\_线')
  })

  it('转义图片语法前导 ![', () => {
    expect(escapeMarkdownContent('![恶意图片](http://evil/)')).toBe('\\!\\[恶意图片\\](http://evil/)')
  })

  it('反斜杠被转义', () => {
    expect(escapeMarkdownContent('a\\b')).toBe('a\\\\b')
  })

  it('普通文本不受影响', () => {
    expect(escapeMarkdownContent('你好，世界！')).toBe('你好，世界！')
    expect(escapeMarkdownContent('')).toBe('')
  })
})
