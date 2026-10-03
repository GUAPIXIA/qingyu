import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AICompletion, ChatParams, GroupChat, GroupSession } from '../../../../shared/types'
import type { SpatialAiProposal, SpatialGroupAiSession, SpatialGroupDialogueBatch, SpatialGroupDialogueCapture } from '../../../../shared/spatial-ai'
// eslint-disable-next-line no-restricted-imports
import type { SpatialCoreState } from '@qingyu/spatial-core'
import { stripAllThinking } from '../../../../shared/thoughtMarkup'
import { resolveGenerationTaskBudget } from '../../../../shared/generationTaskBudget'
import { enabledProfileOverride, resolveEffectiveContextLimit } from '../../../../shared/modelOutputProfile'
import { groupData } from '../../../ipc/group'
import { safeId } from '../../../utils/pathGuard'
import { DIRS } from '../../../services/storage'
import { hashSpatialValue, readSpatialJson, type SpatialGroupScope } from '../repository'
import { spatialRepository, sessionFor, snapshotLocked } from '../commitService'
import { readChatSettings, resolveChatProfile } from '../../../services/chatConnection'
import { countTokens } from '../../../services/tokenizer'
import { parseSpatialDialogueReply, spatialNodePath, SPATIAL_DIALOGUE_PROMPT } from './protocol'
import { spatialDialogueMentionsPlace } from '../placeNames'
import { captureGroupSpatialCheckpoint } from './groupCheckpoint'
import { isSpatialBoardEnabled, SPATIAL_DISABLED_REASON } from '../board'

interface Context { session: GroupSession; group: GroupChat; personaId: string | null; fingerprint: string }
interface Lease { taskId: string; controller: AbortController }
interface Deps {
  ensure(scope: SpatialGroupScope): Promise<SpatialGroupAiSession>
  load(id: string): SpatialGroupAiSession
  save(state: SpatialGroupAiSession): void
  context(scope: SpatialGroupScope): Promise<Context>
  active: Map<string, Lease>
  deleted: Set<string>
  publish(scope: SpatialGroupScope): void
  complete(params: ChatParams, signal: AbortSignal, timeout: number): Promise<AICompletion>
  isDirectPending(scope: SpatialGroupScope): boolean
}
const bodyOf = (content: string) => stripAllThinking(content).trim()
const registered = (batch: SpatialGroupDialogueBatch) => batch.generations.filter(item => item.state === 'registered')

