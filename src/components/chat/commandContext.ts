import type { Character, Preset, Lorebook, ChatParams } from '../../../shared/types'
import type { GenerationTask } from '../../../shared/generationTaskBudget'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { downloadFile } from '../../utils/download'
import { stripThought } from '../../utils/messagePostProcess'
import type { CommandContext } from '../../commands/registry'

/**
 * 命令上下文构建抽取模块（从 useChatInputState.ts 拆出）。
 * 把"斜杠命令 → store 操作"的映射集中在此，hook 侧仅注入少数闭包依赖。
 * 每次调用 createCommandContext 时从 store 读取最新快照，避免陈旧闭包。
 */

export interface CommandContextDeps {
  character: Character
  /** 加载当前预设与激活世界书（hook 侧闭包） */
  loadActivePresetLorebook: () => Promise<[Preset | null, Lorebook[]]>
  /** 输入框上方短暂通知 */
  showNotification: (msg: string) => void
  /** 静默调用 AI 辅助（hook 侧闭包，包装了 profile/preset 解析；接收对象参数） */
  callAiHelper: (opts: {
    messages: ChatParams['messages']
    temperature?: number
    task?: GenerationTask
    inputChars?: number
    expectedBodyChars?: number
  }) => Promise<string>
}

export function createCommandContext(deps: CommandContextDeps): CommandContext {
  const { character, loadActivePresetLorebook, showNotification, callAiHelper: runAiHelper } = deps
  const chatStore = useChatStore.getState()
  const originSessionId = chatStore.currentSessionId
  const settings = useSettingsStore.getState().settings
  const { characters, selectCharacter } = useCharacterStore.getState()

  return {
    character,
    sendMessage: async (content, imgs) => {
      const [preset, lorebooks] = await loadActivePresetLorebook()
      await chatStore.sendMessage(content, imgs, character, preset, lorebooks)
    },
    addImageMessage: async (imgs, content) => {
      await chatStore.addStandaloneMessage(content ?? '', imgs, character, 'system', originSessionId ?? undefined)
    },
    clearChat: async () => {
      await chatStore.clearChat(character.id)
    },
    regenerateLastMessage: async () => {
      const messages = chatStore.messages
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
      if (!lastAssistant) {
        showNotification('没有可重新生成的 AI 回复')
        return
      }
      const [preset, lorebooks] = await loadActivePresetLorebook()
      await chatStore.regenerateMessage(lastAssistant.id, character, preset, lorebooks)
    },
    continueLastMessage: async () => {
      const messages = chatStore.messages
      const lastMsg = messages[messages.length - 1]
      // continueMessage 要求目标是最后一条消息且为 assistant
      if (!lastMsg || lastMsg.role !== 'assistant') {
        showNotification('最后一条消息不是 AI 回复，无法续写')
        return
      }
      const [preset, lorebooks] = await loadActivePresetLorebook()
      await chatStore.continueMessage(lastMsg.id, character, preset, lorebooks)
    },
    triggerMemorySummary: async () => {
      const result = await chatStore.triggerMemorySummary(character)
      if (result) showNotification('长记忆总结已完成')
      else showNotification('长记忆总结失败或消息太少')
    },
    exportChat: async (format) => {
      const sid = chatStore.currentSessionId
      if (!sid) return
      const content = await window.api.chat.exportChat(character.id, sid, format)
      const mimeType = format === 'json' ? 'application/json' : 'text/markdown'
      const ext = format === 'json' ? 'json' : 'md'
      downloadFile(content, `${character.name}-对话.${ext}`, mimeType)
      showNotification(`已导出为 ${format.toUpperCase()} 格式`)
    },
    swipeMessage: async (direction) => {
      const messages = chatStore.messages
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
      if (!lastAssistant) {
        showNotification('没有可切换的 AI 回复')
        return
      }
      await chatStore.swipeMessage(lastAssistant.id, direction, character)
    },
    notify: showNotification,
    getActiveImageGen: () => useSettingsStore.getState().getActiveImageGen(),
    beginImageGeneration: (stage) => {
      if (!originSessionId) return null
      return useChatStore.getState().beginImageGeneration(character.id, originSessionId, stage)?.id ?? null
    },
    updateImageGeneration: (id, stage) => {
      useChatStore.getState().updateImageGeneration(id, stage)
    },
    finishImageGeneration: (id) => {
      useChatStore.getState().finishImageGeneration(id)
    },
    switchCharacter: async (nameOrId) => {
      const target = characters.find(c => c.id === nameOrId || c.name === nameOrId)
      if (target) {
        selectCharacter(target.id)
        showNotification(`已切换到角色: ${target.name}`)
        return true
      }
      showNotification(`未找到角色: ${nameOrId}`)
      return false
    },
    switchPreset: async (nameOrId) => {
      try {
        const presets = await window.api.preset.list()
        const target = presets.find((p) => p.id === nameOrId || p.name === nameOrId)
        if (target) {
          chatStore.setActivePreset(target.id, character.id)
          showNotification(`已切换到预设: ${target.name}`)
          return true
        }
      } catch { /* ignore */ }
      showNotification(`未找到预设: ${nameOrId}`)
      return false
    },
    switchPersona: async (nameOrId) => {
      try {
        const personas = await window.api.persona.list()
        const target = personas.find((p) => p.id === nameOrId || p.name === nameOrId)
        if (target) {
          // 同步 persona 到 settings（与 ChatHeader.handleSwitchPersona 保持一致）
          useSettingsStore.getState().updateSettings({
            activePersonaId: target.id,
            userName: target.name,
            userDescription: target.description,
            userPersona: target.persona,
          })
          // 保存到当前会话
          if (chatStore.currentSessionId) {
            await window.api.chat.updateSession(character.id, chatStore.currentSessionId, { personaId: target.id })
            useChatStore.setState(s => ({
              sessions: s.sessions.map(sess =>
                sess.id === chatStore.currentSessionId ? { ...sess, personaId: target.id } : sess
              ),
            }))
          }
          showNotification(`已切换到人设: ${target.name}`)
          return true
        }
      } catch { /* ignore */ }
      showNotification(`未找到人设: ${nameOrId}`)
      return false
    },
    toggleLorebook: async (nameOrId) => {
      try {
        const lorebooks = await window.api.lorebook.list()
        const target = lorebooks.find((lb) => lb.id === nameOrId || lb.name === nameOrId)
        if (target) {
          const curIds = chatStore.activeLorebookIds
          if (curIds.includes(target.id)) {
            chatStore.setActiveLorebooks(curIds.filter(id => id !== target.id), character.id)
            showNotification(`已关闭世界书: ${target.name}`)
          } else {
            chatStore.setActiveLorebooks([...curIds, target.id], character.id)
            showNotification(`已激活世界书: ${target.name}`)
          }
          return true
        }
      } catch { /* ignore */ }
      showNotification(`未找到世界书: ${nameOrId}`)
      return false
    },
    getTokenUsage: () => {
      const messages = chatStore.messages
      const total = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
      return { total, max: 0 }
    },
    callAiHelper: async (systemPrompt, userContent, options) => {
      return runAiHelper({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: options?.temperature,
        task: options?.task,
        inputChars: options?.inputChars ?? userContent.length,
        expectedBodyChars: options?.expectedBodyChars,
      })
    },
    getRecentMessages: (count) => {
      return chatStore.messages
        // 生图场景只取用户与角色真正看得见的对话：排除保存提示词的 system 图片消息，
        // 同时剥离模型内部 thought，避免旧提示词或推理文字挤占最新场景。
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ ...m, content: stripThought(m.content || '').trim() }))
        .filter((m) => m.content)
        .slice(-count)
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          name: m.role === 'user' ? (settings.userName || '用户') : character.name,
        }))
    },
    userName: settings.userName || '用户',
    userProfile: {
      name: settings.userName || '用户',
      description: settings.userDescription || '',
      persona: settings.userPersona || '',
    },
  }
}
