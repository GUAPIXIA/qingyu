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

  it('对话 "hello" 渲染为 span.dialogue-inline', () => {
    const c = renderMd('He said "hello" to me')
    const el = c.querySelector('span.dialogue-inline, em.dialogue-inline')
    expect(el).toBeTruthy()
    expect(el?.textContent).toBe('"hello"')
  })

  it('整段「角色：“对白”」渲染为 span.dialogue-block 并剥外层引号', () => {
    const c = renderMd('苏晚：“我知道。”')
    const block = c.querySelector('span.dialogue-block, strong.dialogue-block')
    expect(block).toBeTruthy()
    expect(block?.querySelector('.dialogue-speaker')?.textContent).toBe('苏晚')
    expect(block?.querySelector('.dialogue-text')?.textContent).toBe('我知道。')
  })

  it('整段纯引号对白渲染为匿名 dialogue-block（无说话人行）', () => {
    const c = renderMd('“我知道。”')
    const block = c.querySelector('span.dialogue-block, strong.dialogue-block')
    expect(block).toBeTruthy()
    expect(block?.querySelector('.dialogue-speaker')).toBeNull()
    expect(block?.querySelector('.dialogue-text')?.textContent).toBe('我知道。')
  })

  it('叙述式前缀不拆说话人块（与 blocks 路径 mixed 语义一致）', () => {
    const c = renderMd('她轻声说道：“别怕。”')
    expect(c.querySelector('span.dialogue-block, strong.dialogue-block')).toBeNull()
    expect(c.querySelector('.dialogue-inline')).toBeTruthy()
  })

  it('多行段落逐行分类：对白行成块，叙述行保持正文', () => {
    const c = renderMd('美洛拉：“真够傻的。”\n紫色外星人再次回击，交叉双臂。\n尤诺娃：“选我！”')
    const blocks = c.querySelectorAll('.dialogue-block')
    expect(blocks.length).toBe(2)
    expect(blocks[0].querySelector('.dialogue-speaker')?.textContent).toBe('美洛拉')
    expect(blocks[1].querySelector('.dialogue-speaker')?.textContent).toBe('尤诺娃')
    expect(c.textContent).toContain('紫色外星人再次回击')
  })

  it('整段动作 *walks away* 渲染为 p.action-block', () => {
    const c = renderMd('*walks away*')
    const p = c.querySelector('p.action-block')
    expect(p).toBeTruthy()
    expect(p?.textContent).toBe('walks away')
  })

  it('行内动作渲染为 em.action-em', () => {
    const c = renderMd('He said "hi" and *walked away*')
    expect(c.querySelector('.dialogue-inline')).toBeTruthy()
    expect(c.querySelector('em.action-em')?.textContent).toBe('walked away')
  })

  it('代码块内引号不误匹配', () => {
    const c = renderMd('Use `code "quotes"` here')
    expect(c.querySelector('.dialogue-inline')).toBeNull()
    expect(c.querySelector('code')?.textContent).toBe('code "quotes"')
  })

  it('CJK 引号 「你好」 也被识别', () => {
    const c = renderMd('她说「你好」给我听')
    const el = c.querySelector('.dialogue-inline')
    expect(el).toBeTruthy()
    expect(el?.textContent).toBe('"你好"')
  })

  it('动作内含粗体格式保留', () => {
    const c = renderMd('*walks **away***')
    expect(c.querySelector('p.action-block')?.textContent).toContain('walks')
  })
})
