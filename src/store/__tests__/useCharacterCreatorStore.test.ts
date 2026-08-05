import { describe, it, expect } from 'vitest'
import { parseExpandResult, buildFieldGeneratePrompt, buildGreetingPrompt, cleanFieldOutput, CHARACTER_EXPAND_PROMPT } from '../useCharacterCreatorStore'
import type { Character } from '../../../shared/types'

const baseDraft = (): Character => ({
  id: 'test-id',
  name: '零',
  avatar: '',
  description: '银色短发女黑客',
  personality: '外冷内热',
  scenario: '赛博朋克都市',
  firstMessage: '*抬头* 你来了。',
  exampleDialog: '{{user}}: 你好\n{{char}}: 你好',
  tags: ['黑客'],
  lorebookId: null,
  alternateGreetings: [],
  creator: '',
  createdAt: 0,
  updatedAt: 0,
})

describe('parseExpandResult', () => {
  it('解析纯净 JSON', () => {
    const result = parseExpandResult(
      '{"name":"零","description":"27岁女黑客","personality":"冷静","scenario":"新上海","firstMessage":"*笑* 你好","exampleDialog":"{{user}}: 嗨\\n{{char}}: 嗨","tags":["赛博朋克","黑客"]}',
    )
    expect(result).toEqual({
      name: '零',
      description: '27岁女黑客',
      personality: '冷静',
      scenario: '新上海',
      firstMessage: '*笑* 你好',
      exampleDialog: '{{user}}: 嗨\n{{char}}: 嗨',
      tags: ['赛博朋克', '黑客'],
    })
  })

  it('剥离 ```json 代码块包裹', () => {
    const result = parseExpandResult('```json\n{"name":"测试","tags":["a"]}\n```')
    expect(result?.name).toBe('测试')
    expect(result?.tags).toEqual(['a'])
  })

  it('剥离前后杂文', () => {
    const result = parseExpandResult('好的，为你生成角色：\n{"name":"阿青"}\n希望你喜欢！')
    expect(result?.name).toBe('阿青')
  })

  it('截断 JSON 部分恢复（前段完整字段可用）', () => {
    const result = parseExpandResult('{"name":"零","description":"完整描述","personality":"被截断的字段')
    expect(result?.name).toBe('零')
    expect(result?.description).toBe('完整描述')
    expect(result?.personality).toBeUndefined()
  })

  it('剥离 <thought> 推理块后解析（块内含大括号不干扰边界定位）', () => {
    const result = parseExpandResult(
      '<thought>我要先构思一下角色设定 { 草稿 } 再输出</thought>{"name":"零","tags":["黑客"]}',
    )
    expect(result?.name).toBe('零')
    expect(result?.tags).toEqual(['黑客'])
  })

  it('完全非 JSON 返回 null 不抛异常', () => {
    expect(parseExpandResult('完全不是 JSON 的内容')).toBeNull()
    expect(parseExpandResult('')).toBeNull()
    expect(parseExpandResult('{')).toBeNull()
    expect(parseExpandResult('[]')).toBeNull()
  })

  it('字段类型过滤：非字符串字段忽略，tags 过滤非字符串', () => {
    const result = parseExpandResult('{"name":123,"description":null,"tags":[1,"a",null,"b"]}')
    expect(result?.name).toBeUndefined()
    expect(result?.description).toBeUndefined()
    expect(result?.tags).toEqual(['a', 'b'])
  })

  it('tags 最多 8 个', () => {
    const result = parseExpandResult(`{"tags":${JSON.stringify(Array.from({ length: 12 }, (_, i) => `t${i}`))}}`)
    expect(result?.tags).toHaveLength(8)
  })
})

