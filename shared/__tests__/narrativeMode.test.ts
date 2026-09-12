import { describe, expect, it } from 'vitest'
import {
  buildNarrativeModePrompt,
  buildGroupNarrativeModePrompt,
  getNarrativeMemoryGuidance,
  isNarrativeMode,
  resolveNarrativeMode,
} from '../narrativeMode'

describe('narrativeMode', () => {
  it('仅接受两个稳定枚举值', () => {
    expect(isNarrativeMode('immersive')).toBe(true)
    expect(isNarrativeMode('omniscient')).toBe(true)
    expect(isNarrativeMode('1')).toBe(false)
    expect(isNarrativeMode('invalid')).toBe(false)
  })

  it('按候选优先级解析并安全回退模式 1', () => {
    expect(resolveNarrativeMode(undefined, 'omniscient', 'immersive')).toBe('omniscient')
    expect(resolveNarrativeMode('invalid')).toBe('immersive')
  })

  it('两种模式生成互斥且包含角色名的行为约束', () => {
    const immersive = buildNarrativeModePrompt('immersive', '林舟', '艾琳')
    const omniscient = buildNarrativeModePrompt('omniscient', '林舟', '艾琳')
    expect(immersive).toContain('代入式角色扮演')
    expect(immersive).toContain('不替 林舟 说话')
    expect(omniscient).toContain('全局叙事')
    expect(omniscient).toContain('不局限于扮演 艾琳')
    expect(omniscient).toContain('【第三人称旁白：硬性输出约束】')
    expect(omniscient).toContain('讲述者始终是位于故事外部的旁白')
    expect(omniscient).toContain('不输出“艾琳：……”式发言稿')
  })

  it('全局叙事可使用自定义规则并替换身份与角色变量', () => {
    const prompt = buildNarrativeModePrompt(
      'omniscient',
      '林舟',
      '艾琳',
      '{{user}}观察世界，由{{char}}推动远方事件。',
    )
    expect(prompt).toContain('【叙事模式：全局叙事】')
    expect(prompt).toContain('林舟观察世界，由艾琳推动远方事件。')
    expect(prompt).not.toContain('故事旁白、导演和世界运行者')
    expect(prompt).toContain('正文主体必须使用第三人称叙事')
    expect(prompt).toContain('不得以角色的“我/我们”视角向 林舟 直接接话')
  })

  it('空白自定义规则安全回退内置规则', () => {
    const prompt = buildNarrativeModePrompt('omniscient', '林舟', '艾琳', '   ')
    expect(prompt).toContain('位于故事外部的第三人称旁白、导演和世界运行者')
  })

  it('群聊发言调度与叙事模式保持正交', () => {
    const immersive = buildGroupNarrativeModePrompt('immersive', '林舟', '艾琳', 'polling')
    const omniscient = buildGroupNarrativeModePrompt('omniscient', '林舟', '艾琳', 'polling')
    const free = buildGroupNarrativeModePrompt('immersive', '林舟', '群聊成员', 'free')

    expect(immersive).toContain('本轮只由当前发言角色「艾琳」回应')
    expect(immersive).not.toContain('异地事件或世界变化')
    expect(omniscient).toContain('发言调度仅指定剧情焦点「艾琳」')
    expect(omniscient).toContain('异地事件或世界变化')
    expect(omniscient).toContain('对白只能作为第三人称叙事中的引语')
    expect(free).toContain('每名角色只依据自己可感知')
    expect(free).toContain('【角色名】')
  })

  it('摘要侧重点随叙事模式变化', () => {
    expect(getNarrativeMemoryGuidance('immersive')).toContain('角色已经知晓')
    expect(getNarrativeMemoryGuidance('omniscient')).toContain('全局因果链')
  })

  it('主回复不再注入游戏主持判定与行动选项格式', () => {
    const omniscient = buildNarrativeModePrompt('omniscient', '林舟', '艾莉丝')
    expect(omniscient).not.toContain('【可选行动】')
    expect(omniscient).not.toContain('【判定】')
    const immersive = buildNarrativeModePrompt('immersive', '林舟', '艾莉丝')
    expect(immersive).not.toContain('游戏主持')
  })
})
