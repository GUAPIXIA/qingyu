import { describe, it, expect, vi } from 'vitest'
import { runGeneratedReplyPipeline } from '../generatedReplyPipeline'
import type { RegexRule } from '../../../shared/types'

function makeRule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    id: 'r1',
    name: '测试规则',
    enabled: true,
    scope: 'output',
    stage: 'text',
    pattern: 'A',
    flags: 'g',
    replacement: 'A A',
    ...overrides,
  }
}

describe('runGeneratedReplyPipeline（S1 统一收尾顺序）', () => {
  it('output 正则先于收尾器执行，且每条消息只执行一次', async () => {
    const outcome = await runGeneratedReplyPipeline({
      rawText: '她A。',
      finishReason: 'stop',
      regexRules: [makeRule()],
      characterName: '艾琳',
    })
    // 只执行一次：'她A A。'；若执行两次会得到 '她A A A A。'
    expect(outcome.content).toBe('她A A。')
    expect(outcome.status).toBe('complete')
  })

  it('正则破坏结构后由收尾器兜底，不把未闭合格式当作完整成功', async () => {
    // 删除结尾引号 → 结构不闭合；收尾器必须判为需要补尾并给出补尾上下文
    const stripQuote = makeRule({ pattern: '”', replacement: '' })
    const seen: string[] = []
    const outcome = await runGeneratedReplyPipeline({
      rawText: '她说：“今天不去。”',
      finishReason: 'stop',
      regexRules: [stripQuote],
      characterName: '艾琳',
      runTailRepair: async (finalized) => {
        seen.push(finalized.repairContext ?? '')
        return '她转身离开。'
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('她说：“今天不去。')
    expect(outcome.content).toBe('她转身离开。')
    expect(outcome.status).toBe('recovered')
    expect(outcome.notice).toBe('tail_repaired')
  })

  it('补尾失败时保留稳定前缀并标记 repairFailed', async () => {
    const stripQuote = makeRule({ pattern: '”', replacement: '' })
    const outcome = await runGeneratedReplyPipeline({
      rawText: '第一句完整。第二句她说：“今天不去。”',
      finishReason: 'stop',
      regexRules: [stripQuote],
      characterName: '艾琳',
      runTailRepair: async () => null,
    })
    expect(outcome.content).toBe('第一句完整。')
    expect(outcome.status).toBe('recovered')
    expect(outcome.repairFailed).toBe(true)
  })

  it('停止字符串在收尾器之前截断', async () => {
    const stopRule = makeRule({ pattern: 'ZZZ', replacement: '', stopStrings: ['###'] })
    const outcome = await runGeneratedReplyPipeline({
      rawText: '她推开门。### 后面是模型多余输出',
      finishReason: 'stop',
      regexRules: [stopRule],
      characterName: '艾琳',
    })
    expect(outcome.content).toBe('她推开门。')
    expect(outcome.status).toBe('complete')
  })

  it('legacy 管线在正则之后原样透传，不进收尾器与补尾', async () => {
    const repair = vi.fn()
    const outcome = await runGeneratedReplyPipeline({
      rawText: '她推开门，走进房间，然后她伸手拿',
      finishReason: 'length',
      regexRules: [],
      characterName: '艾琳',
      legacy: true,
      runTailRepair: repair,
    })
    expect(outcome.status).toBe('raw')
    expect(outcome.content).toBe('她推开门，走进房间，然后她伸手拿')
    expect(repair).not.toHaveBeenCalled()
  })

  it('供应商推理残留先被丢弃，不进入正文与正则', async () => {
    const outcome = await runGeneratedReplyPipeline({
      rawText: '<thinking>推理计划</thinking>她推开门。',
      finishReason: 'stop',
      regexRules: [],
      characterName: '艾琳',
    })
    expect(outcome.content).toBe('她推开门。')
    expect(outcome.status).toBe('complete')
  })

  it('无正文时返回 failed，由调用方走错误分支', async () => {
    const outcome = await runGeneratedReplyPipeline({
      rawText: '   ',
      finishReason: 'stop',
      regexRules: [],
      characterName: '艾琳',
    })
    expect(outcome.content).toBe('')
    expect(outcome.status).toBe('failed')
  })
})
