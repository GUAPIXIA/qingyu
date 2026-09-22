/**
 * 阶段 6 S6-01：free（AI 自选）模式多角色回复的拆分与归属——**跨端共享的纯逻辑**。
 *
 * 为什么必须共享：free 模式一次生成返回多角色发言，按「【角色名】」标记拆分成
 * 多条消息。拆分规则（旁白并入首段、未识别角色旁注归属、空段丢弃、无标记回落
 * 首成员）直接决定**消息条数与角色归属**；两端不一致会让同一段群聊在两端拥有
 * 不同的消息序列，影响导出、记忆摘要、上下文与同步。
 *
 * oracle 消费方：PC `src/store/groupStreamController.ts` 的 `splitAndSaveMessages`。
 *
 * 语义钉子（历史行为，禁止"顺手修复"）：
 * - omniscient（全知叙事）**不拆分**：整条作为单一成员回应，避免【判定】/【可选行动】
 *   被分段器误识别；
 * - 首个标记之前的旁白并入首段（`\n\n` 连接，空部��丢弃）；
 * - 未识别角色名的内容旁注为「⚠️ 未识别角色「名」: 内容」：若上一条归属**首成员**则并入，
 *   否则新建一条首成员消息；识别到但正文为空的段直接丢弃（无旁注）。
 */

export interface FreeSplitMember {
  id: string
  name: string
}

export interface FreeSplitMessage {
  characterId: string
  content: string
}

export interface FreeSplitResult {
  /** narrator=全知叙事单条；segments=按【角色名】拆分；fallback=无任何标记回落首成员 */
  kind: 'narrator' | 'segments' | 'fallback'
  messages: FreeSplitMessage[]
}

/** 拆分后无正文时的占位文本（与 PC 一致）。 */
export const FREE_SPLIT_EMPTY_CONTENT = '(无回复)'

const UNRECOGNIZED_PREFIX = '⚠️ 未识别角色「'

export function splitFreeReply(input: {
  content: string
  members: readonly FreeSplitMember[]
  narrativeMode?: string | null
}): FreeSplitResult {
  const { content, members } = input

  // 全知叙事：保留为单条实际成员回应（无成员时归属 __narrator__）
  if (input.narrativeMode === 'omniscient') {
    return {
      kind: 'narrator',
      messages: [{
        characterId: members[0]?.id ?? '__narrator__',
        content: content || FREE_SPLIT_EMPTY_CONTENT,
      }],
    }
  }

  // 按 【角色名】 拆段（非贪婪；段内容=本标记与下一标记之间的文本）
  const pattern = /【(.+?)】/g
  const segments: { name: string; content: string }[] = []
  let lastIdx = 0
  let preamble = ''
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const textBefore = content.slice(lastIdx, match.index).trim()
    if (segments.length === 0) {
      // 首个标记前的旁白先暂存，段数组收尾时并入首段（避免被后续迭代覆盖）
      preamble = textBefore
      segments.push({ name: match[1], content: '' })
    } else {
      segments[segments.length - 1].content = textBefore
      segments.push({ name: match[1], content: '' })
    }
    lastIdx = match.index + match[0].length
  }
  if (segments.length > 0) {
    segments[segments.length - 1].content = content.slice(lastIdx).trim()
    if (preamble) {
      segments[0].content = [preamble, segments[0].content].filter(Boolean).join('\n\n')
    }
  }

  if (segments.length === 0) {
    // 没有任何角色标记 → 回落首成员，避免渲染为不可见消息
    return {
      kind: 'fallback',
      messages: [{
        characterId: members[0]?.id ?? '__free__',
        content: content || FREE_SPLIT_EMPTY_CONTENT,
      }],
    }
  }

  const messages: FreeSplitMessage[] = []
  for (const seg of segments) {
    // 大小写不敏感 + 去除空格 进行角色名匹配
    const segName = seg.name.toLowerCase().trim()
    const char = members.find((c) => c.name.toLowerCase().trim() === segName)
    if (!char || !seg.content) {
      // 未识别角色：旁注归属首成员（上一条已是首成员则并入，否则新建）
      if (seg.content && members.length > 0) {
        const note = UNRECOGNIZED_PREFIX + seg.name + '」: ' + seg.content
        const fallbackSeg = messages.length > 0 ? messages[messages.length - 1] : null
        if (fallbackSeg && fallbackSeg.characterId === members[0].id) {
          fallbackSeg.content += '\n\n' + note
        } else {
          messages.push({ characterId: members[0].id, content: note })
        }
      }
      continue
    }
    messages.push({ characterId: char.id, content: seg.content })
  }
  return { kind: 'segments', messages }
}
