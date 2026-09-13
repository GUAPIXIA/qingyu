import { describe, expect, it } from 'vitest'
import {
  buildRepairContext,
  finalizeAssistantOutput,
  mergeTailRepair,
} from '../assistantOutputFinalizer'

/** 生成足够长（≥24 可见字符）的完整正文，避免落入补尾分支 */
const LONG_COMPLETE = '夜色深沉，她推开门，走进房间，环顾四周陌生的陈设与积灰的家具，心里一沉。'

describe('finalizeAssistantOutput：正常接受', () => {
  it('stop + 完整正文 → complete，无提示', () => {
    const r = finalizeAssistantOutput({ rawText: LONG_COMPLETE, finishReason: 'stop' })
    expect(r.status).toBe('complete')
    expect(r.notice).toBeUndefined()
    expect(r.content).toBe(LONG_COMPLETE)
    expect(r.diagnostics.completeSentence).toBe(true)
    expect(r.diagnostics.balancedQuotes).toBe(true)
  })

  it('length + 恰好完整句末 → 直接接受，不提示错误（方案 §5.2 步骤 5）', () => {
    const r = finalizeAssistantOutput({ rawText: LONG_COMPLETE, finishReason: 'length' })
    expect(r.status).toBe('complete')
    expect(r.notice).toBeUndefined()
  })

  it('network_error + 恰好完整 → 接受并提示 partial_network_output', () => {
    const r = finalizeAssistantOutput({ rawText: LONG_COMPLETE, finishReason: 'network_error' })
    expect(r.status).toBe('complete')
    expect(r.notice).toBe('partial_network_output')
  })

  it('thought 块保留（心理描写是业务特性），不参与正文长度', () => {
    const text = `<thought>我得留意窗外的动静。</thought>\n\n${LONG_COMPLETE}`
    const r = finalizeAssistantOutput({ rawText: text, finishReason: 'stop' })
    expect(r.status).toBe('complete')
    expect(r.content).toContain('<thought>我得留意窗外的动静。</thought>')
  })

  it('供应商 thinking 被丢弃，但角色 thought 保留', () => {
    const text = `<thinking>先分析规则和上下文</thinking><thought>我得谨慎回答。</thought>\n\n${LONG_COMPLETE}`
    const r = finalizeAssistantOutput({ rawText: text, finishReason: 'stop' })
    expect(r.content).not.toContain('先分析规则和上下文')
    expect(r.content).toContain('<thought>我得谨慎回答。</thought>')
  })
})

describe('finalizeAssistantOutput：残缺回退（方案 §5.2 步骤 6–7）', () => {
  it('length + 悬空半句 → 回退到最后完整句（recovered + trimmed_to_boundary）', () => {
    const raw = `${LONG_COMPLETE}然后她伸手去拿桌上的杯子，却`
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.status).toBe('recovered')
    expect(r.notice).toBe('trimmed_to_boundary')
    expect(r.content).toBe(LONG_COMPLETE)
    expect(r.content).not.toContain('伸手')
    expect(r.brokenTail).toBe('然后她伸手去拿桌上的杯子，却')
  })

  it('未闭合中文引号不进入最终正文', () => {
    const raw = `${LONG_COMPLETE}她说：“这把钥匙打不开这扇门，你别`
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.status).toBe('recovered')
    expect(r.content).toBe(LONG_COMPLETE)
    expect(r.content).not.toContain('“这把钥匙')
    expect(r.diagnostics.balancedQuotes).toBe(true)
  })

  it('未闭合星号不进入最终正文', () => {
    const raw = `${LONG_COMPLETE}\n\n*她转身走向走廊深处`
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.content).toBe(LONG_COMPLETE)
    expect(r.diagnostics.balancedMarkup).toBe(true)
  })

  it('未闭合 <thought> 块整段丢弃（残缺思考不进入正文）', () => {
    const raw = `${LONG_COMPLETE}\n\n<thought>她开始盘算接下来的计划，先`
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    // 剩余正文本身完整收束 → 直接接受
    expect(r.status).toBe('complete')
    expect(r.content).toBe(LONG_COMPLETE)
    expect(r.content).not.toContain('<thought>')
  })

  it('stop + 结构残缺同样回退（旧样式/异常输出）', () => {
    const raw = `${LONG_COMPLETE}她突然停住，因为`
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'stop' })
    expect(r.status).toBe('recovered')
    expect(r.content).toBe(LONG_COMPLETE)
  })
})

