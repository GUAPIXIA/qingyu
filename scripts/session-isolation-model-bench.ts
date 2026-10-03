/** Explicit live-model acceptance; copies only configuration into an isolated userData. */
/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous IPC/event shim delegates unchanged to production handlers */
import { app, BrowserWindow } from 'electron'
import { join, relative, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { initLogger, LogLevel } from '../electron/services/logger'
import type { AICompletion, ChatParams, Message, Settings } from '../shared/types'
import type { SpatialSnapshot } from '../shared/spatial'
import type { SpatialCoreState } from '@qingyu/spatial-core'

const output = resolve('output/session-isolation-model')
mkdirSync(output, { recursive: true })
const isolated = mkdtempSync(join(output, 'user-data-'))
const config = join(isolated, 'data/config')
mkdirSync(config, { recursive: true })
const source = process.env.SESSION_ISOLATION_MODEL_SOURCE || join(app.getPath('appData'), 'qingyu')
const copied = ['data/config/settings.json', 'data/config/credentials.json', 'Local State']
const sourceHashes = new Map(copied.filter(file => existsSync(join(source, file))).map(file => [file, createHash('sha256').update(readFileSync(join(source, file))).digest('hex')]))
for (const file of copied) if (existsSync(join(source, file))) copyFileSync(join(source, file), join(isolated, file))
app.setPath('userData', isolated)

app.whenReady().then(async () => {
  initLogger(isolated, LogLevel.DEBUG, { console: false })
  const host = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await host.loadURL('data:text/html,<script>setInterval(()=>0,100)</script>')
  let exitCode = 0
  try {
    const { readChatSettings, resolveChatProfile } = await import('../electron/services/chatConnection')
    const { getAdapter } = await import('../electron/services/ai')
    const profile = resolveChatProfile(readChatSettings())
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) throw new Error('当前聊天连接不可用')
    if (process.argv.includes('--preflight')) {
      const models = await getAdapter(profile.provider).listModels(profile.baseUrl, profile.apiKey)
      writeFileSync(join(output, 'preflight.json'), JSON.stringify({ connection: profile.name, model: profile.model, models }, null, 2))
    } else {
      await runAcceptance()
    }
  } catch (error) {
    exitCode = 1
    // Network errors may include URLs; the private local log is not a public report.
    writeFileSync(join(output, 'failure.log'), error instanceof Error ? error.stack || error.message : String(error))
  } finally {
    for (const file of copied) if (existsSync(join(isolated, file))) unlinkSync(join(isolated, file))
    const unchanged = [...sourceHashes].every(([file, hash]) => createHash('sha256').update(readFileSync(join(source, file))).digest('hex') === hash)
    writeFileSync(join(output, process.argv.includes('--preflight') ? 'preflight-cleanup.json' : 'cleanup.json'), JSON.stringify({ isolated: relative(process.cwd(), isolated), credentialsRemoved: copied.every(file => !existsSync(join(isolated, file))), sourceConfigurationUnchanged: unchanged }, null, 2))
    if (!unchanged) exitCode = 1
    if (!exitCode && existsSync(join(output, 'failure.log'))) unlinkSync(join(output, 'failure.log'))
    host.destroy()
    app.exit(exitCode)
  }
})