describe('buildFieldGeneratePrompt', () => {
  it('排除当前字段，其他字段作为上下文', () => {
    const { systemPrompt, userContent } = buildFieldGeneratePrompt('personality', baseDraft())
    expect(systemPrompt).toContain('角色名：零')
    expect(systemPrompt).toContain('描述：银色短发女黑客')
    expect(systemPrompt).not.toContain('性格：')
    expect(userContent).toContain('性格特征')
  })

  it('tags 字段有专属输出要求', () => {
    const { systemPrompt } = buildFieldGeneratePrompt('tags', baseDraft())
    expect(systemPrompt).toContain('3-8 个标签')
  })

  it('无上下文时给出（无）占位', () => {
    const empty = baseDraft()
    empty.name = ''
    empty.description = ''
    empty.personality = ''
    empty.scenario = ''
    empty.firstMessage = ''
    empty.exampleDialog = ''
    empty.tags = []
    const { systemPrompt } = buildFieldGeneratePrompt('name', empty)
    expect(systemPrompt).toContain('（无）')
  })

  it('用户输入（想法/草稿）附加到 userContent 并说明创作方式', () => {
    const { userContent } = buildFieldGeneratePrompt('firstMessage', baseDraft(), '想写一个说话带刺的傲娇少女，开场白要有点火药味')
    expect(userContent).toContain('请为字段「首条消息」生成内容')
    expect(userContent).toContain('用户提供的想法或草稿')
    expect(userContent).toContain('说话带刺的傲娇少女')
    expect(userContent).toContain('完整保留用户的意图与细节')
  })

  it('空白用户输入不附加块', () => {
    const { userContent } = buildFieldGeneratePrompt('name', baseDraft(), '   ')
    expect(userContent).not.toContain('用户提供的想法或草稿')
  })
})

describe('buildGreetingPrompt', () => {
  it('无已有开场白时不要求差异化', () => {
    const draft = baseDraft()
    draft.firstMessage = ''
    draft.alternateGreetings = []
    const { systemPrompt } = buildGreetingPrompt(-1, draft)
    expect(systemPrompt).toContain('生成一条开场白')
    expect(systemPrompt).not.toContain('已有的开场白')
    expect(systemPrompt).toContain('{{user}}')
  })

  it('生成变体时列出已有开场白并要求风格不同', () => {
    const draft = baseDraft()
    draft.alternateGreetings = ['变体A内容', '变体B内容']
    const { systemPrompt } = buildGreetingPrompt(2, draft)
    expect(systemPrompt).toContain('已有的开场白')
    expect(systemPrompt).toContain('变体A内容')
    expect(systemPrompt).toContain('变体B内容')
    expect(systemPrompt).toContain('风格不同的新一条')
    expect(systemPrompt).not.toContain('变体C') // 不包含待生成条目自身
  })

  it('生成主消息时排除自身（firstMessage 不入已有列表）', () => {
    const draft = baseDraft()
    draft.alternateGreetings = ['变体A内容']
    const { systemPrompt } = buildGreetingPrompt(-1, draft)
    expect(systemPrompt).toContain('变体A内容')
    expect(systemPrompt).not.toContain('你来了')
  })

  it('用户输入附加到 userContent', () => {
    const { userContent } = buildGreetingPrompt(0, baseDraft(), '要冷淡一点，话少')
    expect(userContent).toContain('冷淡一点')
  })
})

describe('cleanFieldOutput', () => {
  it('剥离 <thought> 思考块', () => {
    expect(cleanFieldOutput('<thought>她是赛博朋克风格的角色，沉默寡言。</thought>*抬头看你* "来了？"')).toBe(
      '*抬头看你* "来了？"',
    )
  })

  it('剥离 <thinking> / <reasoning> 标签兜底', () => {
    expect(cleanFieldOutput('<thinking>构思中</thinking>内容A')).toBe('内容A')
    expect(cleanFieldOutput('<reasoning>推理</reasoning>内容B')).toBe('内容B')
  })

  it('剥离元语言引导句（到冒号）', () => {
    expect(cleanFieldOutput('好的，这是为你生成的首条消息：*抬头* "来了？"')).toBe('*抬头* "来了？"')
    expect(cleanFieldOutput('没问题，以下是角色描述：赛博朋克女黑客')).toBe('赛博朋克女黑客')
  })

  it('无冒号的普通内容不误删（如角色话术以"好的"开头）', () => {
    expect(cleanFieldOutput('好的，我明白了，我会等你回来。')).toBe('好的，我明白了，我会等你回来。')
  })

  it('tags 支持 JSON 数组输出', () => {
    expect(cleanFieldOutput('["赛博朋克","黑客","御姐"]', 'tags')).toBe('赛博朋克、黑客、御姐')
  })

  it('空输入返回空串', () => {
    expect(cleanFieldOutput('')).toBe('')
    expect(cleanFieldOutput('<thought></thought>')).toBe('')
  })
})

describe('CHARACTER_EXPAND_PROMPT', () => {
  it('包含 JSON 字段要求与 <START> 分隔约定', () => {
    expect(CHARACTER_EXPAND_PROMPT).toContain('"name"')
    expect(CHARACTER_EXPAND_PROMPT).toContain('"exampleDialog"')
    expect(CHARACTER_EXPAND_PROMPT).toContain('<START>')
    expect(CHARACTER_EXPAND_PROMPT).toContain('{{user}}')
  })
})
