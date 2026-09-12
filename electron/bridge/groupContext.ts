import type { NarrativeMode } from '../../shared/types'
import { buildGroupNarrativeModePrompt } from '../../shared/narrativeMode'
import { replaceVariables } from '../utils/variables'

export interface BridgeGroupContextInput {
  group: { name: string; chatMode: 'mention' | 'polling' | 'free'; systemPrompt?: string }
  members: Array<{
    id: string
    name: string
    description?: string
    personality?: string
    scenario?: string
    systemPrompt?: string
  }>
  messages: Array<{ characterId: string; content: string }>
  speaker: { id: string; name: string } | null
  userName: string
  narrativeMode: NarrativeMode
  omniscientNarrativeRules?: string
}

/** 桥接端精简群聊上下文；叙事约束直接复用 shared，防止桌面与 Android 请求漂移。 */
export function buildGroupContextForBridge(input: BridgeGroupContextInput): {
  systemContent: string
  history: { role: 'user' | 'assistant'; content: string }[]
} {
  const { group, members, messages, speaker, userName, narrativeMode, omniscientNarrativeRules } = input
  const targetName = speaker?.name || members.map((member) => member.name).join('、')
  let systemContent = `你正在参与一个群聊「${group.name}」。本群聊中共有 ${members.length} 个角色参与对话：\n`
  members.forEach((member, index) => {
    const desc = member.description ? ' - ' + member.description.slice(0, 80) : ''
    systemContent += `${index + 1}. 【${member.name}】${desc}\n`
  })
  systemContent += `\n用户「${userName}」也在群聊中。\n`

  switch (group.chatMode) {
    case 'mention':
      systemContent += '\n【对话规则】用户通过 @角色名 指定回复对象。只有被点名的角色才需要回复。回复时请以该角色的第一人称视角发言，不要替其他角色说话。\n'
      break
    case 'polling':
      systemContent += '\n【对话规则】当前采用自动轮询模式。每次只轮到一位角色发言。请以该角色的第一人称视角回复，不要替其他角色或用户发言。\n'
      break
    default:
      systemContent += '\n【对话规则】自由模式。请以角色的身份自然地参与对话。\n'
  }

  if (group.systemPrompt) {
    systemContent += '\n' + replaceVariables(group.systemPrompt, userName, targetName) + '\n'
  }

  if (speaker) {
    const target = members.find((member) => member.id === speaker.id)
    systemContent += `\n\n【当前发言角色：${speaker.name}】\n`
    if (target?.description) systemContent += `描述：${replaceVariables(target.description, userName, speaker.name)}\n`
    if (target?.personality) systemContent += `性格：${replaceVariables(target.personality, userName, speaker.name)}\n`
    if (target?.scenario) systemContent += `场景：${replaceVariables(target.scenario, userName, speaker.name)}\n`
    if (target?.systemPrompt) systemContent += `\n${replaceVariables(target.systemPrompt, userName, speaker.name)}\n`
  }

  systemContent += '\n\n' + buildGroupNarrativeModePrompt(
    narrativeMode,
    userName,
    targetName || '当前角色',
    group.chatMode,
    omniscientNarrativeRules,
  )

  const history = messages.slice(-30).map((message) => {
    const role = message.characterId === '__user__' ? 'user' as const : 'assistant' as const
    const name = message.characterId === '__user__'
      ? userName
      : (members.find((member) => member.id === message.characterId)?.name ?? '未知角色')
    return { role, content: `【${name}】${message.content}` }
  })
  return { systemContent, history }
}
