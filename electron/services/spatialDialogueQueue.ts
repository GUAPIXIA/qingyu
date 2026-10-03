import { randomUUID } from 'node:crypto'
import { prepareAutomaticDialogue } from './spatialAutomaticDialogue'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AICompletion, ChatParams } from '../../shared/types'
import type { SpatialAiProposal, SpatialAiSession, SpatialDialogueGeneration } from '../../shared/spatial-ai'
import type { SpatialVersion } from '../../shared/spatial'
// eslint-disable-next-line no-restricted-imports
import type { SpatialCoreState } from '@qingyu/spatial-core'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { resolveGenerationTaskBudget } from '../../shared/generationTaskBudget'
import { enabledProfileOverride, resolveEffectiveContextLimit } from '../../shared/modelOutputProfile'
import { chatData } from '../features/chat/chatData'
import { safeId } from '../utils/pathGuard'
import { DIRS } from './storage'
import { hashSpatialValue, type SpatialScope } from './spatialRepository'
import { spatialRepository, sessionFor, snapshotLocked } from './spatialService'
import { readChatSettings, resolveChatProfile } from './chatConnection'
import { countTokens } from './tokenizer'
import { getTaskSnapshot } from '../chat/taskStore'
import { parseSpatialDialogueReply, spatialAutomaticReason, spatialNodePath, SPATIAL_DIALOGUE_PROMPT } from './spatialDialogueProtocol'
import { spatialDialogueMentionsPlace } from './spatialPlaceNames'
import { isSpatialBoardEnabled, SPATIAL_DISABLED_REASON } from './spatialFeature'

export interface SpatialDialogueCaptureInput {
  generationId: string
  kind: SpatialDialogueGeneration['kind']
  priorMessageId?: string
  expectedVersion?: SpatialVersion
}
interface Deps {
  ensure(scope: SpatialScope): Promise<SpatialAiSession>
  load(id: string): SpatialAiSession
  save(state: SpatialAiSession): void
  persona(scope: SpatialScope): Promise<string | null>
  active: Map<string, { taskId: string; controller: AbortController }>
  deleted: Set<string>
  publish(scope: SpatialScope): void
  complete(params: ChatParams, signal: AbortSignal, timeout: number): Promise<AICompletion>
  isDirectPending(scope: SpatialScope): boolean
  autoApply(scope: SpatialScope, proposalId: string, lease: { id: string; controller: AbortController }): Promise<unknown>
}

