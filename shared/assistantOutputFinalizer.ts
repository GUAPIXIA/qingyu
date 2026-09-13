/**
 * 统一正文收尾器（阶段3「结构化完成事件与统一收尾」§5.2）。
 *
 * 纯函数，供桌面单聊与后续 Bridge/群聊共用：
 * - stop 且结构完整 → 正常接受；
 * - length 但正文已在完整句/段结束 → 直接接受，不提示错误；
 * - 尾部残缺 → 回退到最后一个稳定句界/段界，删除悬空半句与未闭合标记；
 * - 稳定正文足够 → recovered（轻提示"已在完整句处收束"）；
 * - 稳定正文过短或无稳定边界 → needs_tail_repair（由调用方发起一次短补尾）。
 *
 * 绝不把半个标签或半句返回为可保存正文；输出正则/停止字符串由调用方管线处理，
 * 本模块只负责内容完整性与边界（补尾成功后的复检也走本模块）。
 */

import type { AIFinishReason, ResponsePolicy } from './types'
import { analyzeTextClosure, countVisibleCharacters, isCompleteSentence } from './textMetrics'
import { stripVendorThinking } from './thoughtMarkup'

export type FinalizedStatus = 'complete' | 'recovered' | 'needs_tail_repair' | 'failed'

export type FinalizedNotice = 'trimmed_to_boundary' | 'tail_repaired' | 'partial_network_output'

export interface FinalizerDiagnostics {
  completeSentence: boolean
  balancedQuotes: boolean
  balancedMarkup: boolean
  visibleChars: number
}

export interface FinalizedAssistantOutput {
  content: string
  status: FinalizedStatus
  notice?: FinalizedNotice
  /** needs_tail_repair 时给补尾请求的上下文：最后 1–2 个段落 + 残缺尾句 */
  repairContext?: string
  /** 稳定边界之后被回退掉的残缺尾段（合并补尾结果时做重叠去重参考） */
  brokenTail?: string
  diagnostics: FinalizerDiagnostics
}

export interface FinalizeAssistantOutputInput {
  rawText: string
  finishReason: AIFinishReason
  responsePolicy?: ResponsePolicy
  narrativeMode?: 'immersive' | 'omniscient'
  characterName?: string
}

/** 供应商推理标记 / 空标签清理：保留有效的 <thought> 块（心理描写是业务特性） */
function stripVendorResidue(text: string): string {
  return stripVendorThinking(text)
    // 空思考标签与空的成对标记
    .replace(/<thought>\s*<\/thought>/gi, '')
    // 供应商残留的流式哨兵
    .replace(/\[TOOL_CALL:[\s\S]*\]\s*$/, '')
    .trim()
}

/** 找到最后一个未闭合 <thought> 的开标签位置；无未闭合块时返回 -1 */
function findUnclosedThoughtStart(text: string): number {
  const opens = [...text.matchAll(/<thought[\s>]/gi)]
  for (let i = opens.length - 1; i >= 0; i--) {
    const openIndex = opens[i].index ?? -1
    const afterOpen = text.slice(openIndex)
    if (!/<\/thought>/i.test(afterOpen)) return openIndex
  }
  return -1
}

/** 稳定句尾：句末标点 + 可选的收尾引号/星号/书名号 */
const STABLE_TAIL = /[。！？…][”’」』）)】》*]*\s*$/

/** 稳定边界候选：从长到短尝试的切点（段落界与句界） */
function collectBoundaryCandidates(text: string): number[] {
  const candidates = new Set<number>()
  // 段落边界：空行之前为界（保留含换行的完整段）
  for (const match of text.matchAll(/\n\s*\n/g)) {
    if ((match.index ?? 0) > 0) candidates.add(match.index ?? 0)
  }
  // 句界：句末标点（含尾随引号/星号）之后
  for (const match of text.matchAll(/[。！？…][”’」』）)】》*]*/g)) {
    const end = (match.index ?? 0) + match[0].length
    if (end > 0 && end < text.length) candidates.add(end)
  }
  // 文本本身是稳定句尾
  if (STABLE_TAIL.test(text) || isCompleteSentence(text)) candidates.add(text.length)
  return [...candidates].sort((a, b) => b - a)
}

/** 组装诊断信息 */
function buildDiagnostics(content: string): FinalizerDiagnostics {
  const closure = analyzeTextClosure(content)
  return {
    completeSentence: content.trim() ? isCompleteSentence(content) : false,
    balancedQuotes: closure.balancedQuotes,
    balancedMarkup: closure.balancedAsterisks && closure.closedThought,
    visibleChars: countVisibleCharacters(content),
  }
}

/** 补尾上下文：最后 1–2 个段落 + 残缺尾句（上限 600 字符） */
export function buildRepairContext(rawText: string): string {
  const paragraphs = rawText.split(/\n\s*\n/).filter((p) => p.trim())
  const tail = paragraphs.slice(-2).join('\n\n').trim()
  if (tail.length <= 600) return tail
  return tail.slice(tail.length - 600)
}

/** 稳定正文可独立保存的最小可见字符数（低于此值进入一次短补尾） */
const MIN_KEEP_VISIBLE_CHARS = 24

/**
 * 收尾主流程（方案 §5.2 处理顺序 3–9）。
 */
