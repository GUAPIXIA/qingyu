import { describe, it, expect } from 'vitest'
import { splitTtsChunks, DEFAULT_TTS_CHUNK_LEN } from '../ttsChunks'

describe('splitTtsChunks', () => {
  it('空文本返回空数组', () => {
    expect(splitTtsChunks('')).toEqual([])
    expect(splitTtsChunks('   \n  ')).toEqual([])
  })

  it('短文本不切分（短句合并到同一片段）', () => {
    expect(splitTtsChunks('第一句。第二句！第三句？')).toEqual(['第一句。第二句！第三句？'])
  })

  it('按句末标点断句，且每段不超过上限', () => {
    expect(splitTtsChunks('第一句。第二句！', 6)).toEqual(['第一句。', '第二句！'])
  })

  it('按换行断句', () => {
    expect(splitTtsChunks('第一段\n第二段', 3)).toEqual(['第一段', '第二段'])
  })

  it('超长无标点单句按 maxLen 硬切', () => {
    const chunks = splitTtsChunks('啊'.repeat(20), 8)
    expect(chunks).toEqual(['啊'.repeat(8), '啊'.repeat(8), '啊'.repeat(4)])
  })

  it('混合长句与短句时顺序与内容不丢', () => {
    const text = '短句。' + '长'.repeat(15) + '。收尾。'
    const chunks = splitTtsChunks(text, 8)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(8)
  })

  it('默认上限为正数', () => {
    expect(DEFAULT_TTS_CHUNK_LEN).toBeGreaterThan(0)
  })

  it('maxLen 非法时整段返回', () => {
    expect(splitTtsChunks('你好。世界。', 0)).toEqual(['你好。世界。'])
  })
})
