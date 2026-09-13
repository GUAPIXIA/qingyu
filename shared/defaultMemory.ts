/**
 * 新会话/新群聊会话的默认长记忆配置——唯一决策表。
 * 消费方：渲染层 chatUtils（applyDefaultMemory/applyDefaultGroupMemory）、
 * 主进程 ipc/chat（bridge 建会话）、ipc/group（建群聊会话默认值）。
 * 历史问题是三处各抄一份并靠注释"对齐"，改一处漏两处。
 */

/** 默认自动总结间隔（条） */
export const DEFAULT_AUTO_MEMORY_INTERVAL = 10

export interface DefaultMemoryConfig {
  memoryEnabled: boolean
  memoryMode: 'manual' | 'auto'
  autoMemoryInterval: number
}

/** 角色卡已启用长记忆时优先角色参数；否则回退全局"新建对话默认开启长记忆"；两者都未开启则禁用。 */
export function resolveDefaultMemoryConfig(
  settings: { defaultMemoryEnabled?: boolean },
  character?: {
    defaultMemoryEnabled?: boolean
    defaultMemoryMode?: 'manual' | 'auto'
    defaultMemoryInterval?: number
  } | null,
): DefaultMemoryConfig {
  if (character?.defaultMemoryEnabled === true) {
    return {
      memoryEnabled: true,
      memoryMode: character.defaultMemoryMode ?? 'auto',
      autoMemoryInterval: character.defaultMemoryInterval ?? DEFAULT_AUTO_MEMORY_INTERVAL,
    }
  }
  if (settings.defaultMemoryEnabled) {
    return { memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: DEFAULT_AUTO_MEMORY_INTERVAL }
  }
  return { memoryEnabled: false, memoryMode: 'manual', autoMemoryInterval: DEFAULT_AUTO_MEMORY_INTERVAL }
}

/** 群聊会话无角色卡层：只看全局开关。 */
export function resolveDefaultGroupMemoryConfig(
  settings: { defaultMemoryEnabled?: boolean },
): DefaultMemoryConfig {
  return resolveDefaultMemoryConfig(settings, null)
}