export function createSpatialDialogueQueue(deps: Deps) {
  const draining = new Map<string, Promise<void>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const scopeKey = (scope: SpatialScope) => hashSpatialValue(scope)
  const bodyOf = (content: string) => stripAllThinking(content).trim()
  const sourceContext = async (scope: SpatialScope) => ({ session: await sessionFor(scope), snapshot: await snapshotLocked(scope),
    personaId: await deps.persona(scope), messages: chatData.readMessages(scope.characterId, scope.sessionId, true) })
  const sourceError = async (scope: SpatialScope, state: SpatialAiSession, generation: SpatialDialogueGeneration,
    cached?: Awaited<ReturnType<typeof sourceContext>>): Promise<string | null> => {
    if (!isSpatialBoardEnabled(await sessionFor(scope))) return SPATIAL_DISABLED_REASON
    const { session, snapshot, personaId, messages } = cached ?? await sourceContext(scope)
    if (session.spatialNarrativeSyncPolicy === 'off') return '剧情同步已关闭'
    if (session.spatialContextEnabled === false) return '对话位置读取已关闭，剧情同步已停止'
    if (session.spatialAiSessionId !== state.id || session.spatialWorldId !== state.scope.worldId || session.spatialRuntimeId !== state.scope.runtimeId) return '画板绑定已改变'
    if ((session.narrativeMode ?? 'immersive') !== generation.narrativeMode || personaId !== generation.personaId) return '用户身份或叙事模式已改变'
    if (!snapshot || snapshot.version.bindingEpoch !== generation.snapshot.version.bindingEpoch) return '画板绑定代次已改变'
    if (generation.state !== 'registered') return '正文尚未登记'
    const message = messages.find(message => message.id === generation.messageId)
    if (!message || message.role !== 'assistant' || hashSpatialValue(bodyOf(message.content)) !== generation.bodyHash) return '来源正文已修改、删除或切换候选'
    const user = messages.find(message => message.id === generation.userMessageId)
    if (generation.userMessageId && (!user || bodyOf(user.content) !== generation.userText)) return '来源用户输入已修改或删除'
    if (generation.priorMessageId && bodyOf(messages.find(message => message.id === generation.priorMessageId)?.content ?? '') !== generation.priorText) return '续写来源正文已改变'
    if (messages.filter(message => message.role === 'assistant').at(-1)?.id !== generation.messageId) return '已被更新的回复取代'
    if (state.dialogueGenerations?.some(item => item.state === 'registered' && item.sequence > generation.sequence)) return '已被更新的回复取代'
    return null
  }
  const invalidate = (state: SpatialAiSession, generation: SpatialDialogueGeneration, reason: string) => {
    for (const task of state.tasks.filter(task => task.dialogueId === generation.id && ['queued','running'].includes(task.state))) {
      task.state = reason.includes('已关闭') ? 'cancelled' : 'superseded'; task.error = reason; task.completedAt = Date.now()
      if (deps.active.get(state.id)?.taskId === task.id) deps.active.get(state.id)?.controller.abort()
    }
    for (const proposal of state.proposals.filter(proposal => proposal.dialogueId === generation.id)) {
      if (['pending','stale'].includes(proposal.status)) { proposal.status = 'stale'; proposal.staleReason = reason; proposal.canReview = false }
      if (proposal.status === 'applied' && /来源|正文|身份|模式/.test(reason)) { proposal.sourceChanged = true; proposal.staleReason = reason }
    }
  }
  const refresh = async (scope: SpatialScope, state: SpatialAiSession) => {
    const before = hashSpatialValue(state)
    const context = state.dialogueGenerations?.some(item => item.state === 'registered') ? await sourceContext(scope) : undefined
    for (const generation of state.dialogueGenerations ?? []) {
      if (generation.state !== 'registered') continue
      const reason = await sourceError(scope, state, generation, context)
      if (reason) invalidate(state, generation, reason)
    }
    for (const proposal of state.proposals.filter(item => item.mode === 'dialogue_sync' && item.status === 'pending')) {
      if (context?.snapshot && hashSpatialValue(proposal.baseVersion) !== hashSpatialValue(context.snapshot.version)) {
        proposal.status = 'stale'; proposal.staleReason = proposal.dialogueCandidates?.length ? '画板版本已改变，请重新核对当前位置与目标' : '画板版本已改变；旧建议缺少原动作记录，请在画板助手明确指令调整'; proposal.canReview = !!proposal.dialogueCandidates?.length
        continue
      }
      const actors = new Set(proposal.commands.map(command => (command as { actorId?: string }).actorId).filter(Boolean))
      if (state.proposals.some(item => item.mode === 'instruction' && item.createdAt > proposal.createdAt && item.commands.some(command => actors.has((command as { actorId?: string }).actorId)))) {
        proposal.status = 'stale'; proposal.staleReason = '同一人物已有更新的画板指令，请核对新指令'; proposal.canReview = true
      }
    }
    if (hashSpatialValue(state) !== before) deps.save(state)
    return state
  }
  const register = async (scope: SpatialScope, generationId: string, messageId: string) => {
    safeId(generationId); safeId(messageId)
    await spatialRepository.locked(async () => {
      const state = await deps.ensure(scope)
      const generation = state.dialogueGenerations?.find(item => item.id === generationId)
      if (!generation || generation.state !== 'awaiting_body') return
      const session = await sessionFor(scope)
      const messages = chatData.readMessages(scope.characterId, scope.sessionId, true)
      const message = messages.find(message => message.id === messageId)
      if (generationId.startsWith('task-')) {
        const task = getTaskSnapshot(generationId)
        if (!task || task.state !== 'completed' || task.client.kind !== 'desktop' || task.characterId !== scope.characterId || task.sessionId !== scope.sessionId || task.assistantMessageId !== messageId) {
          generation.state = 'ignored'; deps.save(state); return
        }
      }
      // 主进程重新读盘，通知不能夹带模型正文或把不完整生成声明为完成。
      if (!message || message.role !== 'assistant' || message.spatialGenerationId !== generationId || message.generationError || !bodyOf(message.content) || session.spatialNarrativeSyncPolicy === 'off' || session.spatialContextEnabled === false) {
        generation.state = 'ignored'; deps.save(state); return
      }
      const body = bodyOf(message.content), bodyHash = hashSpatialValue(body)
      const key = hashSpatialValue({ messageId, bodyHash, kind: generation.kind })
      state.dialogueHandled ??= {}
      if (state.dialogueHandled[key]) { generation.state = 'ignored'; deps.save(state); return }
      generation.state = 'registered'; generation.messageId = messageId; generation.bodyHash = bodyHash
      generation.body = generation.priorText ? `${generation.priorText}\n${body}` : body
      const taskId = randomUUID(); generation.taskId = taskId; state.dialogueHandled[key] = taskId
      state.tasks.push({ id: taskId, requestHash: key, dialogueId: generation.id, mode: 'dialogue_sync', state: 'queued', startedAt: Date.now() })
      await refresh(scope, state); deps.save(state)
    })
    deps.publish(scope); kick(scope)
  }
  const run = async (scope: SpatialScope) => {
    const prepared = await spatialRepository.locked(async () => {
      if (!isSpatialBoardEnabled(await sessionFor(scope))) return null
      const session = await sessionFor(scope)
      if (!session.spatialAiSessionId) return null
      const state = await refresh(scope, await deps.ensure(scope))
      if (deps.active.has(state.id) || deps.isDirectPending(scope)) return null
      const task = state.tasks.find(task => task.mode === 'dialogue_sync' && task.state === 'queued')
      if (!task) return null
      const generation = state.dialogueGenerations!.find(item => item.id === task.dialogueId)!
      try {
        const currentSnapshot = await snapshotLocked(scope)
        if (hashSpatialValue(currentSnapshot!.version) !== hashSpatialValue(generation.snapshot.version)) throw new Error('发送时的画板版本已改变，请核对当前位置')
        const core = generation.snapshot as SpatialCoreState & typeof generation.snapshot
        const character = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-character' && actor.externalRef.id === scope.characterId)
        const persona = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === generation.personaId)
        if (!character) throw new Error('本轮快照未登记当前角色，请先初始化画板')
        const actors = { character: character.id, ...(persona ? { persona: persona.id } : {}) }
        const settings = readChatSettings(), profile = resolveChatProfile(settings)
        if (!profile?.model || !profile.baseUrl) throw new Error('当前聊天连接不可用')
        const plan = resolveGenerationTaskBudget({ task: 'spatial_dialogue_sync', model: profile.model, userHardCap: 1024,
          profileOverride: enabledProfileOverride(profile.capabilityOverride), reasoningLevel: 'off' })
        const path = (nodeId: string): string[] => {
          const names: string[] = [], seen = new Set<string>()
          let node = core.world.nodes.find(node => node.id === nodeId)
          while (node && !seen.has(node.id)) { seen.add(node.id); names.unshift(node.name); node = core.world.nodes.find(parent => parent.id === (node!.parentNodeId ?? core.world.boards.find(board => board.id === node!.boardId)?.parentEntryNodeId)) }
          return names
        }
        let targets = core.world.nodes.filter(node => !node.tags.includes('system:offstage')).map(node => ({ id: node.id, boardId: node.boardId, name: node.name, path: path(node.id) }))
        const cropped: string[] = []
        if (countTokens(JSON.stringify(targets), profile.model) > 2000) {
          targets = targets.filter(node => spatialDialogueMentionsPlace(node.name, core, actors, { user: generation.userText, assistant: generation.body!, narrativeMode: generation.narrativeMode }) || core.runtime.placements.some(placement => placement.anchor.nodeId === node.id))
          cropped.push('地图索引按本轮正文中的地点名检索；正文完整保留')
          if (countTokens(JSON.stringify(targets), profile.model) > 2000) throw new Error('本轮地点索引超出预算，请减少本轮涉及的地点后重新提取')
        }
        const payload = { mode: 'dialogue_sync', worldName: core.world.name, generationKind: generation.kind, narrativeMode: generation.narrativeMode,
          allowedActors: core.world.actors.filter(actor => [actors.character,actors.persona].includes(actor.id)).map(actor => ({ id: actor.id, name: actor.displayName, kind: actor.id === actors.persona ? 'persona' : 'character' })),
          placements: core.runtime.placements.filter(placement => [actors.character,actors.persona].includes(placement.actorId)).map(placement => ({ actorId: placement.actorId, boardId: placement.boardId, nodeId: placement.anchor.nodeId, semanticPosition: placement.semanticPosition })),
          targets, user: generation.userText, assistant: generation.body }
        const params: ChatParams = { requestId: task.id, provider: profile.provider as ChatParams['provider'], apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model,
          messages: [{ role: 'system', content: SPATIAL_DIALOGUE_PROMPT }, { role: 'user', content: JSON.stringify(payload) }],
          stream: false, temperature: 0.1, topP: 1, maxTokens: plan.requestMaxTokens, frequencyPenalty: 0, presencePenalty: 0,
          reasoningGate: { level: plan.reasoningGate.level, knob: plan.reasoningGate.knob, tokens: plan.reasoningGate.gateTokens },
          observability: { source: 'aux', taskType: plan.task, characterId: scope.characterId, sessionId: scope.sessionId } }
        const inputTokens = countTokens(JSON.stringify(params.messages), profile.model)
        if (inputTokens + plan.requestMaxTokens + 128 > resolveEffectiveContextLimit({ model: profile.model, profileMaxContext: profile.maxContext, capabilityOverride: profile.capabilityOverride })) throw new Error('本轮完整正文超出提取预算；不会裁剪正文后移动人物')
        const controller = new AbortController(); deps.active.set(state.id, { taskId: task.id, controller })
        task.state = 'running'; task.startedAt = Date.now(); task.model = profile.model; task.profileId = settings.activeProfileId ?? undefined; task.inputTokens = inputTokens; task.croppedSources = cropped
        try { deps.save(state) } catch (error) { deps.active.delete(state.id); throw error }
        return { state, task, generation, core, actors, targets, params, controller }
      } catch (error) {
        task.state = 'failed'; task.error = error instanceof Error ? error.message : String(error); task.completedAt = Date.now(); deps.save(state)
        return null
      }
    })
    deps.publish(scope)
    if (!prepared) return
    const { state, task, generation, controller, params } = prepared
    try {
      const completion = await deps.complete(params, controller.signal, 30000)
      if (controller.signal.aborted) throw new Error('剧情提取已停止')
      if (!completion.text.trim() || completion.finishReason !== 'stop') throw new Error('剧情提取输出不完整，请重新提取')
      let reply = parseSpatialDialogueReply(stripAllThinking(completion.text), prepared.core, prepared.actors,
        { user: generation.userText, assistant: generation.body!, narrativeMode: generation.narrativeMode }, prepared.targets.map(target => target.id))
      if (generation.syncPolicy === 'auto') reply = { ...reply, ...prepareAutomaticDialogue(prepared.core,reply.candidates,prepared.actors,
        { user: generation.userText, assistant: generation.body!, narrativeMode: generation.narrativeMode }) }
      const automaticId = await spatialRepository.locked(async () => {
        if (deps.deleted.has(state.id) || deps.active.get(state.id)?.controller !== controller) return null
        const latest = deps.load(state.id), currentTask = latest.tasks.find(item => item.id === task.id)!
        if (currentTask.state !== 'running') return
        const reason = await sourceError(scope, latest, generation)
        if (reason) { invalidate(latest, generation, reason); deps.save(latest); return }
        currentTask.state = 'completed'; currentTask.completedAt = Date.now(); currentTask.elapsedMs = currentTask.completedAt - currentTask.startedAt
        currentTask.inputTokens = completion.usage?.promptTokens ?? currentTask.inputTokens; currentTask.outputTokens = completion.usage?.completionTokens ?? countTokens(completion.text, params.model)
        const snapshot = await snapshotLocked(scope)
        const conflict = hashSpatialValue(snapshot!.version) !== hashSpatialValue(generation.snapshot.version)
        const proposalId = randomUUID()
        const proposal: SpatialAiProposal = { id: proposalId, commitId: randomUUID(), mode: 'dialogue_sync', dialogueId: generation.id,
          status: conflict ? 'stale' : 'pending', ...(conflict ? { staleReason: '提取期间画板已更新，请重新核对当前位置与目标' } : {}), explanation: '本轮剧情的位置建议',
          dialogueCandidates: reply.candidates,
          comparisons: reply.candidates.filter(item => item.eligible && item.targetNodeId).map(item => ({
            actorName: prepared.core.world.actors.find(actor => actor.id === item.actorId)!.displayName,
            currentPath: spatialNodePath(prepared.core, prepared.core.runtime.placements.find(placement => placement.actorId === item.actorId)?.anchor.nodeId),
            targetPath: prepared.core.world.nodes.some(node => node.id === item.targetNodeId) ? spatialNodePath(prepared.core, item.targetNodeId) : item.targetText,
          })),
          canReview: conflict,
          summary: reply.summary, unresolved: reply.unresolved, evidence: reply.evidence, commands: reply.commands,
          baseVersion: generation.snapshot.version, personaId: generation.personaId, sourceFingerprint: generation.bodyHash!, sourceOptions: { text: '', loreEntryIds: [] },
          sources: [{ id: 'user', label: '本轮用户输入', kind: 'message', text: generation.userText }, { id: 'assistant', label: '已保存正文', kind: 'message', text: generation.body! }], createdAt: Date.now() }
        const session = await sessionFor(scope), policy = session.spatialNarrativeSyncPolicy
        if ((generation.syncPolicy === 'auto' || policy === 'auto') && (reply.commands.length || reply.unresolved.length)) {
          const reason = spatialAutomaticReason(proposal, generation, prepared.core, scope.characterId, policy, session.spatialNarrativeSyncEpoch)
          proposal.automatic = reason ? { status: 'skipped', reason: conflict ? proposal.staleReason : reason } : { status: 'applying' }
          if (reason) { proposal.status = 'discarded'; proposal.discardReason = proposal.automatic.reason; proposal.canReview = false }
        }
        if (reply.commands.length || reply.unresolved.length) latest.proposals.push(proposal)
        latest.messages.push({ id: randomUUID(), role: 'assistant', mode: 'dialogue_sync', content: reply.commands.length ? `本轮剧情：${reply.summary.join('；')}。${proposal.automatic?.status === 'applying' ? '正在自动同步。' : proposal.automatic?.status === 'skipped' ? `已跳过：${proposal.automatic.reason}。` : '需确认后应用。'}${conflict ? '画板版本已变化。' : ''}` : reply.unresolved.length ? `本轮位置未采用：${reply.unresolved.join('；')}` : '本轮没有新的已完成位置变化。',
          ...(reply.commands.length || reply.unresolved.length ? { proposalId } : {}), createdAt: Date.now() })
        deps.save(latest)
        return proposal.automatic?.status === 'applying' ? proposal.id : null
      })
      // 先持久化决定，再走与手动确认相同的主进程事务；恢复不会重复自动尝试。
      if (automaticId && deps.active.get(state.id)?.controller === controller && !controller.signal.aborted) {
        try { await deps.autoApply(scope, automaticId, { id: state.id, controller }) }
        catch (error) {
          await spatialRepository.locked(async () => {
            if (deps.deleted.has(state.id) || deps.active.get(state.id)?.controller !== controller) return
            const latest = await refresh(scope, deps.load(state.id)), proposal = latest.proposals.find(item => item.id === automaticId)
            if (!proposal || proposal.status === 'applied') return
            proposal.automatic = { status: 'skipped', reason: error instanceof Error ? error.message.slice(0,500) : String(error).slice(0,500) }
            proposal.status = 'discarded'; proposal.discardReason = proposal.automatic.reason; proposal.canReview = false
            deps.save(latest)
          })
        }
      }
    } catch (error) {
      await spatialRepository.locked(() => {
        if (deps.deleted.has(state.id) || deps.active.get(state.id)?.controller !== controller) return
        const latest = deps.load(state.id), currentTask = latest.tasks.find(item => item.id === task.id)!
        if (currentTask.state === 'running') { currentTask.state = controller.signal.aborted ? 'cancelled' : 'failed'; currentTask.error = error instanceof Error ? error.message.slice(0,500) : String(error).slice(0,500); currentTask.completedAt = Date.now(); deps.save(latest) }
      })
    } finally {
      const ownsLease = deps.active.get(state.id)?.controller === controller
      if (ownsLease) deps.active.delete(state.id)
      deps.publish(scope)
      if (ownsLease && !deps.deleted.has(state.id) && deps.load(state.id).tasks.some(item => item.state === 'queued')) kick(scope)
    }
  }
  const drain = (scope: SpatialScope): Promise<void> => {
    const key = scopeKey(scope), old = draining.get(key)
    if (old) return old
    const timer = timers.get(key)
    if (timer) { clearTimeout(timer); timers.delete(key) }
    const promise = run(scope).finally(() => { if (draining.get(key) === promise) draining.delete(key) })
    draining.set(key, promise)
    return promise
  }
  function kick(scope: SpatialScope) {
    const key = scopeKey(scope)
    if (timers.has(key)) return
    timers.set(key, setTimeout(() => { timers.delete(key); void drain(scope).catch(() => { deps.publish(scope) }) }, 0))
  }
  // 旧版自动策略曾将明确动作退回确认；只重新处理当前、未提交且原始来源仍有效的记录。
  const resumeAutomatic = async (scope: SpatialScope) => {
    const prepared = await spatialRepository.locked(async () => {
      const state = await refresh(scope, await deps.ensure(scope))
      if (deps.active.has(state.id) || deps.isDirectPending(scope)) return null
      const proposal = [...state.proposals].reverse().find(item => item.mode === 'dialogue_sync' &&
        ['pending','stale'].includes(item.status) && item.automatic?.status === 'confirmation' && !item.reviewedFromId)
      if (!proposal) return null
      const generation = state.dialogueGenerations?.find(item => item.id === proposal.dialogueId)
      const session = await sessionFor(scope), snapshot = await snapshotLocked(scope)
      let reason = !generation || !snapshot ? '原动作记录已缺失，保持原位置' : await sourceError(scope,state,generation)
      if (!reason && generation && snapshot) {
        const core = snapshot as SpatialCoreState & typeof snapshot
        if (hashSpatialValue(snapshot.version) !== hashSpatialValue(proposal.baseVersion) ||
          hashSpatialValue(snapshot.version) !== hashSpatialValue(generation.snapshot.version)) reason = '画板版本已改变，保持当前位置'
        else {
          const actors = { character: core.world.actors.find(actor => actor.externalRef.type === 'qingyu-character' && actor.externalRef.id === scope.characterId)?.id,
            persona: core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === generation.personaId)?.id }
          const reply = prepareAutomaticDialogue(core,proposal.dialogueCandidates ?? [],actors,
            {user:generation.userText,assistant:generation.body!,narrativeMode:generation.narrativeMode})
          proposal.commands = reply.commands; proposal.summary = reply.summary; proposal.unresolved = reply.unresolved; proposal.dialogueCandidates = reply.candidates
          proposal.comparisons = undefined
          reason = spatialAutomaticReason(proposal,generation,core,scope.characterId,session.spatialNarrativeSyncPolicy,session.spatialNarrativeSyncEpoch)
        }
      }
      if (reason) {
        proposal.automatic = {status:'skipped',reason}; proposal.status = 'discarded'; proposal.discardReason = reason; proposal.canReview = false
        for (const message of state.messages.filter(item => item.proposalId === proposal.id && item.mode === 'dialogue_sync')) message.content = `本轮位置已跳过：${reason}`
        deps.save(state); return null
      }
      const task = state.tasks.find(item => item.dialogueId === proposal.dialogueId)
      if (!task) return null
      const controller = new AbortController()
      deps.active.set(state.id,{taskId:task.id,controller}); proposal.automatic = {status:'applying'}
      for (const message of state.messages.filter(item => item.proposalId === proposal.id && item.mode === 'dialogue_sync')) message.content = `本轮剧情：${proposal.summary.join('；')}。正在自动同步。`
      try { deps.save(state) } catch (error) { deps.active.delete(state.id); throw error }
      return {id:state.id,proposalId:proposal.id,controller}
    })
    if (!prepared) return
    try { await deps.autoApply(scope,prepared.proposalId,{id:prepared.id,controller:prepared.controller}) }
    catch (error) {
      await spatialRepository.locked(() => {
        if (deps.deleted.has(prepared.id) || deps.active.get(prepared.id)?.controller !== prepared.controller) return
        const state = deps.load(prepared.id), proposal = state.proposals.find(item => item.id === prepared.proposalId)
        if (!proposal || proposal.status === 'applied') return
        proposal.automatic = {status:'skipped',reason:error instanceof Error ? error.message.slice(0,500) : String(error).slice(0,500)}
        proposal.status = 'discarded'; proposal.discardReason = proposal.automatic.reason; proposal.canReview = false; deps.save(state)
      })
    } finally {
      if (deps.active.get(prepared.id)?.controller === prepared.controller) deps.active.delete(prepared.id)
      deps.publish(scope); kick(scope)
    }
  }
  return {
    kick, drain, refresh, register, sourceError, resumeAutomatic,
    suspend() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear(); draining.clear()
    },
    cancelScope(scope: SpatialScope) {
      const key = scopeKey(scope), timer = timers.get(key)
      if (timer) clearTimeout(timer)
      timers.delete(key)
      draining.delete(key)
    },
    async capture(scope: SpatialScope, input: SpatialDialogueCaptureInput): Promise<string | null> {
      if (!isSpatialBoardEnabled(await sessionFor(scope))) return null
      safeId(input.generationId)
      if (!['normal','regenerate','continue'].includes(input.kind)) throw new Error('剧情生成类型无效')
      return spatialRepository.locked(async () => {
        if (!isSpatialBoardEnabled(await sessionFor(scope))) return null
        const session = await sessionFor(scope)
        if (!session.spatialWorldId || !session.spatialAiSessionId || session.spatialNarrativeSyncPolicy === 'off' || session.spatialContextEnabled === false) return null
        const state = await deps.ensure(scope), snapshot = await snapshotLocked(scope)
        if (!snapshot || (input.expectedVersion && hashSpatialValue(input.expectedVersion) !== hashSpatialValue(snapshot.version))) return null
        const previous = state.dialogueGenerations?.find(item => item.id === input.generationId)
        if (previous) { if (previous.kind !== input.kind) throw new Error('生成 ID 已用于不同类型的剧情请求'); return input.generationId }
        const messages = chatData.readMessages(scope.characterId, scope.sessionId, true)
        const user = messages.filter(message => message.role === 'user').at(-1)
        const prior = input.kind === 'continue' ? messages.find(message => message.id === input.priorMessageId) ?? messages.filter(message => message.role === 'assistant').at(-1) : undefined
        const sequence = (state.dialogueSequence ?? 0) + 1; state.dialogueSequence = sequence
        state.dialogueGenerations ??= []
        state.dialogueGenerations.push({ id: input.generationId, sequence, kind: input.kind, state: 'awaiting_body', snapshot,
          personaId: await deps.persona(scope), narrativeMode: session.narrativeMode ?? 'immersive', syncPolicy: session.spatialNarrativeSyncPolicy === 'auto' ? 'auto' : 'suggest', syncEpoch: session.spatialNarrativeSyncEpoch, userMessageId: user?.id ?? null, userText: bodyOf(user?.content ?? ''),
          ...(prior ? { priorMessageId: prior.id, priorText: bodyOf(prior.content) } : {}), createdAt: Date.now() })
        deps.save(state); return input.generationId
      })
    },
    async retry(scope: SpatialScope, taskId: string) {
      await spatialRepository.locked(async () => {
        const state = await refresh(scope, await deps.ensure(scope)), old = state.tasks.find(task => task.id === taskId)
        if (!old?.dialogueId || !['failed','interrupted'].includes(old.state)) throw new Error('该剧情任务不能重新提取')
        const generation = state.dialogueGenerations!.find(item => item.id === old.dialogueId)!
        const reason = await sourceError(scope, state, generation)
        if (reason) throw new Error(reason)
        const snapshot = await snapshotLocked(scope)
        if (hashSpatialValue(snapshot!.version) !== hashSpatialValue(generation.snapshot.version)) throw new Error('发送时的画板版本已改变，请先核对当前位置，后续新回复会使用新版本')
        if (state.tasks.some(task => task.dialogueId === generation.id && ['queued','running','completed'].includes(task.state))) throw new Error('该来源已有提取结果或正在处理')
        state.tasks.push({ id: randomUUID(), requestHash: old.requestHash, dialogueId: generation.id, mode: 'dialogue_sync', state: 'queued', startedAt: Date.now() }); deps.save(state)
      })
      deps.publish(scope); kick(scope)
    },
    async recover() {
      const directory = join(DIRS.spatial(), 'ai-sessions')
      if (!existsSync(directory)) return
      for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
        const state = deps.load(file.slice(0,-5)), scope = { characterId: state.scope.characterId, sessionId: state.scope.sessionId }
        const session = await sessionFor(scope).catch(() => null)
        if (!session || session.spatialAiSessionId !== state.id) continue
        // 只核对最新已保存回复的检查点，不扫描历史发起补调用。
        const latest = chatData.readMessages(scope.characterId, scope.sessionId, true).filter(message => message.role === 'assistant').at(-1)
        if (latest?.spatialGenerationId) await register(scope, latest.spatialGenerationId, latest.id)
        await spatialRepository.locked(async () => refresh(scope, await deps.ensure(scope)))
        kick(scope)
      }
    },
  }
}
