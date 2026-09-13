/**
 * thought 语义架构契约（阶段7 方案 §5.1/§5.2）——共享提示唯一来源。
 *
 * 契约：`<thought>...</thought>` 只表示消息所属角色在当前情境中的内心活动，
 * 不表示模型的推理过程。桌面单聊、全局叙事与群聊必须从这里生成提示正文，
 * 防止三处文案漂移。
 *
 * 必须满足：
 * - 使用当前角色第一人称"我"；
 * - 内容只包含角色能知道、感受到、怀疑或打算的事情；
 * - 不得出现"模型、用户指令、系统提示、规则、上下文、下一步生成"等元信息；
 * - 不得复述分析过程或解释为什么这样写；
 * - 正文使用全局第三人称叙事时，thought 仍属于焦点角色并保持第一人称；
 * - 群聊中 thought 归属于当前消息的 speaker（subjectName 注入发言角色），
 *   不使用群组或旁白作为思考主体；
 * - 每条角色回复必须且只能输出一个简短 thought 块。
 *
 * 双通道隔离（§5.2）：供应商 reasoning/thinking 永不进入正文与 thought；
 * 角色 thought 保留在正文中按 thought 样式显示，默认不进入 TTS。
 */

import type { NarrativeMode } from './types'

/** 契约要点（测试断言用；与提示文案同源维护） */
export const THOUGHT_CONTRACT_CLAUSES = [
  '第一人称',
  '不超过 3 句',
  '不得包含模型推理',
  '写作计划',
  '规则分析',
  '上下文复述',
  '标签外',
] as const

export interface ThoughtContractInput {
  narrativeMode: NarrativeMode
  /**
   * 思考主体的展示名（含书名号等修饰由调用方决定）。
   * 全局叙事：焦点角色/speaker；沉浸模式：回应角色/speaker。缺省 = 通用措辞。
   */
  subjectName?: string
}

/**
 * 生成 thought 契约提示正文（不含界面层的【输出格式…】抬头与换行包装）。
 * 单聊、全局叙事与群聊共用本函数，保证三端与两模式语义一致。
 */
export function buildThoughtContractBody(input: ThoughtContractInput): string {
  const name = input.subjectName ?? ''
  if (input.narrativeMode === 'omniscient') {
    const subject = name || '当前对话角色'
    return `正文仍保持第三人称叙事。每轮必须输出且只输出一组 <thought>...</thought>，它仅表示当前焦点角色${subject}的第一人称内心独白，必须切换到 ${subject} 自己的“我”来思考（禁止用旁白/第三人称“他/她”写这段心理），保持简短且不超过 3 句；不得包含模型推理、写作计划、规则分析、上下文复述或正文草稿。不要一次泄露所有人物的隐私想法。完整的实际叙事必须放在标签外。`
  }
  const self = name || '该角色'
  return `每轮必须输出且只输出一组 <thought>...</thought>，它仅表示当前回应角色的第一人称私密内心独白，必须使用 ${self} 自己的“我”来思考（禁止用旁白/第三人称“他/她”写这段心理），保持简短且不超过 3 句；不得包含模型推理、写作计划、规则分析、上下文复述或正文草稿。完整的实际对话和行动必须放在标签外。`
}