describe('finalizeAssistantOutput：一次短补尾判定（方案 §5.2 步骤 8–9）', () => {
  it('稳定正文过短 → needs_tail_repair + repairContext 携带末段', () => {
    const raw = '门开了。她看见'
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.status).toBe('needs_tail_repair')
    expect(r.content).toBe('门开了。')
    expect(r.repairContext).toBe('门开了。她看见')
  })

  it('整段无稳定边界 → needs_tail_repair 且正文为空（不落盘半句）', () => {
    const raw = '这是一段完全没有句末标点的流水叙述文字一直写到输出上限被截断'
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.status).toBe('needs_tail_repair')
    expect(r.content).toBe('')
    expect(r.repairContext).toBe(raw)
  })

  it('空文本 → failed（无正文按错误处理）', () => {
    const r = finalizeAssistantOutput({ rawText: '', finishReason: 'stop' })
    expect(r.status).toBe('failed')
    expect(r.content).toBe('')
  })

  it('buildRepairContext 只取最后 1–2 段', () => {
    const raw = `第一段背景。\n\n第二段铺垫。\n\n${LONG_COMPLETE}她说`
    expect(buildRepairContext(raw)).not.toContain('第一段背景')
    expect(buildRepairContext(raw)).toContain('第二段铺垫')
    expect(buildRepairContext(raw)).toContain('她说')
  })

  it('buildRepairContext 超过 600 字符时从尾部截断', () => {
    const longPara = '长'.repeat(700)
    const raw = `开头一段。\n\n${longPara}`
    const ctx = buildRepairContext(raw)
    expect(ctx.length).toBe(600)
    expect(ctx).not.toContain('开头一段')
  })

  it('正文只有未闭合 <thought> → needs_tail_repair（无可用正文）', () => {
    const raw = '<thought>她开始盘算接下来的计划，写到一半被截'
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.status).toBe('needs_tail_repair')
    expect(r.content).toBe('')
    expect(r.brokenTail).toBe(raw)
    expect(r.repairContext).toBe(raw)
  })

  it('短前缀 + 网络中断 → needs_tail_repair 且提示 partial_network_output', () => {
    const r = finalizeAssistantOutput({ rawText: '门开了。她看见', finishReason: 'network_error' })
    expect(r.status).toBe('needs_tail_repair')
    expect(r.notice).toBe('partial_network_output')
    expect(r.content).toBe('门开了。')
  })

  it('回退循环跳过不平衡的更长候选，落到平衡的稳定句界', () => {
    // 最长候选（含未闭合引号）被平衡性检查拒绝，回退到引号之前的 30 字稳定句界
    // 未闭合引号出现在最后一个句界之前：最长候选（含未闭合引号）被拒绝，回退到 30 字稳定句界
    const raw = '夜色深沉，她推开门，走进房间，环顾四周陌生的陈设，心里一沉。她说：“没说完的话还卡在那里。雨还在'
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.status).toBe('recovered')
    expect(r.content).toBe('夜色深沉，她推开门，走进房间，环顾四周陌生的陈设，心里一沉。')
    expect(r.diagnostics.balancedQuotes).toBe(true)
  })

  it('段落候选非稳定句尾被跳过（全文以逗号收尾）→ 无稳定边界', () => {
    const raw = '很长很长的第一段内容一直写到以逗号收尾，后面实在没有别的句子了，就这样'
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.status).toBe('needs_tail_repair')
    expect(r.content).toBe('')
    expect(r.brokenTail).toBe(raw)
  })

  it('正文只有未闭合 <thought>（网络中断）→ 提示 partial_network_output', () => {
    const raw = '<thought>只写了一半的心理活动'
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'network_error' })
    expect(r.status).toBe('needs_tail_repair')
    expect(r.notice).toBe('partial_network_output')
  })

  it('直角引号收尾：isCompleteSentence 兜底候选被接受', () => {
    // STABLE_TAIL 不认直角引号，但剥离后以句末标点收尾 → 文本整体作为候选
    const r = finalizeAssistantOutput({ rawText: `${LONG_COMPLETE}他说完之后便离开了。" `, finishReason: 'length' })
    // 整体结构完整（直角引号剥离后为完整句）→ 直接接受
    expect(r.status).toBe('complete')
    expect(r.content).toContain('他说完之后便离开了。')
  })

  it('回退循环跳过星号不平衡的候选（balancedMarkup 检查）', () => {
    const raw = '雨停了。她带着伞走出了门，沿着湿漉漉的街道慢慢往回走。*她忽然停住'
    const r = finalizeAssistantOutput({ rawText: raw, finishReason: 'length' })
    expect(r.status).toBe('recovered')
    expect(r.content).toBe('雨停了。她带着伞走出了门，沿着湿漉漉的街道慢慢往回走。')
    expect(r.diagnostics.balancedMarkup).toBe(true)
  })

  it('rawText 缺省（undefined）→ failed', () => {
    const r = finalizeAssistantOutput({ rawText: undefined as never, finishReason: 'stop' })
    expect(r.status).toBe('failed')
  })

  it('句末紧跟闭合星号：STABLE_TAIL 通过但完整句判定为假 → 走回退', () => {
    const r = finalizeAssistantOutput({ rawText: '雨停了。*她停住了。*', finishReason: 'length' })
    // 整体完整句判定为假 → 回退；唯一候选 10 字 < 24 → 补尾（content 为该候选）
    expect(r.status).toBe('needs_tail_repair')
    expect(r.content).toBe('雨停了。*她停住了。*')
  })

  it('全文无句末标点且段落候选以逗号收尾 → 无稳定边界', () => {
    const r = finalizeAssistantOutput({
      rawText: '夜色很深了，她还在路上，雨一直没有停，伞也坏了，\n\n她加快脚步往回走，心里想着明天的事',
      finishReason: 'length',
    })
    expect(r.status).toBe('needs_tail_repair')
    expect(r.content).toBe('')
  })

  it('空前缀 + 补尾复检仍失败 → failed', () => {
    const emptyFinalized = finalizeAssistantOutput({ rawText: '完全没有标点的流水叙述一直写到输出被截断', finishReason: 'length' })
    const merged = mergeTailRepair({ finalized: emptyFinalized, repairText: '窗外的雨', trimOverlap: (_p, n) => n })
    expect(merged.status).toBe('failed')
  })

  it('tool_calls 结束且结构完整 → complete（哨兵清理）', () => {
    const r = finalizeAssistantOutput({ rawText: `${LONG_COMPLETE}[TOOL_CALL:{"id":"1"}]`, finishReason: 'tool_calls' })
    expect(r.status).toBe('complete')
    expect(r.content).toBe(LONG_COMPLETE)
  })
})

