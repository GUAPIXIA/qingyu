// @vitest-environment node
/**
 * sanitizeHtml 消毒器测试：存储型 XSS 防御（白名单标签 + 事件属性/危险协议过滤）
 */
import { describe, expect, it } from 'vitest'

const { sanitizeHtml } = require('../sanitize')

describe('sanitizeHtml', () => {
  it('剥离 script 块（含内容）', () => {
    expect(sanitizeHtml('<script>alert(1)</script>hello')).toBe('hello')
    expect(sanitizeHtml('a<script src="https://evil/x.js"></script>b')).toBe('ab')
  })

  it('剥离 style / iframe / object / svg 等危险容器（含内容）', () => {
    expect(sanitizeHtml('<iframe src="https://evil"></iframe>gone')).toBe('gone')
    expect(sanitizeHtml('<style>body{display:none}</style>ok')).toBe('ok')
    expect(sanitizeHtml('<object data="x"></object>ok')).toBe('ok')
    expect(sanitizeHtml('<svg onload=alert(1)>x</svg>ok')).toBe('ok')
  })

  it('移除事件属性（onerror / onclick / onload 等）', () => {
    expect(sanitizeHtml('<img src="https://ok.com/a.png" onerror="alert(1)">')).toBe('<img src="https://ok.com/a.png">')
    expect(sanitizeHtml('<p onclick="bad()">text</p>')).toBe('<p>text</p>')
    expect(sanitizeHtml('<a href="https://ok.com" onclick="bad()">ok</a>')).toBe('<a href="https://ok.com">ok</a>')
  })

  it('拒绝危险协议链接（javascript: / data: / vbscript: / file:）', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
    expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).toBe('<a>x</a>')
    expect(sanitizeHtml('<img src="file:///etc/passwd">')).toBe('<img>')
    expect(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).toBe('<a>x</a>')
  })

  it('保留合法 http/https 与相对链接', () => {
    expect(sanitizeHtml('<a href="https://ok.com">ok</a>')).toBe('<a href="https://ok.com">ok</a>')
    expect(sanitizeHtml('<a href="/relative/path">rel</a>')).toBe('<a href="/relative/path">rel</a>')
    expect(sanitizeHtml('<img src="https://cdn.example.com/a.png" alt="图">')).toBe('<img src="https://cdn.example.com/a.png" alt="图">')
  })

  it('白名单外标签剥离但保留文本内容', () => {
    expect(sanitizeHtml('<blink>闪</blink>')).toBe('闪')
    expect(sanitizeHtml('<marquee>跑马灯</marquee>')).toBe('跑马灯')
  })

  it('移除 style 属性（防 CSS 注入）', () => {
    expect(sanitizeHtml('<div style="position:fixed;top:0">x</div>')).toBe('<div>x</div>')
  })

  it('保留白名单格式标签', () => {
    expect(sanitizeHtml('<b>bold</b><i>it</i><code>c</code><br>')).toBe('<b>bold</b><i>it</i><code>c</code><br>')
    expect(sanitizeHtml('<h2>标题</h2><ul><li>1</li></ul>')).toBe('<h2>标题</h2><ul><li>1</li></ul>')
  })

  it('输出中不得残留任何危险片段', () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="https://evil"></iframe>',
      '<svg onload=alert(1)>',
      '<style>@import url(x)</style>',
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      '<form action="https://evil"><input name=p></form>',
    ]
    const danger = /<(script|iframe|object|embed|svg|form|input|style)|on\w+\s*=|javascript:|vbscript:|data:text\/html/i
    for (const p of payloads) {
      expect(sanitizeHtml(p)).not.toMatch(danger)
    }
  })

  it('非字符串输入返回空字符串', () => {
    expect(sanitizeHtml(undefined)).toBe('')
    expect(sanitizeHtml(null)).toBe('')
    expect(sanitizeHtml(123)).toBe('')
  })
})
