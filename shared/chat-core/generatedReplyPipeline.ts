/**
 * 生成回复统一收尾管线（S1：收尾一致性）。
 *
 * 唯一的处理顺序（方案「阶段0-6与thought修复后剩余问题」S1）：
 *   1. 供应商推理残留清理；2. output 正则；3. 停止字符串；4. 收尾器；
 *   5. 必要时一次短补尾；6. 续写重叠去重（由续写入口自行执行）。
 *
 * 桌面单聊、消息续写、群聊（点名/轮询/自由发言）与 Bridge 都必须经过本入口，
 * 不允许各 store 自行决定正则与收尾器的先后——否则正则可能在结构检查之后
 * 再次破坏正文（重新制造半句/未闭合格式）。
 *
 * 本模块不依赖 window.*（可在主进程 Bridge 中复用）：
 * - 正则规则由调用方传入；
 * - 短补尾由调用方注入执行器（渲染层 attemptTailRepair / Bridge chatWithRetry）。
 */

import { finalizeAssistantOutput, type FinalizedAssistantOutput, type FinalizedStatus } from '../assistantOutputFinalizer'
import type { AIFinishReason, GenerationTerminalResult, GenerationTerminationCause, RegexRule } from '../types'
import { stripVendorThinking } from '../thoughtMarkup'
import { applyOutputRegexRules, collectStopStrings, truncateAtStop } from './regex'
import {
  contentFilterPreservesBody,
  effectiveFinishReasonForCause,
  terminationPromptWithContent,
  terminationPromptWithoutContent,
} from '../generationTermination'

export interface GeneratedReplyPipelineOptions {
  rawText: string
  finishReason: AIFinishReason
  /** output 正则规则（调用方各自获取：渲染层 window.api.regex.list() / Bridge buildData） */
  regexRules: RegexRule[]
  characterName: string
  /**
   * 一次短补尾执行器：渲染层注入 attemptTailRepair，Bridge 注入 chatWithRetry 实现。
   * 仅在收尾器判定 needs_tail_repair 且本轮未补尾时调用一次；缺省 = 不补尾。
   */
  runTailRepair?: (finalized: FinalizedAssistantOutput) => Promise<string | null>
  /**
   * 阶段7（§4.1 矩阵"正常 stop → 保存完整正文"）：供应商明确 stop/tool_calls 收尾时，
   * 即使正文缺句末标点（收尾器找不到稳定边界），也不发起补尾请求、更不整条丢弃——
   * 模型宣告结束时"无标点"只是风格问题，不是截断；数据丢失比缺标点更严重。
   */
  allowEmptyTailPassthrough?: boolean
}

export interface GeneratedReplyOutcome {
  content: string
  status: FinalizedStatus | 'raw'
  notice?: 'trimmed_to_boundary' | 'tail_repaired' | 'partial_network_output'
  repairFailed?: boolean
}

/**
 * 统一收尾管线。返回最终可保存正文与收尾状态；
 * 无可用正文时 content 为空串（调用方按各自占位/错误分支处理）。
 */
export async function runGeneratedReplyPipeline(opts: GeneratedReplyPipelineOptions): Promise<GeneratedReplyOutcome> {
  // 1. 供应商推理残留清理（<thinking> 归一化等）
  let text = stripVendorThinking(opts.rawText ?? '').trim()

  // 2. output 正则（两阶段 text + markdown）与 3. 停止字符串——先于收尾器执行，
  //    保证收尾器的结构检查针对最终落盘口径；每条消息只执行一次。
  if (opts.regexRules.length > 0) {
    text = applyOutputRegexRules(text, opts.regexRules)
    text = truncateAtStop(text, collectStopStrings(opts.regexRules)).text
  }

  // 4. 收尾器（完整性检查 + 稳定边界回退）
  const finalized = finalizeAssistantOutput({
    rawText: text,
    finishReason: opts.finishReason,
    characterName: opts.characterName,
  })

  // 5. 必要时一次短补尾。无稳定边界时收尾器会返回空正文 + brokenTail，
  //    补尾执行器以 repairContext 为输入续写（补尾失败时不保存半句）。
  if (finalized.status === 'needs_tail_repair' && opts.runTailRepair) {
    const repaired = await opts.runTailRepair(finalized)
    if (repaired) {
      return { content: repaired, status: 'recovered', notice: 'tail_repaired' }
    }
    if (finalized.content) {
      return { content: finalized.content, status: 'recovered', repairFailed: true }
    }
    return { content: '', status: 'failed', repairFailed: true }
  }

  // 阶段7（§4.1）：stop/tool_calls 明确结束但找不到稳定边界时，不补尾也不整条丢弃——
  // 保存正则处理后的正文（正则只执行过一次，此处不做任何额外改写）。
  if (finalized.status === 'needs_tail_repair' && !finalized.content
    && opts.allowEmptyTailPassthrough && text.trim()) {
    return { content: text.trim(), status: 'recovered' }
  }

  if (finalized.status === 'failed' || !finalized.content) {
    return { content: '', status: 'failed' }
  }

  return {
    content: finalized.content,
    status: finalized.status,
    notice: finalized.notice,
  }
}

