import { featureSource, matchesFeatureSource, type FeatureOwner } from '../../shared/featureSource'
import { buildMessageTranslationSystemPrompt } from '../../shared/translationPrompt'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { beginFeatureTask, finishFeatureTask, requestFeatureText } from './featureTasks'
import { resolveRendererGenerationTaskBudget } from './generationTaskBudget'
import { useSettingsStore } from './useSettingsStore'
import { pushToast } from './useToastStore'
import type { StoreGet, StoreSet } from '../features/chat/chatStoreTypes'
import type { GroupStoreGet, GroupStoreSet } from './groupChatTypes'

export async function translateSingleMessage(set: StoreSet, get: StoreGet, messageId: string, content: string): Promise<void> {
  const message = get().messages.find(m => m.id === messageId)
  if (!message || !content || message.content !== content) return
  const language = useSettingsStore.getState().settings.translationTargetLang || '中文'
  if (message.translation && message.translationLanguage === language && message.translationSource
    && matchesFeatureSource(message.translationSource, [message])) { get().toggleTranslation(messageId); return }
  const owner: FeatureOwner = { kind: 'single', characterId: message.characterId, sessionId: message.sessionId }
  const source = featureSource([message], 'message')
  const task = beginFeatureTask(owner, 'translation', source, messageId, language)
  if (!task) return
  const current = () => get().currentSessionId === owner.sessionId
    && get().messages.some(m => m.characterId === owner.characterId && m.id === messageId)
    && matchesFeatureSource(source, get().messages)
    && (useSettingsStore.getState().settings.translationTargetLang || '中文') === language
  const show = (status: 'translating' | 'done' | 'error', text = '', errorMsg?: string) => {
    if (current() && !task.controller.signal.aborted) set(s => ({ translatingMessages: {
      ...s.translatingMessages, [messageId]: { status, content: text, errorMsg, source, language },
    } }))
  }
  show('translating')
  try {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) throw new Error('未配置 API 连接')
    const budget = await resolveRendererGenerationTaskBudget({ profile, model: profile.model, task: 'translation', inputChars: content.length, usageTaskType: 'translation' })
    void requestFeatureText(task, {
      ...profile, requestId: task.id, messages: [
        { role: 'system', content: buildMessageTranslationSystemPrompt(language) }, { role: 'user', content },
      ], temperature: 0.3, topP: 0.9, frequencyPenalty: 0, presencePenalty: 0, stream: true,
      maxTokens: budget.requestMaxTokens, reasoningGate: budget.reasoningGate, adaptiveOutputBudget: budget.adaptiveOutputBudget,
    }, text => show('translating', text)).then(async ({ text, completion }) => {
      if (completion.finishReason && completion.finishReason !== 'stop') throw new Error('翻译输出不完整，请重试')
      const translated = stripAllThinking(text).trim()
      if (!translated) throw new Error('翻译结果为空，请重试或更换模型')
      if (task.controller.signal.aborted || (useSettingsStore.getState().settings.translationTargetLang || '中文') !== language) return
      const applied = await window.api.chat.commitFeatureResult(owner.characterId, owner.sessionId,
        { taskId: task.id, source, feature: 'translation', messageId, language, text: translated })
      if (!applied) { show('error', '', '消息已变化，请重新翻译'); return }
      if (current() && !task.controller.signal.aborted) {
        show('done', translated)
        set(s => ({ messages: s.messages.map(m => m.id === messageId ? { ...m, translation: translated, translationLanguage: language, translationSource: source } : m),
          showTranslationIds: new Set([...s.showTranslationIds, messageId]) }))
      }
    }).catch(error => show('error', '', String(error instanceof Error ? error.message : error))).finally(() => finishFeatureTask(task))
  } catch (error) {
    show('error', '', String(error instanceof Error ? error.message : error)); finishFeatureTask(task, 'failed')
  }
}

export async function translateGroupMessage(set: GroupStoreSet, get: GroupStoreGet, messageId: string): Promise<void> {
  const state = get(), message = state.messages.find(m => m.id === messageId)
  if (!message?.content || !state.currentGroup || !state.currentSessionId) return
  const owner: FeatureOwner = { kind: 'group', groupId: state.currentGroup.id, sessionId: state.currentSessionId }
  const language = useSettingsStore.getState().settings.translationTargetLang || '中文'
  if (message.translation && message.translation !== '...' && message.translationLanguage === language && message.translationSource
    && matchesFeatureSource(message.translationSource, [message])) {
    set(s => ({ messages: s.messages.map(m => m.id === messageId ? { ...m, _showTranslation: !m._showTranslation } : m) })); return
  }
  const source = featureSource([message], 'message'), task = beginFeatureTask(owner, 'translation', source, messageId, language)
  if (!task) return
  const current = () => get().currentGroup?.id === owner.groupId && get().currentSessionId === owner.sessionId && matchesFeatureSource(source, get().messages)
    && (useSettingsStore.getState().settings.translationTargetLang || '中文') === language
  const patch = (translation: string | null, show = false) => {
    if (current() && !task.controller.signal.aborted) set(s => ({ messages: s.messages.map(m => m.id === messageId ? { ...m, translation, _showTranslation: show } : m) }))
  }
  const fail = (error: unknown) => {
    if (!current() || task.controller.signal.aborted) return
    patch(null)
    pushToast({ variant: 'warning', title: '翻译失败', description: error instanceof Error ? error.message : String(error), requestId: task.id })
  }
  patch('...')
  try {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) throw new Error('未配置 API 连接')
    const budget = await resolveRendererGenerationTaskBudget({ profile, model: profile.model, task: 'translation', inputChars: message.content.length, usageTaskType: 'translation' })
    void requestFeatureText(task, { ...profile, requestId: task.id, messages: [
      { role: 'system', content: buildMessageTranslationSystemPrompt(language) }, { role: 'user', content: message.content },
    ], temperature: 0.3, topP: 0.9, frequencyPenalty: 0, presencePenalty: 0, stream: false,
    maxTokens: budget.requestMaxTokens, reasoningGate: budget.reasoningGate, adaptiveOutputBudget: budget.adaptiveOutputBudget,
    }).then(async ({ text, completion }) => {
      if (completion.finishReason && completion.finishReason !== 'stop') throw new Error('翻译输出不完整，请重试')
      const translated = stripAllThinking(text).trim()
      if (!translated) throw new Error('翻译结果为空，请重试或更换模型')
      if (task.controller.signal.aborted || (useSettingsStore.getState().settings.translationTargetLang || '中文') !== language) return
      const applied = await window.api.group.commitFeatureResult(owner.groupId, owner.sessionId,
        { taskId: task.id, source, feature: 'translation', messageId, language, text: translated })
      if (!applied) { patch(null); return }
      patch(translated, true)
      if (current() && !task.controller.signal.aborted) set(s => ({ messages: s.messages.map(m => m.id === messageId
        ? { ...m, translationLanguage: language, translationSource: source } : m) }))
    }).catch(fail).finally(() => finishFeatureTask(task))
  } catch (error) { fail(error); finishFeatureTask(task, 'failed') }
}
