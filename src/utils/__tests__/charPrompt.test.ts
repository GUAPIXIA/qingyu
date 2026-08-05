import { describe, it, expect } from 'vitest'
import {
  buildCoverPrompt,
  inferGenderTag,
  extractVisualKeywords,
  extractSceneKeywords,
} from '../charPrompt'

describe('inferGenderTag', () => {
  it('中文女 → 1girl', () => {
    expect(inferGenderTag('她是一名女黑客')).toBe('1girl')
  })
  it('英文 girl/woman → 1girl', () => {
    expect(inferGenderTag('a girl with silver hair')).toBe('1girl')
  })
  it('男/他 → 1boy', () => {
    expect(inferGenderTag('他是退役士兵')).toBe('1boy')
  })
  it('无法判断返回空串', () => {
    expect(inferGenderTag('')).toBe('')
    expect(inferGenderTag('一条龙')).toBe('')
  })
})

describe('extractVisualKeywords', () => {
  it('提取发色', () => {
    expect(extractVisualKeywords('银色短发')).toContain('silver hair')
    expect(extractVisualKeywords('金色长发')).toContain('blonde hair')
    expect(extractVisualKeywords('乌黑长发')).toContain('black hair')
  })
  it('提取瞳色', () => {
    expect(extractVisualKeywords('一双蓝眼')).toContain('blue eyes')
    expect(extractVisualKeywords('异色瞳')).toContain('heterochromia')
  })
  it('无关键词返回空串', () => {
    expect(extractVisualKeywords('普通的描述')).toBe('')
  })
})

describe('extractSceneKeywords', () => {
  it('场景关键词映射', () => {
    expect(extractSceneKeywords('赛博朋克都市的霓虹街头')).toContain('cyberpunk')
    expect(extractSceneKeywords('幽暗的森林')).toContain('forest')
    expect(extractSceneKeywords('浩瀚的太空')).toContain('space')
  })
  it('未命中返回空串', () => {
    expect(extractSceneKeywords('')).toBe('')
  })
})

describe('buildCoverPrompt', () => {
  const draft = {
    name: '零',
    description: '银发女黑客，冷静果决',
    scenario: '赛博朋克都市',
    tags: ['黑客', '御姐'],
  }

  it('组合全部要素', () => {
    const prompt = buildCoverPrompt(draft)
    expect(prompt).toContain('best quality, masterpiece, highres')
    expect(prompt).toContain('1girl')
    expect(prompt).toContain('silver hair')
    expect(prompt).toContain('background: cyberpunk')
    expect(prompt).toContain('portrait, upper body, subject centered, looking at viewer')
    expect(prompt).toContain('黑客')
  })

  it('name 与 description 均为空返回 null', () => {
    expect(buildCoverPrompt({ name: '', description: '', scenario: '', tags: [] })).toBeNull()
  })

  it('仅 name 非空也可构建', () => {
    expect(buildCoverPrompt({ name: '零', description: '', scenario: '', tags: [] })).not.toBeNull()
  })

  it('空 tags 不产生空项', () => {
    const prompt = buildCoverPrompt({ ...draft, tags: [] })
    expect(prompt).not.toContain(', ,')
  })
})
