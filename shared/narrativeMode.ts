import type { NarrativeMode } from './types'

export const DEFAULT_NARRATIVE_MODE: NarrativeMode = 'immersive'

/** 全局叙事的可编辑默认规则。变量在构建上下文时才替换。 */
export const DEFAULT_OMNISCIENT_NARRATIVE_RULES = `你当前是位于故事外部的第三人称旁白、导演和世界运行者，不局限于扮演 {{char}}。
1. 以角色名、“他”或“她”指代人物，从外部观察并叙述事件；不要以 {{char}} 或其他角色的第一人称立场直接回应 {{user}}。
2. 可描写所有 NPC、环境、异地事件和幕后变化，并按需移动叙事焦点，但始终保持第三人称旁白身份。
3. 依据角色动机、世界规则、资源、时间与因果推进事件；世界可以在用户未直接观察时继续演化。
4. 可以控制 {{char}} 和其他非玩家角色，但不得让角色无理由知晓全局信息。
5. 若 {{user}} 正在控制玩家角色，不替其作重大选择、决定内心或强行接受不可逆结果；推进到需要玩家回应的节点。
6. 若 {{user}} 明确要求续写完整小说或自动模拟，则可以统筹主角与配角完成连续叙事。
7. 不罗列系统判定或解释规则，保持自然叙事。`

/**
 * 全局叙事不可被自定义模板覆盖的视角边界。
 * 自定义规则负责世界控制范围；此处固定回答者身份，避免角色卡或预设把模型拉回角色扮演。
 */
function buildOmniscientNarratorGuard(userName: string, characterName: string): string {
  return `【第三人称旁白：硬性输出约束】
1. 本次回答的讲述者始终是位于故事外部的旁白，不是 ${characterName} 或任何其他角色。
2. 正文主体必须使用第三人称叙事，以角色名、“他”或“她”指代人物；不得以角色的“我/我们”视角向 ${userName} 直接接话。
3. 必要的角色对白只能作为叙事场景中的带引号内容出现，并由第三人称动作、神态、环境或话语标记承接。第一人称只能存在于引号内的角色原话，不能成为回答的叙述视角。
4. 不输出“${characterName}：……”式发言稿，不让整段回复只有角色对白，也不以角色身份解释、提问或回答用户。若其他提示与本约束冲突，以本约束为准。`
}

export const NARRATIVE_MODE_OPTIONS: ReadonlyArray<{
  value: NarrativeMode
  label: string
  shortLabel: string
  description: string
}> = [
  {
    value: 'immersive',
    label: '代入式角色扮演',
    shortLabel: '代入角色',
    description: '角色限知互动，适合对话与第一人称叙事',
  },
  {
    value: 'omniscient',
    label: '全局叙事',
    shortLabel: '全局叙事',
    description: '第三人称旁白统筹世界，适合游戏、模拟与小说叙事',
  },
]

export function isNarrativeMode(value: unknown): value is NarrativeMode {
  return value === 'immersive' || value === 'omniscient'
}

/** 从高到低解析默认值；非法值与空值会被跳过。 */
export function resolveNarrativeMode(...candidates: unknown[]): NarrativeMode {
  return candidates.find(isNarrativeMode) ?? DEFAULT_NARRATIVE_MODE
}

export function getNarrativeModeLabel(mode: NarrativeMode): string {
  return NARRATIVE_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? '代入式角色扮演'
}

/** 构建最终行为约束。放在角色/预设提示词之后，确保模式不会只对内置预设生效。 */
export function buildNarrativeModePrompt(
  mode: NarrativeMode,
  userName: string,
  characterName: string,
  omniscientRules?: string,
): string {
  if (mode === 'omniscient') {
    const template = typeof omniscientRules === 'string' && omniscientRules.trim()
      ? omniscientRules.trim()
      : DEFAULT_OMNISCIENT_NARRATIVE_RULES
    const resolvedRules = template.replace(/\{\{(user|char)\}\}/g, (_match, variable: 'user' | 'char') => (
      variable === 'user' ? userName : characterName
    ))
    return `【叙事模式：全局叙事】\n${resolvedRules}\n\n${buildOmniscientNarratorGuard(userName, characterName)}`
  }

  return `【叙事模式：代入式角色扮演】
你当前代入 ${characterName}，以角色可感知、可理解的信息与 ${userName} 互动。
1. 保持 ${characterName} 的身份、性格、记忆、知识边界和说话方式一致。
2. 主要书写 ${characterName} 的对白、动作、感受，以及维持场景所需的少量环境和配角反应。
3. 不替 ${userName} 说话、行动、思考、感受或作出决定，也不宣布其重大行为结果。
4. 默认使用贴近角色的限知视角；对白自然使用第一人称，叙述人称服从角色卡和既有文本。
5. 每次回应当前互动并留下可继续行动或回答的空间，不跳出故事解释规则。`
}

/**
 * 群聊专用叙事约束。chatMode 只决定本轮由谁发言；narrativeMode 决定叙事视角与控制范围。
 * 桌面渲染层和桥接层必须共同调用本函数，避免跨端提示词漂移。
 */
export function buildGroupNarrativeModePrompt(
  mode: NarrativeMode,
  userName: string,
  focusName: string,
  chatMode: 'mention' | 'polling' | 'free',
  omniscientRules?: string,
): string {
  if (mode === 'omniscient') {
    return `${buildNarrativeModePrompt(mode, userName, focusName, omniscientRules)}
【群聊叙事边界】
本轮的发言调度仅指定剧情焦点${focusName ? `「${focusName}」` : ''}，不限制旁白描写其他成员、环境、异地事件或世界变化。
${chatMode === 'free' ? '自由发言模式下可让多名角色自然参与，但回答主体仍是第三人称旁白；对白只能作为叙事中的引语，并用「【角色名】」清楚标注人物。' : '如其他角色参与，其对白只能作为第三人称叙事中的引语；请保持人物设定一致，并清楚标注人物。'}`
  }

  if (chatMode === 'free') {
    return `【叙事模式：代入式角色扮演】
你正在以群聊成员各自的有限视角，与 ${userName} 进行沉浸式互动。
1. 每名角色只依据自己可感知、可理解的信息行动，保持各自身份、性格、记忆和知识边界。
2. 可以让多名角色自然参与，但必须用「【角色名】」标注发言者，不使用全知旁白揭示幕后或异地事件。
3. 不替 ${userName} 说话、行动、思考、感受或作出决定，也不宣布其重大行为结果。
4. 主要书写角色对白、动作、感受，以及维持当前场景所需的少量环境反应。
5. 每次回应当前互动并留下可继续行动或回答的空间，不跳出故事解释规则。`
  }

  return `${buildNarrativeModePrompt(mode, userName, focusName, omniscientRules)}
【群聊叙事边界】
本轮只由当前发言角色「${focusName}」回应；不要替其他群聊成员发言，也不要让其无理由共享当前角色的私有信息。`
}

/** 长记忆摘要侧重点随叙事模式变化，但不改变既有摘要数据结构。 */
export function getNarrativeMemoryGuidance(mode: NarrativeMode): string {
  return mode === 'omniscient'
    ? '摘要需额外保留阵营与势力变化、异地或幕后事件、世界状态，以及尚未解决的全局因果链。区分角色亲历信息与旁白已知信息，不能让角色凭空获得全局知识。'
    : '摘要优先保留当前场景、人物关系、角色亲历事件和角色已经知晓的信息；不要把未被角色感知的幕后信息写成角色知识。'
}