describe('mergeTailRepair：补尾合并与失败回退', () => {
  const finalized = finalizeAssistantOutput({ rawText: '门开了。她看见', finishReason: 'length' })
  const identity = (_prev: string, next: string) => next

  it('补尾成功：合并后完整 → tail_repaired', () => {
    const merged = mergeTailRepair({
      finalized,
      repairText: '看见窗外的雨停了，她松了一口气。',
      trimOverlap: identity,
    })
    expect(merged.status).toBe('complete')
    expect(merged.notice).toBe('tail_repaired')
    expect(merged.content).toBe('门开了。看见窗外的雨停了，她松了一口气。')
  })

  it('补尾复述了前缀末尾时通过 trimOverlap 去重', () => {
    const merged = mergeTailRepair({
      finalized,
      // 模型复述了"她看见"三个字
      repairText: '她看见窗外的雨停了。',
      trimOverlap: (prev, next) => next.startsWith('她看见') && prev.endsWith('她看见') ? next.slice(3) : next,
    })
    expect(merged.content).toBe('门开了。她看见窗外的雨停了。')
    expect(merged.content).not.toBe('门开了。她看见她看见窗外的雨停了。')
  })

  it('补尾文本仍残缺 → 回退稳定前缀（补尾失败不落盘半句）', () => {
    const merged = mergeTailRepair({
      finalized,
      repairText: '窗外的雨',
      trimOverlap: identity,
    })
    expect(merged.status).toBe('recovered')
    expect(merged.notice).toBeUndefined()
    expect(merged.content).toBe('门开了。')
  })

  it('补尾返回空文本 → 保留前缀', () => {
    const merged = mergeTailRepair({ finalized, repairText: '  ', trimOverlap: identity })
    expect(merged.content).toBe('门开了。')
    expect(merged.status).toBe('recovered')
  })

  it('补尾复检携带 finishReason=length 口径', () => {
    const merged = mergeTailRepair({
      finalized,
      repairText: '看见窗外的雨停了。',
      trimOverlap: identity,
      finishReason: 'length',
    })
    expect(merged.status).toBe('complete')
    expect(merged.notice).toBe('tail_repaired')
  })

  it('无稳定边界的前缀（content 为空）补尾为空 → failed', () => {
    const emptyFinalized = finalizeAssistantOutput({ rawText: '完全没有标点的流水叙述一直写到输出被截断', finishReason: 'length' })
    expect(emptyFinalized.content).toBe('')
    const merged = mergeTailRepair({ finalized: emptyFinalized, repairText: '   ', trimOverlap: identity })
    expect(merged.status).toBe('failed')
  })

  it('无稳定边界的前缀补尾成功 → 从空内容恢复为完整正文', () => {
    const emptyFinalized = finalizeAssistantOutput({ rawText: '完全没有标点的流水叙述一直写到输出被截断', finishReason: 'length' })
    const merged = mergeTailRepair({ finalized: emptyFinalized, repairText: '后来雨停了，她把窗关上了。', trimOverlap: identity })
    expect(merged.status).toBe('complete')
    expect(merged.content).toBe('后来雨停了，她把窗关上了。')
  })

  it('补尾合并后仍不完整但回退不短于前缀 → recovered 且标记 tail_repaired', () => {
    const longFinalized = finalizeAssistantOutput({ rawText: `${LONG_COMPLETE}然后她伸手拿`, finishReason: 'length' })
    expect(longFinalized.status).toBe('recovered')
    const merged = mergeTailRepair({
      finalized: longFinalized,
      // 补尾仍未写出句末标点：复检回退到前缀（36 字 ≥ 24，走 recovered 分支）
      repairText: '然后她伸手拿住了门把手',
      trimOverlap: identity,
    })
    expect(merged.status).toBe('recovered')
    expect(merged.notice).toBe('tail_repaired')
    expect(merged.content).toBe(LONG_COMPLETE)
  })

  it('无稳定边界（整段无句末标点）+ 网络中断 → 提示 partial_network_output', () => {
    const r = finalizeAssistantOutput({
      rawText: '完全没有标点的流水叙述一直写到输出被截断',
      finishReason: 'network_error',
    })
    expect(r.status).toBe('needs_tail_repair')
    expect(r.notice).toBe('partial_network_output')
  })
})