/** 持久化批次与队列；登记和关闭只写检查点，不等待模型。 */
export function createSpatialGroupDialogueQueue(deps: Deps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const draining = new Map<string, Promise<void>>()
  const keyOf = (scope: SpatialGroupScope) => hashSpatialValue(scope)
  async function sourceError(scope: SpatialGroupScope, state: SpatialGroupAiSession, batch: SpatialGroupDialogueBatch): Promise<string | null> {
    if (!isSpatialBoardEnabled(await sessionFor(scope))) return SPATIAL_DISABLED_REASON
    const context = await deps.context(scope), snapshot = await snapshotLocked(scope)
    if (context.session.spatialNarrativeSyncPolicy !== 'suggest' || context.session.spatialContextEnabled === false) return '剧情同步或位置读取已关闭'
    if (context.session.spatialAiSessionId !== state.id || !snapshot || snapshot.version.bindingEpoch !== batch.snapshot.version.bindingEpoch || snapshot.version.worldId !== batch.snapshot.version.worldId) return '画板绑定已改变'
    if (context.fingerprint !== batch.contextFingerprint) return '群聊成员、身份、模式或连接配置已改变'
    if (state.groupDialogueBatches?.some(item => item.sequence > batch.sequence && registered(item).length > 0)) return '已被更新的剧情批次取代'
    const messages = groupData.readMessages(scope.groupId, scope.sessionId)
    const user = messages.filter(item => item.characterId === '__user__').at(-1)
    if ((user?.id ?? null) !== batch.userMessageId || bodyOf(user?.content ?? '') !== batch.userText) return '来源用户输入已修改、删除或被新输入取代'
    for (const generation of registered(batch)) {
      const saved = messages.filter(item => item.spatialGroupGenerationId === generation.id)
      if (saved.length !== generation.messageIds.length) return '来源正文批次已修改或删除'
      for (let index = 0; index < generation.messageIds.length; index++) {
        const message = messages.find(item => item.id === generation.messageIds[index])
        if (!message || !message.spatialGroupComplete || message.spatialGroupGenerationId !== generation.id || message.generationError || message.generationNotice || hashSpatialValue(bodyOf(message.content)) !== generation.bodyHashes[index]) return '来源正文已修改、删除或重生成'
      }
    }
    return null
  }
  function invalidate(state: SpatialGroupAiSession, batch: SpatialGroupDialogueBatch, reason: string) {
    for (const task of state.tasks.filter(item => item.dialogueId === batch.id && ['queued','running'].includes(item.state))) {
      task.state = reason.includes('已关闭') ? 'cancelled' : 'superseded'; task.error = reason; task.completedAt = Date.now()
      if (deps.active.get(state.id)?.taskId === task.id) deps.active.get(state.id)?.controller.abort()
    }
    for (const proposal of state.proposals.filter(item => item.dialogueId === batch.id)) {
      if (proposal.status === 'pending' || (proposal.status === 'stale' && proposal.canReview)) { proposal.status = 'stale'; proposal.staleReason = reason; proposal.canReview = false }
      if (proposal.status === 'applied' && /来源|成员|身份|模式/.test(reason)) { proposal.sourceChanged = true; proposal.staleReason = reason }
    }
  }
  async function refresh(scope: SpatialGroupScope, state: SpatialGroupAiSession) {
    const before = hashSpatialValue(state)
    for (const batch of state.groupDialogueBatches ?? []) {
      const reason = await sourceError(scope, state, batch)
      if (reason) invalidate(state, batch, reason)
    }
    const snapshot = await snapshotLocked(scope)
    for (const proposal of state.proposals.filter(item => item.mode === 'dialogue_sync' && item.status === 'pending')) {
      if (hashSpatialValue(snapshot?.version) !== hashSpatialValue(proposal.baseVersion)) {
        proposal.status = 'stale'; proposal.staleReason = '画板版本已改变，请按当前位置重新核对'; proposal.canReview = true
      }
    }
    if (before !== hashSpatialValue(state)) deps.save(state)
    return state
  }
  async function register(scope: SpatialGroupScope, generationId: string, messageIds: string[]) {
    safeId(generationId)
    if (!Array.isArray(messageIds) || messageIds.length > 200 || new Set(messageIds).size !== messageIds.length) throw new Error('正文检查点列表无效')
    messageIds.forEach(safeId)
    await spatialRepository.locked(async () => {
      const state = await deps.ensure(scope), batch = state.groupDialogueBatches?.find(item => item.generations.some(generation => generation.id === generationId))
      const generation = batch?.generations.find(item => item.id === generationId)
      if (!batch || !generation) return
      if (generation.state === 'registered') {
        if (hashSpatialValue(generation.messageIds) !== hashSpatialValue(messageIds)) throw new Error('同一生成的正文列表不一致')
        return
      }
      if (generation.state !== 'awaiting_body' || batch.closed) return
      const messages = groupData.readMessages(scope.groupId, scope.sessionId)
      const saved = messages.filter(item => item.spatialGroupGenerationId === generationId)
      const chosen = messageIds.map(id => messages.find(item => item.id === id))
      if (!messageIds.length || saved.length !== messageIds.length || chosen.some(item => !item || item.groupId !== scope.groupId || !batch.memberIds.includes(item.characterId) || !item.spatialGroupComplete || item.spatialGroupGenerationId !== generationId || item.generationError || item.generationNotice || !bodyOf(item.content) || item.content === '(无回复)' || (item.narrativeMode ?? 'immersive') !== batch.narrativeMode || (generation.targetCharacterId && item.characterId !== generation.targetCharacterId))) {
        generation.state = 'ignored'; deps.save(state); return
      }
      // 保存顺序来自磁盘，不能用通知的任意顺序拼接行动。
      const diskIds = saved.map(item => item.id)
      if (hashSpatialValue(diskIds) !== hashSpatialValue(messageIds)) throw new Error('正文顺序与磁盘批次不一致')
      generation.state = 'registered'; generation.messageIds = diskIds; generation.bodyHashes = chosen.map(item => hashSpatialValue(bodyOf(item!.content)))
      await refresh(scope, state); deps.save(state)
    })
    deps.publish(scope)
  }
  async function close(scope: SpatialGroupScope, batchId: string) {
    safeId(batchId)
    await spatialRepository.locked(async () => {
      const state = await deps.ensure(scope), batch = state.groupDialogueBatches?.find(item => item.id === batchId)
      if (!batch || batch.closed) return
      // 处理“正文已落盘、通知尚未到达”的中断窗口，只读取主进程签入的检查点。
      const messages = groupData.readMessages(scope.groupId, scope.sessionId)
      for (const generation of batch.generations.filter(item => item.state === 'awaiting_body')) {
        const tagged = messages.filter(item => item.spatialGroupGenerationId === generation.id)
        const saved = tagged.filter(item => item.spatialGroupComplete && !item.generationNotice && !item.generationError)
        if (saved.length && saved.length === tagged.length && saved.every(item => batch.memberIds.includes(item.characterId) && (item.narrativeMode ?? 'immersive') === batch.narrativeMode && (!generation.targetCharacterId || item.characterId === generation.targetCharacterId) && bodyOf(item.content) && item.content !== '(无回复)')) {
          generation.state = 'registered'; generation.messageIds = saved.map(item => item.id); generation.bodyHashes = saved.map(item => hashSpatialValue(bodyOf(item.content)))
        } else generation.state = 'ignored'
      }
      batch.closed = true
      batch.sourceFingerprint = hashSpatialValue(registered(batch).map(item => ({ id: item.id, messageIds: item.messageIds, bodyHashes: item.bodyHashes })))
      if (registered(batch).length) state.tasks.push({ id: randomUUID(), requestHash: batch.sourceFingerprint, mode: 'dialogue_sync', dialogueId: batch.id, state: 'queued', startedAt: Date.now() })
      await refresh(scope, state); deps.save(state)
    })
    deps.publish(scope); kick(scope)
  }
  async function run(scope: SpatialGroupScope) {
    const prepared = await spatialRepository.locked(async () => {
      if (!isSpatialBoardEnabled(await sessionFor(scope))) return null
      const session = await sessionFor(scope)
      if (!session.spatialAiSessionId) return null
      const state = await refresh(scope, await deps.ensure(scope))
      if (deps.active.has(state.id) || deps.isDirectPending(scope)) return null
      const task = state.tasks.find(item => item.mode === 'dialogue_sync' && item.state === 'queued')
      if (!task) return null
      const batch = state.groupDialogueBatches!.find(item => item.id === task.dialogueId)!
      try {
        const snapshot = await snapshotLocked(scope)
        if (hashSpatialValue(snapshot?.version) !== hashSpatialValue(batch.snapshot.version)) throw new Error('发送时画板版本已改变，请核对当前位置')
        const core = batch.snapshot as SpatialCoreState & typeof batch.snapshot
        const actors = { members: core.world.actors.filter(item => item.externalRef.type === 'qingyu-character' && batch.memberIds.includes(item.externalRef.id)).map(item => item.id), persona: core.world.actors.find(item => item.externalRef.type === 'qingyu-persona' && item.externalRef.id === batch.personaId)?.id }
        const allowed = [...actors.members, actors.persona]
        const messages = groupData.readMessages(scope.groupId, scope.sessionId)
        const ordered = registered(batch).flatMap(generation => generation.messageIds.map(id => messages.find(item => item.id === id)!))
        const body = ordered.map(message => `【${core.world.actors.find(actor => actor.externalRef.id === message.characterId)?.displayName ?? '群聊叙事'}】\n${bodyOf(message.content)}`).join('\n\n')
        const settings = readChatSettings(), profile = resolveChatProfile(settings)
        if (!profile?.model || !profile.baseUrl) throw new Error('当前聊天连接不可用')
        const plan = resolveGenerationTaskBudget({ task: 'spatial_dialogue_sync', model: profile.model, userHardCap: 2048, profileOverride: enabledProfileOverride(profile.capabilityOverride), reasoningLevel: 'off' })
        let targets = core.world.nodes.filter(node => !node.tags.includes('system:offstage')).map(node => ({ id: node.id, boardId: node.boardId, name: node.name, path: spatialNodePath(core, node.id) }))
        const cropped: string[] = []
        if (countTokens(JSON.stringify(targets), profile.model) > 2000) {
          targets = targets.filter(node => spatialDialogueMentionsPlace(node.name, core, actors, { user: batch.userText, assistant: body, narrativeMode: batch.narrativeMode }) || core.runtime.placements.some(item => item.anchor.nodeId === node.id))
          cropped.push('地图索引按完整正文检索，正文不裁剪')
          if (countTokens(JSON.stringify(targets), profile.model) > 2000) throw new Error('本批地点索引超出预算，请分段核对')
        }
        const params: ChatParams = { requestId: task.id, provider: profile.provider as ChatParams['provider'], apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model,
          messages: [{ role: 'system', content: SPATIAL_DIALOGUE_PROMPT + '\n本轮为群聊已保存正文批次。assistant 按生成和落盘顺序排列，各段保留发言者。结合全文取各人物最终明确位置；矛盾且无法按行动顺序消解的证据写 unresolved，不按回包先后决定。同群不等于同地，群外人物不能移动。每个 actorId 在 changes 与 unresolved 合计最多出现一次：同一行动同时出现在用户说明和角色正文时合并为一个候选，优先引用完整角色正文。semanticPosition.note 必须是该候选 evidence 字符串中的连续原文，不能从其他证据拼入，不确定则填写空串。' }, { role: 'user', content: JSON.stringify({ mode: 'dialogue_sync', worldName: core.world.name, groupMode: batch.mode, narrativeMode: batch.narrativeMode,
            allowedActors: core.world.actors.filter(actor => allowed.includes(actor.id)).map(actor => ({ id: actor.id, name: actor.displayName, kind: actor.id === actors.persona ? 'persona' : 'character' })), placements: core.runtime.placements.filter(item => allowed.includes(item.actorId)).map(item => ({ actorId: item.actorId, boardId: item.boardId, nodeId: item.anchor.nodeId, semanticPosition: item.semanticPosition })), targets, user: batch.userText, assistant: body }) }],
          stream: false, temperature: 0.1, topP: 1, maxTokens: plan.requestMaxTokens, frequencyPenalty: 0, presencePenalty: 0,
          reasoningGate: { level: plan.reasoningGate.level, knob: plan.reasoningGate.knob, tokens: plan.reasoningGate.gateTokens }, observability: { source: 'aux', taskType: plan.task, characterId: `group:${scope.groupId}`, sessionId: scope.sessionId } }
        const inputTokens = countTokens(JSON.stringify(params.messages), profile.model)
        if (inputTokens + plan.requestMaxTokens + 128 > resolveEffectiveContextLimit({ model: profile.model, profileMaxContext: profile.maxContext, capabilityOverride: profile.capabilityOverride })) throw new Error('群聊完整批次超出提取预算，不会裁剪正文后移动人物')
        const controller = new AbortController(); deps.active.set(state.id, { taskId: task.id, controller })
        task.state = 'running'; task.startedAt = Date.now(); task.model = profile.model; task.profileId = settings.activeProfileId ?? undefined; task.inputTokens = inputTokens; task.croppedSources = cropped
        deps.save(state)
        return { state, task, batch, core, actors, body, targets, params, controller }
      } catch (error) {
        deps.active.delete(state.id); task.state = 'failed'; task.error = error instanceof Error ? error.message : String(error); task.completedAt = Date.now(); deps.save(state); return null
      }
    })
    deps.publish(scope)
    if (!prepared) return
    const { state, task, batch, params, controller } = prepared
    let expired = false
    let rejectAbort!: (error: Error) => void
    const abort = () => rejectAbort(new Error(expired ? '剧情提取超时，请显式重新提取' : '剧情提取已停止'))
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    controller.signal.addEventListener('abort', abort, { once: true })
    const deadline = setTimeout(() => { expired = true; controller.abort() }, 45000)
    try {
      const completion = await Promise.race([deps.complete(params, controller.signal, 45000), cancelled])
      if (controller.signal.aborted || !completion.text.trim() || completion.finishReason !== 'stop') throw new Error('剧情提取输出不完整或已停止，请显式重新提取')
      const reply = parseSpatialDialogueReply(stripAllThinking(completion.text), prepared.core, prepared.actors, { user: batch.userText, assistant: prepared.body, narrativeMode: batch.narrativeMode }, prepared.targets.map(item => item.id))
      await spatialRepository.locked(async () => {
        if (deps.deleted.has(state.id) || deps.active.get(state.id)?.controller !== controller) return
        const latest = deps.load(state.id), current = latest.tasks.find(item => item.id === task.id)!
        if (current.state !== 'running') return
        const reason = await sourceError(scope, latest, batch)
        if (reason) { invalidate(latest, batch, reason); deps.save(latest); return }
        current.state = 'completed'; current.completedAt = Date.now(); current.elapsedMs = current.completedAt - current.startedAt; current.outputTokens = completion.usage?.completionTokens ?? countTokens(completion.text, params.model); current.inputTokens = completion.usage?.promptTokens ?? current.inputTokens
        const conflict = hashSpatialValue((await snapshotLocked(scope))?.version) !== hashSpatialValue(batch.snapshot.version)
        const proposal: SpatialAiProposal = { id: randomUUID(), commitId: randomUUID(), mode: 'dialogue_sync', dialogueId: batch.id, status: conflict ? 'stale' : 'pending',
          ...(conflict ? { staleReason: '提取期间画板已更新，请按当前位置重新核对' } : {}), canReview: conflict, explanation: '群聊本批剧情的位置建议，确认后生效', summary: reply.summary, unresolved: reply.unresolved,
          evidence: reply.evidence, dialogueCandidates: reply.candidates, comparisons: reply.candidates.filter(item => item.eligible && item.targetNodeId).map(item => ({ actorName: prepared.core.world.actors.find(actor => actor.id === item.actorId)!.displayName, currentPath: spatialNodePath(prepared.core, prepared.core.runtime.placements.find(placement => placement.actorId === item.actorId)?.anchor.nodeId), targetPath: spatialNodePath(prepared.core, item.targetNodeId) })),
          commands: reply.commands, baseVersion: batch.snapshot.version, sourceFingerprint: batch.sourceFingerprint!, personaId: batch.personaId, sourceOptions: { text: '', loreEntryIds: [] }, sources: [{ id: 'user', label: '本批用户输入', kind: 'message', text: batch.userText }, { id: 'assistant', label: '有序已保存群聊正文', kind: 'message', text: prepared.body }], createdAt: Date.now() }
        if (reply.commands.length || reply.unresolved.length) latest.proposals.push(proposal)
        latest.messages.push({ id: randomUUID(), role: 'assistant', mode: 'dialogue_sync', content: reply.commands.length ? `群聊剧情：${reply.summary.join('；')}。需确认后应用。` : reply.unresolved.length ? `本批位置未采用：${reply.unresolved.join('；')}` : '本批没有新的已完成位置变化。', ...(reply.commands.length || reply.unresolved.length ? { proposalId: proposal.id } : {}), createdAt: Date.now() })
        deps.save(latest)
      })
    } catch (error) {
      await spatialRepository.locked(() => {
        if (deps.deleted.has(state.id) || deps.active.get(state.id)?.controller !== controller) return
        const latest = deps.load(state.id), current = latest.tasks.find(item => item.id === task.id)!
        if (current.state === 'running') { current.state = controller.signal.aborted && !expired ? 'cancelled' : 'failed'; current.error = error instanceof Error ? error.message.slice(0,500) : String(error); current.completedAt = Date.now(); deps.save(latest) }
      })
    } finally {
      clearTimeout(deadline); controller.signal.removeEventListener('abort', abort)
      const owns = deps.active.get(state.id)?.controller === controller
      if (owns) deps.active.delete(state.id)
      deps.publish(scope)
      if (owns && !deps.deleted.has(state.id) && deps.load(state.id).tasks.some(item => item.state === 'queued')) kick(scope)
    }
  }
  function kick(scope: SpatialGroupScope) {
    const key = keyOf(scope)
    if (timers.has(key)) return
    timers.set(key, setTimeout(() => { timers.delete(key); void drain(scope).catch(() => deps.publish(scope)) }, 0))
  }
  function drain(scope: SpatialGroupScope): Promise<void> {
    const key = keyOf(scope), previous = draining.get(key)
    if (previous) return previous
    const timer = timers.get(key); if (timer) clearTimeout(timer); timers.delete(key)
    const promise = run(scope).finally(() => { if (draining.get(key) === promise) draining.delete(key) })
    draining.set(key, promise); return promise
  }
  return {
    refresh, sourceError, register, close, kick, drain,
    suspend() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); draining.clear() },
    cancelScope(scope: SpatialGroupScope) {
      const key = keyOf(scope), timer = timers.get(key)
      if (timer) clearTimeout(timer)
      timers.delete(key); draining.delete(key)
    },
    async capture(scope: SpatialGroupScope, input: SpatialGroupDialogueCapture): Promise<string | null> {
      if (!isSpatialBoardEnabled(await sessionFor(scope))) return null
      safeId(input.generationId); safeId(input.burstId)
      if (!['normal','regenerate'].includes(input.kind)) throw new Error('群聊生成类型无效')
      return spatialRepository.locked(async () => {
        const context = await deps.context(scope)
        if (!isSpatialBoardEnabled(await sessionFor(scope)) || context.session.spatialNarrativeSyncPolicy !== 'suggest' || context.session.spatialContextEnabled === false || !context.session.spatialWorldId) return null
        if (input.targetCharacterId && !context.group.memberIds.includes(input.targetCharacterId)) throw new Error('生成目标不属于当前群聊')
        const state = await deps.ensure(scope), snapshot = await snapshotLocked(scope)
        if (!snapshot || hashSpatialValue(input.expectedVersion) !== hashSpatialValue(snapshot.version)) return null
        state.groupDialogueBatches ??= []
        let batch = state.groupDialogueBatches.find(item => item.id === input.burstId)
        const duplicate = state.groupDialogueBatches.find(item => item.generations.some(generation => generation.id === input.generationId))
        if (duplicate) { if (duplicate.id !== input.burstId) throw new Error('生成 ID 已用于其他批次'); return duplicate.id }
        if (batch?.closed) throw new Error('剧情批次已经结束')
        if (batch && (batch.contextFingerprint !== context.fingerprint || hashSpatialValue(batch.snapshot.version) !== hashSpatialValue(snapshot.version))) throw new Error('接力期间空间或参与者已改变，请结束原批次')
        if (!batch) {
          const user = groupData.readMessages(scope.groupId, scope.sessionId).filter(item => item.characterId === '__user__').at(-1)
          state.dialogueSequence = (state.dialogueSequence ?? 0) + 1
          batch = { id: input.burstId, sequence: state.dialogueSequence, kind: input.kind, closed: false, mode: context.group.chatMode, narrativeMode: context.session.narrativeMode ?? 'immersive', memberIds: [...context.group.memberIds], personaId: context.personaId, contextFingerprint: context.fingerprint, snapshot, userMessageId: user?.id ?? null, userText: bodyOf(user?.content ?? ''), generations: [], createdAt: Date.now() }
          state.groupDialogueBatches.push(batch)
        }
        if (batch.generations.length >= 200) throw new Error('接力批次过长，请交还用户后继续')
        batch.generations.push({ id: input.generationId, targetCharacterId: input.targetCharacterId, state: 'awaiting_body', messageIds: [], bodyHashes: [] })
        await refresh(scope, state); deps.save(state); captureGroupSpatialCheckpoint(input.generationId, scope.groupId, scope.sessionId)
        return batch.id
      })
    },
    async retry(scope: SpatialGroupScope, taskId: string) {
      await spatialRepository.locked(async () => {
        const state = await refresh(scope, await deps.ensure(scope)), old = state.tasks.find(item => item.id === taskId)
        if (!old?.dialogueId || !['failed','interrupted'].includes(old.state)) throw new Error('该群聊剧情任务不能重新提取')
        const batch = state.groupDialogueBatches!.find(item => item.id === old.dialogueId)!, reason = await sourceError(scope, state, batch)
        if (reason) throw new Error(reason)
        if (hashSpatialValue((await snapshotLocked(scope))?.version) !== hashSpatialValue(batch.snapshot.version)) throw new Error('画板版本已改变，请用新正文核对')
        if (state.tasks.some(item => item.dialogueId === batch.id && ['queued','running','completed'].includes(item.state))) throw new Error('该批次已有结果或正在处理')
        state.tasks.push({ id: randomUUID(), requestHash: old.requestHash, dialogueId: batch.id, mode: 'dialogue_sync', state: 'queued', startedAt: Date.now() }); deps.save(state)
      })
      deps.publish(scope); kick(scope)
    },
    async recover() {
      const directory = join(DIRS.spatial(), 'ai-sessions')
      if (!existsSync(directory)) return
      for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
        const raw = readSpatialJson<SpatialGroupAiSession>(join(directory, file))
        if (raw?.scope?.kind !== 'group') continue
        const scope = { kind: 'group' as const, groupId: raw.scope.groupId, sessionId: raw.scope.sessionId }
        const session = await sessionFor(scope).catch(() => null)
        if (session?.spatialAiSessionId !== raw.id) continue
        for (const batch of raw.groupDialogueBatches ?? []) if (!batch.closed) await close(scope, batch.id)
        await spatialRepository.locked(async () => refresh(scope, await deps.ensure(scope)))
        kick(scope)
      }
    },
  }
}
