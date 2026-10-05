/**
 * 阶段 0c：会话变更事件总线——渲染层消费端 hook。
 *
 * 订阅主进程广播的 session:updated（来自其他窗口/未来桥接层的会话变更），
 * 做 PC 双窗口同步：
 * - 刷新会话列表（标题/删除/新消息）；
 * - 若当前窗口正打开该会话且非流式中，刷新消息（避免覆盖流式内容）。
 *
 * F3：同时订阅主进程侧的**角色**与**设置**写入广播——
 * 外部 Agent（IPC）写入的数据不应要求用户重启应用才能看到。
 * 设置重载带脏检查：本地有未保存改动时不动，避免与 F1 的写回竞争。
 *
 * 验收（方案 §7 0c）：一个窗口发消息，另一个窗口收到 session:updated 并同步刷新。
 */
import { useEffect } from 'react'
import { useSettingsStore } from '../store/useSettingsStore'
import { useCharacterStore } from '../store/useCharacterStore'
import { useChatStore } from '../store/useChatStore'
import { logError } from '../lib/logger'

export function useSessionSync(): void {
  useEffect(() => {
    let disposed = false

    const unbind = window.api.sessionSync.onUpdated(({ sessionId, change }) => {
      if (disposed) return
      const settings = useSettingsStore.getState().settings
      const charId = settings.activeCharacterId
      if (!charId) return

      const chatStore = useChatStore.getState()

      // 刷新会话列表（新消息/标题/删除/新建均需更新）
      chatStore.loadSessions(charId).catch((e) => logError('SessionSync:loadSessions', e))

      // 若当前窗口正打开该会话且未在生成 → 刷新消息（双窗口同步核心）
      if (chatStore.currentSessionId === sessionId && !chatStore.isStreaming) {
        const character = useCharacterStore.getState().characters.find((c) => c.id === charId)
        if (character) {
          chatStore.loadMessages(character).catch((e) => logError('SessionSync:loadMessages', e))
        }
      }
      void change
    })

    // F3：角色数据被主进程侧写入（外部 Agent / 导入）→ 重新拉取角色列表
    const unbindCharacters = window.api.sessionSync.onCharactersChanged(() => {
      if (disposed) return
      useCharacterStore.getState().loadCharacters().catch((e) => logError('SessionSync:loadCharacters', e))
    })

    // F3：设置被主进程侧写入 → 本地无未保存改动时重新加载（有改动则保留本地，退出时由 F1 的脏标记决定是否写盘）
    const unbindSettings = window.api.sessionSync.onSettingsChanged(() => {
      if (disposed) return
      const store = useSettingsStore.getState()
      if (store._dirty) return
      store.loadSettings().catch((e) => logError('SessionSync:loadSettings', e))
    })

    return () => {
      disposed = true
      unbind()
      unbindCharacters()
      unbindSettings()
    }
  }, [])
}
