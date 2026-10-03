import type { GroupChat } from '../../../shared/types'
import type { GroupStoreGet, GroupStoreSet } from '../../store/groupChatTypes'
// 阶段 6 S6-01：轮询续排/自动记忆的跨端共享纯逻辑（fixture oracle 即此实现）
import { planGroupPollingContinue, resolvePollingIntervalMs, planAutoMemoryTrigger } from '../../../shared/chat-core/groupScheduling'

/** 轮询定时器 handle，用于切换/删除群聊时清理 */
let pollingTimer: ReturnType<typeof setTimeout> | null = null

/** 清理轮询定时器 */
export function clearPollingTimer() {
  if (pollingTimer !== null) {
    clearTimeout(pollingTimer)
    pollingTimer = null
  }
}

/** 检查是否需要自动触发记忆摘要 */
export function checkAutoMemory(get: GroupStoreGet) {
  const state = get()
  const session = state.sessions?.find((s) => s.id === state.currentSessionId)
  // 触发判定：shared/chat-core/groupScheduling.ts 跨端一致（按已处理游标统计，编辑或时钟变化不误判）
  const shouldTrigger = planAutoMemoryTrigger({
    memoryEnabled: session?.memoryEnabled,
    memoryMode: session?.memoryMode,
    autoMemoryInterval: session?.autoMemoryInterval,
    memoryLastMessageId: session?.memoryLastMessageId ?? null,
    messageIds: state.messages.map((message) => message.id),
  })
  if (shouldTrigger) {
    state.triggerMemorySummary()
  }
}

/** 检查 polling 模式下是否需要继续下一轮 */
/**
 * 轮询续接检查。
 * @returns 已排定下一轮接力返回 true；已到轮数上限、无下一发言者或越界返回 false（轮到用户）。
 */
export async function checkPollingContinue(set: GroupStoreSet, get: GroupStoreGet, _group: GroupChat): Promise<boolean> {
  const state = get()
  // 使用最新的 currentGroup，避免闭包中过期引用
  const group = state.currentGroup
  if (!group) return false
  if (group.id !== _group.id) return false
  const scopeSessionId = state.currentSessionId
  const spatial = state.sessions.find(session => session.id === scopeSessionId)?.spatialBoardEnabled === true && scopeSessionId ? await window.api.spatial.readGroupContext(group.id, scopeSessionId) : null
  if (get().currentGroup?.id !== group.id || get().currentSessionId !== scopeSessionId) return false
  const eligibleMemberIds = spatial?.narrativeMode === 'omniscient' ? group.memberIds : group.memberIds.filter(id => !spatial?.offstageCharacterIds.includes(id))

  // 续排计划：shared/chat-core/groupScheduling.ts 跨端一致
  // （D2 已拍板：轮数按每次接力（burst）计——自最近一条用户消息以来的 AI 轮次，跨用户消息重置）
  const plan = planGroupPollingContinue({
    messages: state.messages.map((m) => ({ characterId: m.characterId, round: m.round })),
    memberIds: eligibleMemberIds,
    maxRounds: group.maxRounds,
  })
  if (!plan.continue) return false
  const nextCharId = plan.nextCharId

  // 更新 currentSpeakerIndex（纯运行时 UI 状态：成员栏高亮"当前说话者"）
  // 优化：不再每轮全量持久化群组文件（此前每 2s 一次整文件写入）；
  // 群组文件只在创建/编辑时保存，重启后该索引回落到上次持久化值，轮询下一轮自动纠正
  const updatedGroup = { ...group, currentSpeakerIndex: group.memberIds.indexOf(nextCharId) }
  set({ currentGroup: updatedGroup })

  // H-02 修复：保存定时器 handle，以便切换/删除群聊时清理
  clearPollingTimer()
  const scheduleNextPoll = () => {
    clearPollingTimer()
    pollingTimer = setTimeout(() => {
      const currentState = get()
      if (currentState.isStreaming) {
        // M-25 修复：流式中本轮跳过，但必须继续调度下一轮——
        // 此前直接 return 导致自动轮询链永久中断，无恢复机制
        scheduleNextPoll()
        return
      }
      // 定时器触发时再次检查群组是否仍为当前群组
      const curGroup = currentState.currentGroup
      if (!curGroup || curGroup.id !== group.id) return
      currentState.sendPollingRound(nextCharId)
    }, resolvePollingIntervalMs(group.speakerInterval))
  }
  scheduleNextPoll()
  return true
}