export function finalizeAssistantOutput(input: FinalizeAssistantOutputInput): FinalizedAssistantOutput {
  const raw = stripVendorResidue(input.rawText ?? '')
  const finishReason = input.finishReason

  if (!raw) {
    return {
      content: '',
      status: 'failed',
      diagnostics: buildDiagnostics(''),
    }
  }

  // 未闭合的 <thought>：回退到该块之前（残缺思考块不进入正文）
  let workingText = raw
  const unclosedThought = findUnclosedThoughtStart(workingText)
  if (unclosedThought >= 0) {
    workingText = workingText.slice(0, unclosedThought).trimEnd()
  }
  if (!workingText) {
    return {
      content: '',
      status: 'needs_tail_repair',
      notice: finishReason === 'network_error' ? 'partial_network_output' : undefined,
      repairContext: buildRepairContext(raw),
      brokenTail: raw,
      diagnostics: buildDiagnostics(''),
    }
  }

  const fullDiagnostics = buildDiagnostics(workingText)
  const structurallyClean = fullDiagnostics.balancedQuotes && fullDiagnostics.balancedMarkup

  // stop / length 且结构完整、完整句收尾 → 直接接受（length 恰好完整不提示错误）
  if (structurallyClean && fullDiagnostics.completeSentence
    && (finishReason === 'stop' || finishReason === 'length' || finishReason === 'tool_calls')) {
    return {
      content: workingText,
      status: 'complete',
      diagnostics: fullDiagnostics,
    }
  }
  // 网络中断但恰好完整收束 → 接受并提示
  if (structurallyClean && fullDiagnostics.completeSentence && finishReason === 'network_error') {
    return {
      content: workingText,
      status: 'complete',
      notice: 'partial_network_output',
      diagnostics: fullDiagnostics,
    }
  }

  // 尾部残缺：从长到短寻找"结构闭合 + 稳定句尾"的切点
  for (const cut of collectBoundaryCandidates(workingText)) {
    let candidate = workingText.slice(0, cut).trimEnd()
    if (!candidate) continue
    // 悬空的尾部星号属于未闭合展示标记（方案 §5.2 步骤 6）：删除后重查，
    // 避免句末被句界正则连同尾部星号一起纳入候选导致整段降级为补尾
    const asteriskCount = candidate.split('*').length - 1
    if (asteriskCount % 2 === 1 && candidate.endsWith('*')) {
      candidate = candidate.slice(0, -1).trimEnd()
    }
    const diagnostics = buildDiagnostics(candidate)
    if (!(diagnostics.balancedQuotes && diagnostics.balancedMarkup)) continue
    if (!STABLE_TAIL.test(candidate)) continue

    const brokenTail = workingText.slice(cut).trim()
    if (diagnostics.visibleChars < MIN_KEEP_VISIBLE_CHARS) {
      // 稳定正文过短 → 一次短补尾（方案 §5.2 步骤 8）
      return {
        content: candidate,
        status: 'needs_tail_repair',
        notice: finishReason === 'network_error' ? 'partial_network_output' : undefined,
        repairContext: buildRepairContext(raw),
        brokenTail,
        diagnostics,
      }
    }
    // 稳定正文足够表达本轮内容 → recovered（步骤 7）
    return {
      content: candidate,
      status: 'recovered',
      notice: 'trimmed_to_boundary',
      brokenTail,
      diagnostics,
    }
  }

  // 没有任何稳定边界（整段无句末标点）→ 一次短补尾（步骤 8）
  return {
    content: '',
    status: 'needs_tail_repair',
    notice: finishReason === 'network_error' ? 'partial_network_output' : undefined,
    repairContext: buildRepairContext(raw),
    brokenTail: workingText,
    diagnostics: buildDiagnostics(''),
  }
}

/**
 * 补尾结果合并（方案 §5.3）：稳定前缀 + 补尾文本，复用调用方的重叠去重；
 * 合并后复检完整性——仍不完整或变短则回退稳定前缀（补尾失败）。
 */
export function mergeTailRepair(input: {
  finalized: FinalizedAssistantOutput
  repairText: string
  /** 与前缀末尾的重叠去重（src/utils/messagePostProcess 的 trimContinuationOverlap，渲染层注入） */
  trimOverlap: (prev: string, next: string) => string
  finishReason?: AIFinishReason
}): FinalizedAssistantOutput {
  const { finalized, repairText, trimOverlap } = input
  if (!repairText.trim()) {
    return { ...finalized, status: finalized.content ? 'recovered' : 'failed' }
  }
  const appended = trimOverlap(finalized.content, repairText.trim())
  const merged = (finalized.content + appended).trim()
  const rechecked = finalizeAssistantOutput({
    rawText: merged,
    finishReason: input.finishReason ?? 'stop',
  })
  // 合并后必须不短于稳定前缀，否则视为补尾失败（保留稳定前缀）
  if (rechecked.status === 'needs_tail_repair' || rechecked.status === 'failed'
    || rechecked.diagnostics.visibleChars < finalized.diagnostics.visibleChars) {
    return { ...finalized, status: finalized.content ? 'recovered' : 'failed' }
  }
  return {
    ...rechecked,
    status: rechecked.status === 'complete' ? 'complete' : 'recovered',
    notice: 'tail_repaired',
  }
}
