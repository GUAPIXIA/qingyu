import { describe, expect, it } from 'vitest'
import type { DialogueTendency } from '../types'
import { countVisibleCharacters } from '../textMetrics'
import {
  DIALOGUE_DIRECTION_LIMITS,
  DIALOGUE_DIRECTION_MAX_TOKENS,
  buildDialogueDirectionSystemPrompt,
  buildDialogueDirectionUserPrompt,
  hasSimilarDirections,
  isDialogueTendency,
  parseDialogueDirections,
  resolveDialogueDirectionsEnabled,
} from '../dialogueDirections'

const VALID: Array<{ id: string; label: string; content: string; tendency: DialogueTendency }> = [
  { id: 'safe', label: '追问封锁原因', content: '先不与守卫冲突，试着追问港口突然封锁的原因。', tendency: 'safe' },
  { id: 'explore', label: '寻找其他入口', content: '暂时离开正门，沿港口外围查看是否存在无人值守的通道。', tendency: 'explore' },
  { id: 'risky', label: '冒险直接闯关', content: '趁守卫注意力被分散时尝试突破封锁，承担立即暴露的风险。', tendency: 'risky' },
]

function wrap(payload: unknown): string {
  return `<directions>\n${JSON.stringify(payload)}\n</directions>`
}

describe('dialogueDirections', () => {
  it('兼容解析：优先新字段，其次旧游戏主持字段，最后关闭', () => {
    expect(resolveDialogueDirectionsEnabled(null)).toBe(false)
    expect(resolveDialogueDirectionsEnabled({})).toBe(false)
    expect(resolveDialogueDirectionsEnabled({ gameMasterMode: true })).toBe(true)
    expect(resolveDialogueDirectionsEnabled({ dialogueDirectionsEnabled: false, gameMasterMode: true })).toBe(false)
    expect(resolveDialogueDirectionsEnabled({ dialogueDirectionsEnabled: true })).toBe(true)
  })

  it('倾向枚举只接受三个稳定值', () => {
    expect(isDialogueTendency('safe')).toBe(true)
    expect(isDialogueTendency('explore')).toBe(true)
    expect(isDialogueTendency('risky')).toBe(true)
    expect(isDialogueTendency('bold')).toBe(false)
    expect(isDialogueTendency(undefined)).toBe(false)
  })

  it('可见字符统计忽略空白并按码点计数', () => {
    expect(countVisibleCharacters('你好 世界')).toBe(4)
    expect(countVisibleCharacters(' a\nb\tc ')).toBe(3)
    expect(countVisibleCharacters('🙂🙂')).toBe(2)
  })

  it('解析合法输出并按 safe/explore/risky 稳定排序', () => {
    const shuffled = [VALID[2], VALID[0], VALID[1]]
    const parsed = parseDialogueDirections(wrap(shuffled))
    expect(parsed.map((item) => item.tendency)).toEqual(['safe', 'explore', 'risky'])
    expect(parsed[0].label).toBe('追问封锁原因')
  })

  it('容忍 ```json 代码围栏包裹', () => {
    const fenced = '```json\n' + JSON.stringify(VALID) + '\n```'
    expect(parseDialogueDirections(`<directions>${fenced}</directions>`)).toHaveLength(3)
  })

  it('标签缺失或重复时整组作废', () => {
    expect(parseDialogueDirections(JSON.stringify(VALID))).toHaveLength(0)
    const duplicated = `${wrap(VALID)}${wrap(VALID)}`
    expect(parseDialogueDirections(duplicated)).toHaveLength(0)
  })

  it('数量不是 3 个时整组作废', () => {
    expect(parseDialogueDirections(wrap(VALID.slice(0, 2)))).toHaveLength(0)
    expect(parseDialogueDirections(wrap([...VALID, VALID[0]]))).toHaveLength(0)
  })

  it('倾向重复或缺失时整组作废', () => {
    const duplicated = [VALID[0], { ...VALID[1], tendency: 'safe' }, VALID[2]]
    expect(parseDialogueDirections(wrap(duplicated))).toHaveLength(0)
    const invalid = [VALID[0], VALID[1], { ...VALID[2], tendency: 'unknown' }]
    expect(parseDialogueDirections(wrap(invalid))).toHaveLength(0)
  })

  it('label 与 content 越界时整组作废', () => {
    const shortLabel = [{ ...VALID[0], label: '追问' }, VALID[1], VALID[2]]
    expect(parseDialogueDirections(wrap(shortLabel))).toHaveLength(0)
    const longLabel = [{ ...VALID[0], label: '追问港口封锁的真正原因与幕后势力' }, VALID[1], VALID[2]]
    expect(parseDialogueDirections(wrap(longLabel))).toHaveLength(0)
    const shortContent = [{ ...VALID[0], content: '追问原因。' }, VALID[1], VALID[2]]
    expect(parseDialogueDirections(wrap(shortContent))).toHaveLength(0)
    const longContent = [{ ...VALID[0], content: '先不与守卫冲突，试着追问港口突然封锁的原因，并观察守卫的反应来判断背后是否有更大的势力在操控这一切，同时留意周围是否有其他人在偷听这场对话的内容。' }, VALID[1], VALID[2]]
    expect(countVisibleCharacters(longContent[0].content)).toBeGreaterThan(DIALOGUE_DIRECTION_LIMITS.contentMaxChars)
    expect(parseDialogueDirections(wrap(longContent))).toHaveLength(0)
  })

  it('拒绝解释性前缀', () => {
    const prefixed = [{ ...VALID[0], content: '建议你追问港口封锁的原因，先不要惊动守卫。' }, VALID[1], VALID[2]]
    expect(parseDialogueDirections(wrap(prefixed))).toHaveLength(0)
  })

  it('拒绝高度相似的三项', () => {
    const duplicated = [
      { ...VALID[0] },
      { ...VALID[1], content: VALID[0].content.replace('。', '！') },
      { ...VALID[2], content: VALID[0].content },
    ]
    expect(hasSimilarDirections(duplicated)).toBe(true)
    expect(parseDialogueDirections(wrap(duplicated))).toHaveLength(0)
  })

  it('拒绝非 JSON 与非法项类型', () => {
    expect(parseDialogueDirections('<directions>不是 JSON</directions>')).toHaveLength(0)
    expect(parseDialogueDirections(wrap([{ label: 1, content: 2, tendency: 'safe' }]))).toHaveLength(0)
  })

  it('id 缺失时由倾向派生', () => {
    const noId = VALID.map(({ label, content, tendency }) => ({ label, content, tendency }))
    const parsed = parseDialogueDirections(wrap(noId))
    expect(parsed.map((item) => item.id)).toEqual(['safe', 'explore', 'risky'])
  })

  it('提示词按叙事模式区分身份，且不注入世界书', () => {
    const base = {
      userName: '林舟',
      charName: '艾莉丝',
      characterDescription: '港口守卫队长',
      recentMessages: [{ speaker: '林舟', content: '你好' }],
      latestReply: '港口已经封锁。',
    }
    const immersive = buildDialogueDirectionSystemPrompt({ ...base, narrativeMode: 'immersive' })
    expect(immersive).toContain('玩家角色')
    expect(immersive).toContain('不得替 艾莉丝')
    const omniscient = buildDialogueDirectionSystemPrompt({ ...base, narrativeMode: 'omniscient' })
    expect(omniscient).toContain('旁白')
    expect(omniscient).toContain('第三人称')
    expect(immersive).toContain(`<directions>`)
    expect(immersive).not.toContain('世界书')
  })

  it('用户提示词包含最近对话、最新回复与可选世界状态', () => {
    const withState = buildDialogueDirectionUserPrompt({
      userName: '林舟',
      charName: '艾莉丝',
      characterDescription: '守卫',
      narrativeMode: 'immersive',
      recentMessages: [{ speaker: '林舟', content: '发生了什么' }],
      latestReply: '港口已经封锁。',
      worldState: '北门封锁',
    })
    expect(withState).toContain('林舟：发生了什么')
    expect(withState).toContain('港口已经封锁。')
    expect(withState).toContain('北门封锁')

    const withoutState = buildDialogueDirectionUserPrompt({
      userName: '林舟',
      charName: '艾莉丝',
      characterDescription: '',
      narrativeMode: 'immersive',
      recentMessages: [],
      latestReply: '港口已经封锁。',
    })
    expect(withoutState).not.toContain('世界状态')
  })

  it('输出预算覆盖选项字数与 JSON 结构的最坏情况', () => {
    const { labelMaxChars, contentMaxChars, count } = DIALOGUE_DIRECTION_LIMITS
    const worstChars = count * (labelMaxChars + contentMaxChars)
    expect(DIALOGUE_DIRECTION_MAX_TOKENS).toBeGreaterThanOrEqual(worstChars * 2 + 128)
  })

  it('长度约束常量与校验一致', () => {
    expect(DIALOGUE_DIRECTION_LIMITS.count).toBe(3)
    expect(VALID.every((item) => countVisibleCharacters(item.content) <= DIALOGUE_DIRECTION_LIMITS.contentMaxChars)).toBe(true)
  })
})
