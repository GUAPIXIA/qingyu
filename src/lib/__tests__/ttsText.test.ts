import { describe, it, expect } from 'vitest'
import { sanitizeTtsText } from '../ttsText'

describe('sanitizeTtsText（朗读前清洗）', () => {
  it('纯文本原样保留', () => {
    expect(sanitizeTtsText('她推开门，轻轻叹了口气。')).toBe('她推开门，轻轻叹了口气。')
  })

  it('移除 markdown 图片（含 data URI 与远程图）', () => {
    expect(sanitizeTtsText('看这张：![插画](https://a.com/x.png) 好看吗？')).toBe('看这张： 好看吗？')
    expect(sanitizeTtsText('![图](data:image/png;base64,iVBORw0KGgo=)')).toBe('')
  })

  it('移除内嵌音频/视频/图片 HTML 标签', () => {
    expect(sanitizeTtsText('先听这个：<audio src="https://a.com/a.mp3" controls loop></audio> 然后继续。'))
      .toBe('先听这个： 然后继续。')
    expect(sanitizeTtsText('<img src="https://a.com/x.png" />结束')).toBe('结束')
  })

  it('移除裸 URL 与 data URI，保留链接文字', () => {
    expect(sanitizeTtsText('详见 https://example.com/a?b=1 的说明')).toBe('详见 的说明')
    expect(sanitizeTtsText('见[世界书指南](https://example.com)章节')).toBe('见世界书指南章节')
  })

  it('移除代码块与行内代码标记', () => {
    expect(sanitizeTtsText('设定如下：\n```js\nconst a = 1\n```\n完毕')).not.toContain('const')
    expect(sanitizeTtsText('围绕 `魔法水晶` 展开')).toBe('围绕 魔法水晶 展开')
  })

  it('保留中文标点与括号内容', () => {
    expect(sanitizeTtsText('（她笑了）「走吧。」')).toBe('（她笑了）「走吧。」')
  })

  it('空文本与仅媒体文本返回空串', () => {
    expect(sanitizeTtsText('')).toBe('')
    expect(sanitizeTtsText('<audio src="https://a.com/a.mp3"></audio>')).toBe('')
  })
})
