/**
 * 群聊上下文中桌面（src/store/groupChatContext.ts）与桥接（electron/bridge/groupContext.ts）
 * 必须逐字一致的公共段。free 模式规则两端有意不同（桥接精简版），不在此收敛。
 */

export type GroupChatMode = 'mention' | 'polling' | 'free'

/** 群聊成员概览段（含用户在场声明）。 */
export function buildGroupRosterIntro(
  groupName: string,
  members: readonly { name: string; description?: string }[],
  userName: string,
): string {
  let systemContent = `你正在参与一个群聊「${groupName}」。本群聊中共有 ${members.length} 个角色参与对话：\n`
  members.forEach((member, index) => {
    const desc = member.description ? ' - ' + member.description.slice(0, 80) : ''
    systemContent += `${index + 1}. 【${member.name}】${desc}\n`
  })
  systemContent += `\n用户「${userName}」也在群聊中。\n`
  return systemContent
}

/** 点名/轮询模式的【对话规则】段；其他模式返回空串（由调用方注入自己的 free 规则）。 */
export function buildGroupTurnRulesPrompt(chatMode: GroupChatMode): string {
  switch (chatMode) {
    case 'mention':
      return '\n【对话规则】用户通过 @角色名 指定回复对象。只有被点名的角色才需要回复。对白必须是该角色自己的第一人称；动作/神态可用第三人称叙述（与单聊一致），不要替其他角色说话。\n'
    case 'polling':
      return '\n【对话规则】当前采用自动轮询模式。每次只轮到一位角色发言。对白必须是该角色自己的第一人称；动作/神态可用第三人称叙述（与单聊一致），不要替其他角色或用户发言。\n'
    default:
      return ''
  }
}