// ===================== 阶段7：统一异常终止协调入口（方案 §4.2） =====================

/**
 * 终止协调结果：调用方（store / Bridge）唯一可落盘依据。
 * - persistable=false 时不得保存 AI 消息（不创建空消息，错误只进 store.error/提示字段）；
 * - noticeFields 只写 generationNotice/generationError，绝不拼入 content。
 */
export interface GenerationTerminalOutcome {
  content: string
  status: FinalizedStatus | 'raw' | 'empty'
  /** 是否允许落盘部分正文（行为矩阵 §4.1） */
  persistable: boolean
  terminationCause: GenerationTerminationCause
  noticeFields: { generationNotice?: string; generationError?: string }
  /** 收尾提示（provider_length 路径）：与 finalizeNoticeFields 输入同集 */
  notice?: 'trimmed_to_boundary' | 'tail_repaired' | 'partial_network_output'
  repairFailed?: boolean
}

export interface GenerationTerminalCoordination {
  terminalResult: GenerationTerminalResult
  regexRules: RegexRule[]
  characterName: string
  /** 自动补尾执行器：协调入口按 §8.1 自行决定何时调用（仅 provider_length） */
  runTailRepair?: (finalized: FinalizedAssistantOutput) => Promise<string | null>
}

/**
 * 统一终止协调入口：按 terminationCause 决定是否保存部分正文、是否允许补尾，
 * 生成 generationNotice/generationError，并把正文收束交给唯一共享管线。
 * 桌面单聊、群聊、Bridge、重生成、续写都只消费该函数返回值，不再自己拼装异常正文。
 */
export async function finalizeGenerationTerminalResult(
  input: GenerationTerminalCoordination,
): Promise<GenerationTerminalOutcome> {
  const { terminalResult, regexRules, characterName } = input
  const cause = terminalResult.terminationCause
  const rawText = terminalResult.rawText ?? ''

  // 用户取消：保留用户已经看到的正文，不收尾、不补尾（矩阵 §4.1）
  if (cause === 'user_cancel') {
    const content = rawText.trim()
    return {
      content,
      status: content ? 'raw' : 'empty',
      persistable: !!content,
      terminationCause: cause,
      noticeFields: content ? { generationNotice: '已停止生成' } : {},
    }
  }

  // 审核拦截：整条回复不可信，按审核策略丢弃正文，只给明确审核提示，不做补尾
  if (cause === 'provider_content_filter' && !contentFilterPreservesBody()) {
    return {
      content: '',
      status: 'empty',
      persistable: false,
      terminationCause: cause,
      noticeFields: { generationError: terminationPromptWithoutContent(cause, terminalResult.errorMessage) },
    }
  }

  // 其余情况：先走唯一共享管线（推理清理 → 正则 → 停止字符串 → 收尾器）。
  // 自动补尾限制（§8.1）：只有 provider_length 且稳定正文不足时允许，每条消息最多一次；
  // transport/timeout/protocol/cancel/filter 一律不补尾。
  const finishReason = effectiveFinishReasonForCause(cause, terminalResult.finishReason)
  const mayRepair = cause === 'provider_length' && !!input.runTailRepair
  const outcome = await runGeneratedReplyPipeline({
    rawText,
    finishReason,
    regexRules,
    characterName,
    runTailRepair: mayRepair ? input.runTailRepair : undefined,
    // 矩阵 §4.1：正常 stop / tool_calls 的保存结果是"完整正文"，不整条丢弃
    allowEmptyTailPassthrough: cause === 'provider_stop' || cause === 'provider_tool_calls',
  })

  if (!outcome.content) {
    // 任意异常且无可用正文：不创建空 AI 消息（矩阵末行）
    return {
      content: '',
      status: 'empty',
      persistable: false,
      terminationCause: cause,
      noticeFields: { generationError: terminationPromptWithoutContent(cause, terminalResult.errorMessage) },
    }
  }

  const noticeFields: GenerationTerminalOutcome['noticeFields'] = {}
  const prompt = terminationPromptWithContent(cause)
  if (prompt) noticeFields[prompt.field] = prompt.text
  // provider_length 的轻提示由收尾器 notice 决定（已在完整句处收束/已自动补全结尾），
  // 与异常类提示互斥：异常类优先展示 generationError。
  if (!prompt && cause === 'provider_length') {
    if (outcome.notice === 'trimmed_to_boundary') noticeFields.generationNotice = '内容已在完整句处收束'
    if (outcome.notice === 'tail_repaired') noticeFields.generationNotice = '已自动补全结尾'
    if (outcome.repairFailed) {
      delete noticeFields.generationNotice
      noticeFields.generationError = '生成中断，已保留完整部分'
    }
  }

  return {
    content: outcome.content,
    status: outcome.status,
    persistable: true,
    terminationCause: cause,
    noticeFields,
    notice: outcome.notice,
    repairFailed: outcome.repairFailed,
  }
}
