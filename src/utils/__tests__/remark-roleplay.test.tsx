import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkRoleplay } from '../remark-roleplay'

describe('remarkRoleplay 端到端渲染验证（标准 mdast 节点，无 rehypeRaw）', () => {
  const renderMd = (text: string) => {
    const { container } = render(
      React.createElement(ReactMarkdown, {
        remarkPlugins: [remarkGfm, remarkRoleplay],
        children: text,
      })
    )
    return container
  }

  it('对话 "hello" 渲染为 em.dialogue-inline', () => {
    const c = renderMd('He said "hello" to me')
    const el = c.querySelector('em.dialogue-inline')
    expect(el).toBeTruthy()
    expect(el?.textContent).toBe('"hello"')
  })

  it('带说话人 Alice: "Hi" 渲染为 strong.dialogue-block', () => {
    const c = renderMd('Alice: "Hi there"')
    const block = c.querySelector('strong.dialogue-block')
    expect(block).toBeTruthy()
    expect(block?.querySelector('em.dialogue-speaker')?.textContent).toBe('Alice')
    expect(block?.querySelector('em.dialogue-text')?.textContent).toBe('Hi there')
  })

  it('整段动作 *walks away* 渲染为 p.action-block', () => {
    const c = renderMd('*walks away*')
    const p = c.querySelector('p.action-block')
    expect(p).toBeTruthy()
    expect(p?.textContent).toBe('walks away')
  })

  it('行内动作渲染为 em.action-em', () => {
    const c = renderMd('He said "hi" and *walked away*')
    expect(c.querySelector('em.dialogue-inline')).toBeTruthy()
    expect(c.querySelector('em.action-em')?.textContent).toBe('walked away')
  })

  it('代码块内引号不误匹配', () => {
    const c = renderMd('Use `code "quotes"` here')
    expect(c.querySelector('em.dialogue-inline')).toBeNull()
    expect(c.querySelector('code')?.textContent).toBe('code "quotes"')
  })

  it('CJK 引号 「你好」 也被识别', () => {
    const c = renderMd('她说「你好」给我听')
    const el = c.querySelector('em.dialogue-inline')
    expect(el).toBeTruthy()
    expect(el?.textContent).toBe('"你好"')
  })

  it('动作内含粗体格式保留', () => {
    const c = renderMd('*action **bold** inside*')
    const p = c.querySelector('p.action-block')
    expect(p).toBeTruthy()
    expect(p?.querySelector('strong')?.textContent).toBe('bold')
  })
})