async function runAcceptance(): Promise<void> {
  const { readChatSettings, resolveChatProfile } = await import('../electron/services/chatConnection')
  const { getAdapter, registerAIIPC } = await import('../electron/services/ai')
  const { DIRS, writeJson } = await import('../electron/services/storage')
  const { chatData } = await import('../electron/features/chat/chatData')
  const { registerChatIPC } = await import('../electron/ipc/chat')
  const { registerGroupIPC, groupData } = await import('../electron/ipc/group')
  const { registerSettingsIPC } = await import('../electron/ipc/settings')
  const { memorySummaryService } = await import('../electron/services/memorySummaryService')
  const { contextService } = await import('../electron/chat/contextService')
  const { spatialAiService } = await import('../electron/services/spatialAiService')
  const { spatialService } = await import('../electron/services/spatialService')
  const { featureSource, matchesFeatureSource, featureOwnerKey } = await import('../shared/featureSource')
  const { buildMessageTranslationSystemPrompt } = await import('../shared/translationPrompt')
  const { stripAllThinking } = await import('../shared/thoughtMarkup')
  const { resolveGenerationTaskBudget } = await import('../shared/generationTaskBudget')
  const { onFeatureDataRestoring } = await import('../electron/services/featureTaskLifecycle')
  const { createBackupV2, restoreBackupV2 } = await import('../electron/services/backup')
  const settings = readChatSettings(), initialProfile = resolveChatProfile(settings)!
  const alternateModel = process.env.SESSION_ISOLATION_SWITCH_MODEL || 'mimo-v2.6-flash'
  const scope = { characterId: 'isolation-character', sessionId: 'isolation-session' }
  const owner = { kind: 'single' as const, ...scope }
  type RequestRecord = { requestId: string; taskType: string; source?: string; model: string; provider: string; owner?: unknown; taskId?: string; logicalSessionId?: string; messageCount: number; startedAt: number; endedAt?: number; finishReason?: string; usage?: AICompletion['usage']; rolePromptPresent: boolean; schemaPresent: boolean; assistantHistoryPresent: boolean; credentialMatches: boolean; error?: string }
  const report = { passed: false, date: new Date().toISOString(), connection: initialProfile.name, initialModel: initialProfile.model, alternateModel, isolated: relative(process.cwd(), isolated), checks: [] as Array<{ name: string; passed: boolean }>, requests: [] as RequestRecord[], responses: [] as Array<{ requestId: string; text: string }>, usageTotals: {} as Record<string, { requests: number; promptTokens: number; completionTokens: number; totalTokens: number }>, error: undefined as string | undefined }
  const persist = () => writeFileSync(join(output, 'model-report.json'), JSON.stringify(report, null, 2))
  const check = (name: string, passed: boolean) => { report.checks.push({ name, passed }); persist(); if (!passed) throw new Error(name) }
  const waitFor = async (condition: () => boolean, name: string, timeout = 120_000) => {
    const start = Date.now()
    while (!condition()) {
      if (Date.now() - start > timeout) throw new Error(name)
      await new Promise(resolveWait => setTimeout(resolveWait, 40))
    }
  }
  // Wrap the real adapter only for evidence; inputs, network, streams and responses are unchanged.
  const adapter = getAdapter(initialProfile.provider)
  const originalChat = adapter.chat.bind(adapter)
  adapter.chat = async (params, onChunk, signal, onUsage) => {
    const material = JSON.stringify(params.messages)
    const record: RequestRecord = { requestId: params.requestId, taskType: params.observability?.taskType || 'main', source: params.observability?.source, model: params.model, provider: params.provider,
      owner: params.observability?.featureTask?.owner, taskId: params.observability?.featureTask?.taskId, logicalSessionId: params.observability?.featureTask?.logicalSessionId,
      messageCount: params.messages.length, startedAt: Date.now(), rolePromptPresent: material.includes('ROLEPLAY_ONLY_ISOLATION'),
      schemaPresent: material.includes('allowedActors') || material.includes('currentMap'), assistantHistoryPresent: material.includes('history'),
      credentialMatches: params.apiKey === initialProfile.apiKey && params.baseUrl === initialProfile.baseUrl }
    report.requests.push(record); persist()
    try {
      const completion = await originalChat(params, onChunk, signal, usage => { record.usage = usage; onUsage?.(usage) })
      record.finishReason = completion.finishReason; record.usage = completion.usage || record.usage
      report.responses.push({ requestId: params.requestId, text: completion.text })
      return completion
    } catch (error) { record.error = signal.aborted ? 'cancelled' : 'network_or_provider_error'; throw error }
    finally { record.endedAt = Date.now(); persist() }
  }
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) }
  const subscriptions = new Map<string, Set<(payload: any) => void>>()
  const subscribe = (channel: string, callback: (payload: any) => void) => {
    const listeners = subscriptions.get(channel) || new Set(); listeners.add(callback); subscriptions.set(channel, listeners)
    return () => { listeners.delete(callback) }
  }
  const sender = { isDestroyed: () => false, send: (channel: string, payload: any) => { for (const listener of [...subscriptions.get(channel) || []]) listener(payload) } }
  const invoke = async (channel: string, ...args: any[]) => {
    const handler = handlers.get(channel); if (!handler) throw new Error(`缺少 IPC ${channel}`)
    return handler({ sender }, ...args)
  }
  registerAIIPC(ipc as any); registerChatIPC(ipc as any); registerGroupIPC(ipc as any); registerSettingsIPC(ipc as any, {} as any)
  // The event bridge exercises production renderer task management and production IPC handlers.
  // It is intentionally not presented as a browser/preload/UI acceptance test.
  Object.assign(globalThis, { window: { api: { ai: {
    chat: (params: ChatParams) => invoke('ai:chat', params), cancelChat: (requestId: string, reason?: string) => invoke('ai:cancel', requestId, reason),
    onChunk: (callback: (payload: any) => void) => subscribe('ai:chunk', callback), onComplete: (callback: (payload: any) => void) => subscribe('ai:done', callback),
    onError: (callback: (payload: any) => void) => subscribe('ai:error', callback), onFeatureDataRestoring: onFeatureDataRestoring,
  } } } })
  const { beginFeatureTask, requestFeatureText, finishFeatureTask, abortFeatureTask, cancelFeatureTasks } = await import('../src/store/featureTasks')
  const { EditorAssistant } = await import('../src/store/editorAssistant')
  const profileNow = () => resolveChatProfile(readChatSettings())!
  const paramsFor = (requestId: string, task: 'translation' | 'main' | 'polish' | 'title', messages: ChatParams['messages']): ChatParams => {
    const profile = profileNow()
    const budget = resolveGenerationTaskBudget({ task, model: profile.model, userHardCap: task === 'main' ? 1024 : 512, reasoningLevel: 'off' })
    return { requestId, ...profile, messages, stream: true, temperature: 0.1, topP: 1, maxTokens: budget.requestMaxTokens, reasoningGate: budget.reasoningGate, frequencyPenalty: 0, presencePenalty: 0 }
  }
  const launchTranslation = (message: Message, onProgress?: (text: string) => void) => {
    const task = beginFeatureTask(owner, 'translation', featureSource([message], 'message'), message.id, randomUUID())!
    const promise = requestFeatureText(task, paramsFor(task.id, 'translation', [{ role: 'system', content: buildMessageTranslationSystemPrompt('English') }, { role: 'user', content: message.content }]), onProgress)
    return { task, promise }
  }
  const save = async (role: Message['role'], content: string, id = randomUUID(), extra: Partial<Message> = {}) => {
    const message: Message = { id, ...scope, role, content, images: [], isEditing: false, timestamp: Date.now(), ...extra }
    await chatData.saveMessageLocked(scope.characterId, message)
    return chatData.readMessages(scope.characterId, scope.sessionId).find(item => item.id === id)!
  }
  const session = async () => (await chatData.listSessions(scope.characterId)).find(item => item.id === scope.sessionId)!
  const position = (snapshot: SpatialSnapshot) => {
    const core = snapshot as SpatialSnapshot & SpatialCoreState
    const actor = core.world.actors.find(item => item.externalRef.id === scope.characterId)!
    const placement = core.runtime.placements.find(item => item.actorId === actor.id)
    return core.world.nodes.find(item => item.id === placement?.anchor.nodeId)?.name
  }
  const main = async (instruction: string, id = randomUUID()) => {
    await save('user', instruction)
    const context = await contextService.build({ ...scope, content: instruction, clientKind: 'desktop' })
    const params = paramsFor(id, 'main', context.messages)
    params.observability = { source: 'single', taskType: 'main', characterId: scope.characterId, sessionId: scope.sessionId }
    let text = '', completion: any, error: any
    const off = [subscribe('ai:chunk', data => { if (data.requestId === id) text += data.text }), subscribe('ai:done', data => { if (data.requestId === id) completion = data }), subscribe('ai:error', data => { if (data.requestId === id) error = data })]
    try { await invoke('ai:chat', params) } finally { off.forEach(unbind => unbind()) }
    check('正文独立正常结束', !error && completion?.finishReason === 'stop' && !!stripAllThinking(text).trim())
    const message = await save('assistant', stripAllThinking(text).trim())
    return { message, params }
  }
  let editor: InstanceType<typeof EditorAssistant> | undefined
  try {
    check('当前聊天凭据可读取且测试目录独立', !!initialProfile.apiKey && resolve(isolated) !== resolve(source))
    await invoke('settings:save', { ...settings, translationTargetLang: 'English' })
    // Preserve the configured endpoint/model, but give the test character its own short prompt.
    writeJson(join(DIRS.characters(), `${scope.characterId}.json`), { id: scope.characterId, name: '林雪', description: 'ROLEPLAY_ONLY_ISOLATION。林雪是一位旅者。回复只写一两句中文，按用户要求描述，不输出 JSON。', scenario: '青石城包含茶馆与渡口两个地点，林雪在茶馆。', firstMessage: '林雪在茶馆。', boundLorebookIds: [], createdAt: 1, updatedAt: 1 })
    writeJson(join(DIRS.config(), 'personas.json'), [])
    writeJson(join(DIRS.chats(), scope.characterId, 'sessions.json'), [{ id: scope.sessionId, characterId: scope.characterId, title: '综合联验', narrativeMode: 'immersive', personaId: null, memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 4, spatialBoardEnabled: true, spatialContextEnabled: true, spatialNarrativeSyncPolicy: 'off', createdAt: 1, updatedAt: 1 }, { id: 'second-session', characterId: scope.characterId, title: '另一会话', narrativeMode: 'immersive', personaId: null, spatialBoardEnabled: true, createdAt: 1, updatedAt: 1 }])
    const seed = await save('assistant', '林雪现在在青石城的茶馆，约定明天带一本地图给朋友。')
    const init = await spatialAiService.ask(scope, { requestId: randomUUID(), mode: 'initialize', text: '创建青石城，包含茶馆和渡口两个地点。林雪现在在茶馆内，点位未知；不添加距离。' })
    check('真实模型空间初始化产出预览', init.tasks.at(-1)?.state === 'completed' && !!init.proposals.at(-1)?.preview)
    await spatialAiService.apply(scope, init.proposals.at(-1)!.id, true)
    check('初始化确认后起点正确', position((await spatialService.loadBound(scope.characterId, scope.sessionId))!) === '茶馆')
    const primary = main('告诉我你现在在哪里，用一句话回答。')
    const moving = spatialAiService.ask(scope, { requestId: randomUUID(), mode: 'instruction', text: '把林雪移到青石城的渡口内，点位未知。' })
    const translated = launchTranslation(seed)
    const [body, move, translation] = await Promise.all([primary, moving, translated.promise])
    check('正文与画板及翻译真实请求重叠', report.requests.filter(item => [body.params.requestId, translated.task.id, move.tasks.at(-1)!.id].includes(item.requestId)).every(item => item.startedAt < Math.min(...report.requests.filter(row => [body.params.requestId, translated.task.id, move.tasks.at(-1)!.id].includes(row.requestId)).map(row => row.endedAt!))))
    check('翻译正常结束并独立提交', translation.completion.finishReason === 'stop' && await chatData.commitFeatureResult(scope.characterId, scope.sessionId, { taskId: translated.task.id, source: translated.task.source, feature: 'translation', messageId: seed.id, language: 'English', text: stripAllThinking(translation.text) }))
    finishFeatureTask(translated.task)
    check('移动在确认前未生效', position((await spatialService.loadBound(scope.characterId, scope.sessionId))!) === '茶馆')
    check('移动请求成功', move.tasks.at(-1)?.state === 'completed' && !!move.proposals.at(-1)?.commands.length)
    await spatialAiService.apply(scope, move.proposals.at(-1)!.id, true)
    const returned = await spatialAiService.ask(scope, { requestId: randomUUID(), mode: 'instruction', text: '把她移回之前的茶馆，其他对象保持不变。' })
    check('连续指令沿用独立助手历史', returned.tasks.at(-1)?.state === 'completed' && !!returned.proposals.at(-1)?.commands.length)
    await spatialAiService.apply(scope, returned.proposals.at(-1)!.id, true)
    check('指代返回以实际提交为准', position((await spatialService.loadBound(scope.characterId, scope.sessionId))!) === '茶馆')
    for (let index = 0; index < 4; index++) await save(index % 2 ? 'assistant' : 'user', index % 2 ? '林雪答应明天带地图，目前仍在茶馆。' : '请记住明天带地图的约定，现在没有离开茶馆。')
    memorySummaryService.schedule(scope)
    const memoryPromise = memorySummaryService.summarize({ ...scope, automatic: true })
    const cancelled = launchTranslation(body.message, () => { if (!cancelled.task.controller.signal.aborted) abortFeatureTask(cancelled.task) })
    const cancelledOutcome = cancelled.promise.then(() => false, () => cancelled.task.controller.signal.aborted)
    const independentBody = main('确认明天带地图的约定，用一句话回答。')
    const [memory, cancellation] = await Promise.all([memoryPromise, cancelledOutcome, independentBody])
    check('取消翻译不影响正文或后台记忆', cancellation && memory.status === 'summarized' && !!(await session()).memorySource)
    check('取消任务未保存半截翻译', !chatData.readMessages(scope.characterId, scope.sessionId).find(item => item.id === body.message.id)?.translation)
    const stale = launchTranslation(seed)
    await waitFor(() => report.requests.some(item => item.requestId === stale.task.id), '未发出过期翻译请求')
    await chatData.saveMessageLocked(scope.characterId, { ...seed, content: '用户已经修改这条正文，旧翻译不得覆盖。' })
    const staleResult = await stale.promise
    check('真实迟到翻译不能覆盖新正文', !(await chatData.commitFeatureResult(scope.characterId, scope.sessionId, { taskId: stale.task.id, source: stale.task.source, feature: 'translation', messageId: seed.id, language: 'English', text: stripAllThinking(staleResult.text) })))
    finishFeatureTask(stale.task)
    editor = new EditorAssistant('draft', `${scope.characterId}:${scope.sessionId}`)
    const ticket = editor.begin('polish', '我想明天出发。')
    const polish = editor.request(ticket, paramsFor(ticket.task.id, 'polish', [{ role: 'system', content: '润色这句话，只返回一行中文。' }, { role: 'user', content: '我想明天出发。' }]))
    editor.touch(); editor.touch()
    const oldText = await polish
    if (!editor.current(ticket)) editor.keep(ticket, oldText, '旧润色建议')
    check('真实编辑结果经过版本保护保留旧建议', !editor.current(ticket) && editor.suggestions.length === 1)
    editor.finish(ticket)
    // Keep a real request in flight while switching only the isolated settings.
    await chatData.updateSession(scope.characterId, scope.sessionId, { spatialNarrativeSyncPolicy: 'suggest' })
    const generationId = randomUUID()
    check('生产队列捕获来源', await spatialAiService.dialogue.capture(scope, { generationId, kind: 'normal' }) === generationId)
    const narrative = await save('assistant', '林雪已经离开茶馆，走到青石城的渡口内。', randomUUID(), { spatialGenerationId: generationId })
    const runningId = randomUUID()
    const running = spatialAiService.ask(scope, { requestId: runningId, mode: 'positions', text: '只查询林雪当前的位置，不移动任何人。' })
    await waitFor(() => report.requests.some(item => item.requestId === runningId), '配置切换前请求未开始')
    await spatialAiService.dialogue.register(scope, generationId, narrative.id)
    const switched: Settings = structuredClone(readChatSettings())
    const originalConfig = switched.connectionProfiles.find(item => item.id === switched.activeProfileId)!
    const alternateId = `bench-${randomUUID()}`
    switched.connectionProfiles.push({ ...originalConfig, id: alternateId, name: '联验同端点快照', model: alternateModel })
    switched.activeProfileId = alternateId; switched.activeModel = alternateModel
    const switchAt = Date.now()
    await invoke('settings:save', switched)
    check('切换时真实旧请求仍运行', !report.requests.find(item => item.requestId === runningId)!.endedAt || report.requests.find(item => item.requestId === runningId)!.endedAt! >= switchAt)
    await running; await spatialAiService.dialogue.drain(scope)
    const afterSwitch = await spatialAiService.get(scope)
    const queued = afterSwitch.tasks.find(item => item.dialogueId === generationId)!
    check('运行请求仍用原模型，生产排队请求用新模型', report.requests.filter(item => item.requestId === runningId).every(item => item.model === initialProfile.model) && !!queued && queued.model === alternateModel && queued.profileId === alternateId && queued.state === 'completed')
    const extracted = afterSwitch.proposals.find(item => item.dialogueId === generationId)!
    check('配置切换保留助手历史且剧情仍等待确认', afterSwitch.messages.some(item => item.content.includes('把她移回')) && extracted?.status === 'pending' && position((await spatialService.loadBound(scope.characterId, scope.sessionId))!) === '茶馆')
    if (extracted.commands.length) {
      await spatialAiService.apply(scope, extracted.id, true)
    } else {
      // The existing completion guard rejects a quote containing departure verbs.
      // Preserve that diagnostic; never turn an ineligible candidate into a command.
      check('保守剧情诊断不移动人物', extracted.unresolved.length > 0 && extracted.dialogueCandidates?.every(item => !item.eligible) === true)
      const explicit = await spatialAiService.ask(scope, { requestId: randomUUID(), mode: 'instruction', text: '明确调整：把林雪移到青石城的渡口内，点位未知。' })
      check('明确指令使用新模型并产出独立提案', explicit.tasks.at(-1)?.model === alternateModel && explicit.tasks.at(-1)?.state === 'completed' && !!explicit.proposals.at(-1)?.commands.length)
      await spatialAiService.apply(scope, explicit.proposals.at(-1)!.id, true)
    }
    check('新模型确认后位置生效', position((await spatialService.loadBound(scope.characterId, scope.sessionId))!) === '渡口')
    const newBody = await main('请根据当前空间位置用一句话说出林雪在哪，不复述旧位置。')
    check('新正文读取提交后的只读位置且用新模型', newBody.params.model === alternateModel && newBody.params.messages.some(item => item.content.includes('【空间位置 v1】') && item.content.includes('渡口')))
    // A group reusing the character owns its translation independently.
    const groupScope = { groupId: 'isolation-group', sessionId: 'group-session' }
    writeJson(join(DIRS.groups(), 'index.json'), [{ id: groupScope.groupId, name: '联验群', memberIds: [scope.characterId], chatMode: 'mention', currentSpeakerIndex: 0, autoMode: false, presetId: null, lorebookIds: [], systemPrompt: '', createdAt: 1, updatedAt: 1 }])
    writeJson(join(DIRS.groups(), groupScope.groupId, 'sessions.json'), [{ id: groupScope.sessionId, groupId: groupScope.groupId, title: '群聊联验', narrativeMode: 'immersive', personaId: null, createdAt: 1, updatedAt: 1 }])
    const groupMessage = { id: seed.id, ...groupScope, characterId: scope.characterId, content: '群聊中的林雪仍在茶馆，这不是单聊状态。', images: [], timestamp: Date.now(), round: 1 }
    await invoke('group:saveMessage', groupScope.groupId, groupScope.sessionId, groupMessage)
    const groupOwner = { kind: 'group' as const, ...groupScope }
    const groupTask = beginFeatureTask(groupOwner, 'translation', featureSource([groupMessage], 'message'), groupMessage.id)!
    const groupTranslation = await requestFeatureText(groupTask, paramsFor(groupTask.id, 'translation', [{ role: 'system', content: buildMessageTranslationSystemPrompt('English') }, { role: 'user', content: groupMessage.content }]))
    check('同角色同消息 ID 的群聊翻译独立归属', await groupData.commitFeatureResult(groupScope.groupId, groupScope.sessionId, { taskId: groupTask.id, source: groupTask.source, feature: 'translation', messageId: groupMessage.id, language: 'English', text: stripAllThinking(groupTranslation.text) }) && !chatData.readMessages(scope.characterId, scope.sessionId).find(item => item.id === seed.id)?.translation)
    finishFeatureTask(groupTask)
    const exported = JSON.parse(await invoke('chat:exportChat', scope.characterId, scope.sessionId, 'json'))
    const exportMessages = Array.isArray(exported) ? exported : exported.messages
    check('普通导出只有正文，不携带功能元数据', exportMessages.length > 0 && exportMessages.every((item: any) => !item.translationSource && !item.memoryTaskId && !item.spatialGenerationId))
    const beforeRestore = JSON.stringify(await spatialService.loadBound(scope.characterId, scope.sessionId))
    const backup = join(isolated, 'acceptance.zip')
    createBackupV2(backup)
    const restoreTask = launchTranslation(newBody.message)
    const restoreOutcome = restoreTask.promise.then(() => false, () => restoreTask.task.controller.signal.aborted)
    await waitFor(() => report.requests.some(item => item.requestId === restoreTask.task.id), '恢复前任务未开始')
    await spatialAiService.restore(() => restoreBackupV2(backup))
    check('真实在途任务在恢复时被取消', await restoreOutcome)
    await waitFor(() => report.requests.filter(item => item.requestId === restoreTask.task.id).every(item => !!item.endedAt), '恢复后网络请求未退出')
    check('恢复后同 ID 旧任务不能提交', !(await chatData.commitFeatureResult(scope.characterId, scope.sessionId, { taskId: restoreTask.task.id, source: restoreTask.task.source, feature: 'translation', messageId: newBody.message.id, language: 'English', text: 'late result' })))
    check('真实 ZIP 保留空间与已提交记忆和群聊译文', JSON.stringify(await spatialService.loadBound(scope.characterId, scope.sessionId)) === beforeRestore && !!(await session()).memory && !!groupData.readMessages(groupScope.groupId, groupScope.sessionId)[0]?.translation)
    check('另一会话保持独立', chatData.readMessages(scope.characterId, 'second-session').length === 0 && (await spatialAiService.get({ ...scope, sessionId: 'second-session' })).messages.length === 0)
    const publicHistory = JSON.stringify(await spatialAiService.get(scope))
    check('公开功能历史不保存连接凭据', !publicHistory.includes(initialProfile.apiKey) && !publicHistory.includes(initialProfile.baseUrl))
    const requests = report.requests
    check('实际网络请求均沿用同一连接', requests.every(item => item.credentialMatches))
    check('正文与功能任务提示分离', requests.filter(item => item.taskType === 'main').every(item => item.rolePromptPresent && !item.schemaPresent) && requests.filter(item => ['translation', 'memory', 'polish'].includes(item.taskType)).every(item => !item.rolePromptPresent && !item.schemaPresent))
    check('单聊与群聊逻辑会话不共用', requests.find(item => item.requestId === groupTask.id)?.logicalSessionId !== requests.find(item => item.requestId === translated.task.id)?.logicalSessionId && featureOwnerKey(owner) !== featureOwnerKey(groupOwner))
    const observations = readFileSync(join(isolated, 'data/diagnostics/generation-observations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    check('实际模型与用量观测逐请求一致', requests.every(item => observations.some(observation => observation.requestId === item.requestId && observation.model === item.model && (observation.taskType || 'main') === item.taskType)))
    for (const request of requests) {
      const total = report.usageTotals[request.taskType] ||= { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      total.requests++; total.promptTokens += request.usage?.promptTokens || 0; total.completionTokens += request.usage?.completionTokens || 0; total.totalTokens += (request.usage?.promptTokens || 0) + (request.usage?.completionTokens || 0)
    }
    check('正常完成请求记录供应商用量', requests.filter(item => item.finishReason === 'stop').every(item => (item.usage?.promptTokens || 0) + (item.usage?.completionTokens || 0) > 0))
    check('事件监听完成后释放', [...subscriptions.values()].every(listeners => listeners.size === 0))
    check('正文未被画板 schema 或编辑建议污染', chatData.readMessages(scope.characterId, scope.sessionId).every(item => !item.content.includes('allowedActors') && !item.content.includes('currentMap') && !item.content.includes(oldText)))
    check('来源失效记忆不会被授予新来源', !(await session()).memorySource || matchesFeatureSource((await session()).memorySource!, chatData.readMessages(scope.characterId, scope.sessionId), await session()))
    report.passed = true
  } catch (error) {
    // Keep private endpoint-bearing failures in failure.log; public report identifies the failing check.
    report.error = report.checks.find(item => !item.passed)?.name || '执行异常，见本地 failure.log'
    throw error
  } finally {
    editor?.dispose(); cancelFeatureTasks(); memorySummaryService.cancelAll()
    spatialAiService.dialogue.cancelScope(scope)
    adapter.chat = originalChat
    persist()
  }
}
