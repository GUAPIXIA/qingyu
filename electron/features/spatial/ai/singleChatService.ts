import { trimFeatureHistory } from '../../../../shared/featureHistory'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { applyCommandBatch, createEmptyRuntime, createWorldWithDefaults, type SpatialCoreState, type SpatialCommand } from '@qingyu/spatial-core'
import type { AICompletion, ChatParams, Persona } from '../../../../shared/types'
import type { SpatialAiProposal, SpatialAiRequest, SpatialAiSession, SpatialInitializationSources, SpatialProposalReviewInput, SpatialSource } from '../../../../shared/spatial-ai'
import type { SpatialCommitReceipt, SpatialEditorCommit, SpatialSnapshot } from '../../../../shared/spatial'
import { stripAllThinking } from '../../../../shared/thoughtMarkup'
import { resolveSessionPersonaFields } from '../../../../shared/personaResolution'
import { resolveMessageSpeakerKind } from '../../../../shared/messageIdentity'
import { resolveGenerationTaskBudget } from '../../../../shared/generationTaskBudget'
import { enabledProfileOverride, resolveEffectiveContextLimit } from '../../../../shared/modelOutputProfile'
import { chatData } from '../../chat/chatData'
import { withChatMessageLock } from '../../chat/chatRepository'
import { getCharacter } from '../../../services/charCard'
import { listLorebookViews } from '../../../services/lorebookDocumentStore'
import { DIRS, readJson, writeJson } from '../../../services/storage'
import { safeId } from '../../../utils/pathGuard'
import { readChatSettings, resolveChatProfile } from '../../../services/chatConnection'
import { countTokens } from '../../../services/tokenizer'
import { hashSpatialValue, readSpatialJson, spatialPaths, worldFingerprint, type SpatialScope } from '../repository'
import { chatActors, sessionFor, snapshotLocked, spatialRepository, spatialService, stateFor, type SpatialCompanion } from '../commitService'
import { assertInitializationPreview, initializationCommands, isBlankSpatial, parseSpatialAiReply, spatialAiSystemPrompt } from './protocol'
import { spatialGroupAiService } from './groupChatService'
import { createSpatialDialogueQueue } from '../dialogue/queue'
import { reviewDialogueCandidates, spatialAutomaticReason, spatialNodePath } from '../dialogue/protocol'
import { assertSpatialBoardEnabled, cancelSpatialWork } from '../board'
import { canonicalSpatialPlaceName, spatialDialogueReference } from '../placeNames'

const coreOf = (snapshot: SpatialSnapshot): SpatialCoreState => snapshot as SpatialCoreState & SpatialSnapshot
const listeners = new Set<(scope: SpatialScope) => void>()
const publish = (scope: SpatialScope) => { for (const listener of listeners) listener(scope) }

function saveAi(state: SpatialAiSession): void {
  trimFeatureHistory(state)
  if (Buffer.byteLength(JSON.stringify(state)) > 5 * 1024 * 1024) throw new Error('画板助手记录过大，请缩小初始化来源或处理待确认提案')
  state.updatedAt = Date.now()
  writeJson(spatialPaths.ai(state.id), state)
}
function loadAi(id: string): SpatialAiSession {
  const state = readSpatialJson<SpatialAiSession>(spatialPaths.ai(safeId(id)))
  if (!state || state.schemaVersion !== 1 || state.id !== id || !Array.isArray(state.messages) ||
    !Array.isArray(state.proposals) || !Array.isArray(state.tasks) || !state.scope) throw new Error('画板助手记录缺失或损坏，请恢复数据')
  return state
}

async function collectSources(scope: SpatialScope, options: { text: string; loreEntryIds: string[] }) {
  const session = await sessionFor(scope)
  const character = getCharacter(scope.characterId)
  if (!character) throw new Error('当前聊天角色不存在')
  const settings = readChatSettings()
  const personas = readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []
  const identity = resolveSessionPersonaFields(session, settings, personas)
  const persona = personas.find(item => item.id === identity.activePersonaId) ?? null
  const messages = chatData.readMessages(scope.characterId, scope.sessionId)
    .filter(message => message.role !== 'system' && stripAllThinking(message.content).trim())
  const sourceMessages = [...messages.slice(-12).reverse()]
  const firstAssistant = messages.find(message => message.role === 'assistant')
  if (firstAssistant && !sourceMessages.some(message => message.id === firstAssistant.id)) sourceMessages.push(firstAssistant)
  const sources: SpatialSource[] = []
  if (options.text.trim()) sources.push({ id: 'instruction', label: '本次场景说明', kind: 'instruction', text: options.text.trim(), speaker: { role: 'user' } })
  for (const message of sourceMessages) sources.push({ id: `message:${message.id}`, label: `${message.role === 'user' ? identity.userName : character.name} · ${message === firstAssistant ? '实际选中开场/首条正文' : '已保存正文'}`,
    kind: 'message', text: stripAllThinking(message.content), speaker: { role: resolveMessageSpeakerKind(message) === 'narrator' ? 'narrator' : message.role === 'user' ? 'user' : 'character', characterId: message.role === 'assistant' ? character.id : undefined } })
  if (character.scenario) sources.push({ id: 'character:scenario', label: '角色场景设定', kind: 'character', text: character.scenario, subject: { kind: 'character', id: character.id } })
  if (character.description) sources.push({ id: 'character:description', label: '角色描述', kind: 'character', text: character.description, subject: { kind: 'character', id: character.id } })
  if (persona) sources.push({ id: `persona:${persona.id}`, label: `${persona.name} · 用户身份`, kind: 'persona', text: `${persona.description}\n${persona.persona}`, subject: { kind: 'persona', id: persona.id } })
  const activeBooks = session.lorebookIds ?? character.boundLorebookIds ?? (character.lorebookId ? [character.lorebookId] : [])
  const books = (await listLorebookViews(DIRS.lorebooks())).filter(book => book.enabled && activeBooks.includes(book.id))
  const loreEntries = books.flatMap(book => book.entries.filter(entry => entry.enabled).map(entry => ({ id: `${book.id}:${entry.id}`, label: `${book.name} / ${entry.keywords.join('、') || entry.id}`, text: entry.content })))
  for (const id of options.loreEntryIds) {
    const entry = loreEntries.find(entry => entry.id === id)
    if (!entry) throw new Error('选中的世界书条目已停用或不属于当前聊天')
    sources.push({ id: `lorebook:${entry.id}`, label: entry.label, kind: 'lorebook', text: entry.text })
  }
  return { session, character, persona, personaId: persona?.id ?? null, sources,
    loreEntries: loreEntries.map(({ id, label }) => ({ id, label })),
    fingerprint: hashSpatialValue({ characterId: character.id, characterName: character.name, personaId: persona?.id ?? null,
      sources, selectedMessages: sourceMessages.map(message => ({ id: message.id, content: message.content })) }) }
}

function fitSources(sources: SpatialSource[], budget: number, model: string): SpatialSource[] {
  const selected: SpatialSource[] = []
  let remaining = budget
  for (const source of sources) {
    const tokens = countTokens(source.text, model)
    if (tokens <= remaining) { selected.push(source); remaining -= tokens; continue }
    if (remaining < 80) { selected.push({ ...source, text: '', cropped: true }); continue }
    let low = 0; let high = source.text.length
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (countTokens(source.text.slice(0, mid), model) <= remaining) low = mid; else high = mid - 1 }
    selected.push({ ...source, text: source.text.slice(0, low), cropped: true }); remaining = 0
  }
  return selected
}

export function createSpatialAiService(deps: { complete: (params: ChatParams, signal: AbortSignal, timeout: number) => Promise<AICompletion> } = {
  complete: async (params, signal, timeout) => { const { chatWithRetry, getAdapter } = await import('../../../services/ai'); return chatWithRetry(getAdapter(params.provider), params, () => {}, signal, 0, undefined, timeout) },
}) {
  const active = new Map<string, { taskId: string; controller: AbortController }>()
  const deleted = new Set<string>()
  const deletedScopes = new Set<string>()
  const directPending = new Map<string, number>()
  let restoring = false
  let restoreEpoch = 0

  const ensureLocked = async (scope: SpatialScope): Promise<SpatialAiSession> => {
    if (restoring) throw new Error('正在恢复数据，请稍后重试画板请求')
    if (deletedScopes.has(hashSpatialValue(scope))) throw new Error('当前单聊已删除，不能恢复旧助手请求')
    const session = await sessionFor(scope)
    const snapshot = await snapshotLocked(scope)
    const identity = { ...scope, worldId: snapshot?.version.worldId ?? null, runtimeId: snapshot?.version.runtimeId ?? null, bindingEpoch: snapshot?.version.bindingEpoch ?? null }
    if (session.spatialAiSessionId) {
      const state = loadAi(session.spatialAiSessionId)
      if (state.scope.characterId !== scope.characterId || state.scope.sessionId !== scope.sessionId) throw new Error('画板助手记录属于其他单聊，不能恢复到当前会话')
      if (hashSpatialValue(state.scope) === hashSpatialValue(identity)) {
        const interrupted = state.tasks.filter(task => task.state === 'running' && active.get(state.id)?.taskId !== task.id)
        const unfinished = state.proposals.filter(proposal => proposal.automatic?.status === 'applying' &&
          state.tasks.find(task => task.id === active.get(state.id)?.taskId)?.dialogueId !== proposal.dialogueId)
        if (interrupted.length || unfinished.length) {
          for (const task of interrupted) { task.state = 'interrupted'; task.error = '请求在上次运行中中断，结果未知；不会自动重发模型请求' }
          for (const proposal of unfinished) {
            proposal.automatic = { status: 'skipped', reason: '自动应用在上次运行中中断，本次更新已跳过' }
            proposal.status = 'discarded'; proposal.discardReason = proposal.automatic.reason; proposal.canReview = false
          }
          saveAi(state)
        }
        return state
      }
    }
    const now = Date.now()
    const state: SpatialAiSession = { schemaVersion: 1, id: randomUUID(), scope: identity, messages: [], proposals: [], tasks: [], createdAt: now, updatedAt: now }
    saveAi(state)
    await chatData.attachSpatialAiSession(scope.characterId, scope.sessionId,
      { worldId: session.spatialWorldId ?? null, runtimeId: session.spatialRuntimeId ?? null, aiSessionId: session.spatialAiSessionId ?? null }, state.id)
    return state
  }

  const syncActors = async (scope: SpatialScope, personaId: string | null) => {
    const snapshot = await spatialService.loadBound(scope.characterId, scope.sessionId)
    if (!snapshot) return
    const core = coreOf(snapshot)
    const merged = chatActors(core.world, scope.characterId, personaId)
    const added = merged.actors.filter(actor => !core.world.actors.some(old => old.id === actor.id))
    if (!added.length) return
    const result = await spatialService.applyEditorBatch(scope.characterId, scope.sessionId, { commitId: randomUUID(), ...snapshot.version,
      expectedRuntimeRevision: snapshot.version.runtimeRevision, expectedWorldFingerprint: snapshot.version.worldFingerprint,
      commands: added.map(payload => ({ type: 'create_actor', payload })) })
    if (!result.ok) throw new Error(result.message)
  }

  const dialogue = createSpatialDialogueQueue({ ensure: ensureLocked, load: loadAi, save: saveAi, active, deleted, publish, complete: deps.complete,
    autoApply: (scope, proposalId, lease) => apply(scope, proposalId, false, lease),
    isDirectPending: scope => (directPending.get(hashSpatialValue(scope)) ?? 0) > 0,
    persona: async scope => (await collectSources(scope, { text: '', loreEntryIds: [] })).personaId })

  const completeState = (state: SpatialAiSession, proposal: SpatialAiProposal, receipt: SpatialCommitReceipt, snapshot: SpatialSnapshot, automatic = false): SpatialAiSession => {
    const after = structuredClone(state)
    const applied = after.proposals.find(item => item.id === proposal.id)!
    applied.status = 'applied'; applied.appliedVersion = snapshot.version
    if (automatic) applied.automatic = { status: 'applied' }
    else if (applied.automatic) applied.automatic = { status: 'confirmation', reason: '已手动确认' }
    after.scope = { ...after.scope, worldId: snapshot.version.worldId, runtimeId: snapshot.version.runtimeId, bindingEpoch: snapshot.version.bindingEpoch }
    after.messages.push({ id: randomUUID(), role: 'system', mode: 'result', content: `${automatic ? '已自动应用' : '已确认'}：${proposal.summary.join('；') || '初始化空间'}。位置版本 ${receipt.revisionAfter}。`,
      proposalId: proposal.id, createdAt: Date.now() })
    after.updatedAt = Date.now()
    return after
  }

  async function apply(scope: SpatialScope, proposalId: string, acknowledgeUnresolved = false, automatic?: { id: string; controller: AbortController }): Promise<{ state: SpatialAiSession; snapshot: SpatialSnapshot }> {
      const assertLease = async () => {
        assertSpatialBoardEnabled(await sessionFor(scope))
        if (automatic && (restoring || automatic.controller.signal.aborted || active.get(automatic.id)?.controller !== automatic.controller)) throw new Error('自动应用已停止，本轮更新已跳过')
      }
      const prepared = await spatialRepository.locked(async () => {
        await assertLease()
        const state = await dialogue.refresh(scope, await ensureLocked(scope))
        if (automatic && state.id !== automatic.id) throw new Error('自动建议所属画板助手已改变')
        const proposal = state.proposals.find(proposal => proposal.id === proposalId)
        if (!proposal || proposal.status === 'discarded') throw new Error('提案不存在或已忽略')
        if (proposal.status === 'undone') throw new Error('该剧情提交已撤销，不能重复应用')
        if (proposal.status === 'stale') throw new Error(proposal.staleReason ?? '剧情来源已失效')
        if (proposal.status === 'applied') return { done: { state, snapshot: (await snapshotLocked(scope))! } }
        if (!automatic && proposal.automatic?.status === 'applying') throw new Error('正在自动应用，请等待结果后核对')
        if (!proposal.commands.length && proposal.mode === 'dialogue_sync') throw new Error('未解析或未完成动作不能应用；请在画板助手明确指令调整')
        if (proposal.unresolved.length && !acknowledgeUnresolved && !automatic) throw new Error('请先核对草稿中的未明确项')
        const companion: SpatialCompanion = { id: state.id, expectedHash: hashSpatialValue(state),
          validate: async () => {
            await assertLease()
            const session = await sessionFor(scope)
            if (session.spatialAiSessionId !== state.id) throw new Error('提案所属画板助手已改变')
            const data = await collectSources(scope, proposal.sourceOptions)
            if (data.personaId !== proposal.personaId) throw new Error('当前用户身份已改变，请重新核对提案')
            if (proposal.mode === 'dialogue_sync') {
              const generation = state.dialogueGenerations?.find(item => item.id === proposal.dialogueId)
              if (!generation) throw new Error('剧情来源记录缺失')
              const reason = await dialogue.sourceError(scope, state, generation)
              if (reason) throw new Error(reason)
              if (automatic) {
                if (proposal.automatic?.status !== 'applying') throw new Error('自动应用决定已改变，本轮更新已跳过')
                const current = await snapshotLocked(scope)
                if (!current) throw new Error('当前画板绑定已改变')
                const autoReason = spatialAutomaticReason(proposal, generation, coreOf(current), scope.characterId, session.spatialNarrativeSyncPolicy, session.spatialNarrativeSyncEpoch)
                if (autoReason) throw new Error(autoReason)
              }
            } else if (proposal.mode !== 'instruction' && data.fingerprint !== proposal.sourceFingerprint) throw new Error('初始化来源正文或设定已改变，请保留草稿并重新生成核对')
            if (proposal.mode === 'initialize' && proposal.baseVersion) {
              const bound = await snapshotLocked(scope)
              if (!bound || !isBlankSpatial(coreOf(bound))) throw new Error('当前地图已不再是空白状态')
            }
          }, complete: (receipt, snapshot) => completeState(state, proposal, receipt, snapshot, !!automatic) }
        return { state, proposal, companion }
      })
      if ('done' in prepared) return prepared.done!
      const { proposal, companion } = prepared
      let snapshot: SpatialSnapshot
      if (!proposal.baseVersion) {
        if (!proposal.preview || proposal.mode !== 'initialize') throw new Error('未绑定提案无效')
        const preview = coreOf(proposal.preview)
        const base = { world: { ...preview.world, nodes: preview.world.nodes.filter(node => node.tags.includes('system:offstage')),
          boards: preview.world.boards.filter(board => board.id === preview.world.rootBoardId), distances: [] },
          runtime: createEmptyRuntime(preview.world.id, preview.runtime.runtimeId, Date.now()) }
        const commands = initializationCommands(base, preview, false)
        const applied = applyCommandBatch(base, { schemaVersion: 1, expectedRevision: 0, commands }, { source: 'system', now: Date.now(), idGen: randomUUID })
        if (!applied.ok) throw new Error(applied.message)
        snapshot = await spatialService.initializeFromDraft(scope, applied.state, proposal.commitId, proposal.sourceFingerprint, companion)
      } else {
        const version = proposal.baseVersion
        const commit = () => spatialService.applyEditorBatch(scope.characterId, scope.sessionId,
          { commitId: proposal.commitId, worldId: version.worldId, runtimeId: version.runtimeId, bindingEpoch: version.bindingEpoch,
            expectedRuntimeRevision: version.runtimeRevision, expectedWorldFingerprint: version.worldFingerprint, commands: proposal.commands }, companion,
          proposal.mode === 'initialize' ? { sourceFingerprint: proposal.sourceFingerprint } : undefined, proposal.mode === 'dialogue_sync')
        const result = proposal.mode === 'dialogue_sync' ? await withChatMessageLock(scope, commit) : await commit()
        if (!result.ok) throw new Error(result.message)
        snapshot = result.snapshot
      }
      publish(scope)
      return { state: loadAi(companion.id), snapshot }
    }

  return {
    dialogue,
    onUpdated(listener: (scope: SpatialScope) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async disable(scope?: SpatialScope) {
      if (scope) dialogue.cancelScope(scope)
      else dialogue.suspend()
      if (!scope) for (const lease of active.values()) lease.controller.abort()
      await spatialRepository.locked(() => {
        const directory = join(DIRS.spatial(), 'ai-sessions')
        if (!existsSync(directory)) return
        for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
          const raw = readSpatialJson<SpatialAiSession<{ kind?: string; characterId: string; sessionId: string }>>(join(directory, file))
          if (raw && raw.scope.kind !== 'group' && (!scope || (raw.scope.characterId === scope.characterId && raw.scope.sessionId === scope.sessionId))) {
            active.get(raw.id)?.controller.abort()
            saveAi(cancelSpatialWork(loadAi(raw.id)))
          }
        }
      })
    },
    async restore<T>(restore: () => T): Promise<T> {
      if (restoring) throw new Error('正在恢复数据，请等待当前恢复完成')
      restoring = true
      spatialGroupAiService.suspendRestore()
      restoreEpoch += 1; directPending.clear(); dialogue.suspend()
      try {
        for (const lease of active.values()) lease.controller.abort()
        active.clear()
        const result = await spatialRepository.lockedForRestore(restore)
        // 恢复的数据成为新的请求边界；恢复成功后才核对事务与助手来源。
        deleted.clear(); deletedScopes.clear()
        restoring = false
        await spatialService.recoverTransactions(); await dialogue.recover(); spatialGroupAiService.resumeRestore(); await spatialGroupAiService.dialogue.recover(); await spatialService.notifyRestored()
        return result
      } finally { restoring = false; spatialGroupAiService.resumeRestore() }
    },
    deleteScope: (scope: SpatialScope) => spatialRepository.locked(() => {
      dialogue.cancelScope(scope)
      deletedScopes.add(hashSpatialValue(scope))
      const directory = join(DIRS.spatial(), 'ai-sessions')
      if (existsSync(directory)) for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
        const state = loadAi(file.slice(0, -5))
        if (state.scope.characterId !== scope.characterId || state.scope.sessionId !== scope.sessionId) continue
        deleted.add(state.id); active.get(state.id)?.controller.abort(); active.delete(state.id)
        unlinkSync(spatialPaths.ai(state.id))
      }
      for (const path of [spatialPaths.runtime(scope), spatialPaths.state(scope)]) if (existsSync(path)) unlinkSync(path)
    }),
    get: async (scope: SpatialScope) => {
      await dialogue.resumeAutomatic(scope)
      return spatialRepository.locked(async () => dialogue.refresh(scope, await ensureLocked(scope)))
    },
    sources: (scope: SpatialScope): Promise<SpatialInitializationSources> => spatialRepository.locked(async () => {
      const data = await collectSources(scope, { text: '', loreEntryIds: [] })
      const snapshot = await snapshotLocked(scope)
      return { sources: data.sources, loreEntries: data.loreEntries, canInitialize: !snapshot || isBlankSpatial(coreOf(snapshot)),
        sharedSessions: snapshot ? spatialRepository.runtimes().filter(item => item.runtime.worldId === snapshot.version.worldId).length : 0 }
    }),

    async ask(scope: SpatialScope, input: SpatialAiRequest): Promise<SpatialAiSession> {
      assertSpatialBoardEnabled(await sessionFor(scope))
      safeId(input.requestId)
      if (!['initialize', 'instruction', 'positions'].includes(input.mode) || typeof input.text !== 'string' || input.text.length > 12000 ||
        (input.mode === 'instruction' && !input.text.trim()) || (input.loreEntryIds && (!Array.isArray(input.loreEntryIds) || input.loreEntryIds.length > 20 || input.loreEntryIds.some(id => typeof id !== 'string')))) throw new Error('画板助手请求无效')
      const options = { text: input.text.trim(), loreEntryIds: input.loreEntryIds ?? [] }
      const directKey = hashSpatialValue(scope)
      const directEpoch = restoreEpoch
      directPending.set(directKey, (directPending.get(directKey) ?? 0) + 1)
      try {
      const sourceData = await collectSources(scope, options)
      if (restoring || directEpoch !== restoreEpoch) throw new Error('数据已恢复，旧画板请求已取消')
      await syncActors(scope, sourceData.personaId)
      const prepared = await spatialRepository.locked(async () => {
        assertSpatialBoardEnabled(await sessionFor(scope))
        if (directEpoch !== restoreEpoch) throw new Error('数据已恢复，旧画板请求已取消')
        const state = await ensureLocked(scope)
        const requestHash = hashSpatialValue({ mode: input.mode, ...options })
        const oldTask = state.tasks.find(task => task.id === input.requestId)
        if (oldTask) { if (oldTask.requestHash !== requestHash) throw new Error('请求 ID 已用于不同指令'); return { done: state } }
        if (active.has(state.id)) throw new Error('画板助手正在处理上一条请求')
        if (state.proposals.filter(proposal => proposal.status === 'pending').length >= 20) throw new Error('请先处理已有的待确认调整')
        const data = await collectSources(scope, options)
        const bound = await snapshotLocked(scope)
        if (input.mode !== 'initialize' && !bound) throw new Error('请先初始化或绑定世界')
        let core = bound ? coreOf(bound) : { world: chatActors(createWorldWithDefaults(randomUUID(), '场景草稿', { now: Date.now() }), scope.characterId, data.personaId), runtime: null as unknown as SpatialCoreState['runtime'] }
        if (!bound) core = { ...core, runtime: createEmptyRuntime(core.world.id, `single_${scope.sessionId}`, Date.now()) }
        if (input.mode === 'initialize' && !isBlankSpatial(core)) throw new Error('当前地图已有地点或人物位置，不能重新初始化')
        const characterActor = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-character' && actor.externalRef.id === scope.characterId)
        const personaActor = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === data.personaId)
        if (!characterActor) throw new Error('当前聊天角色尚未登记到画板')
        const actors = { character: characterActor.id, ...(personaActor ? { persona: personaActor.id } : {}) }
        const settings = readChatSettings(); const profile = resolveChatProfile(settings)
        if (!profile || !profile.model || !profile.baseUrl) throw new Error('请先配置当前聊天的连接和模型')
        const plan = resolveGenerationTaskBudget({ task: input.mode === 'initialize' ? 'spatial_initialize' : 'spatial_instruction', model: profile.model,
          expectedBodyChars: input.mode === 'initialize' ? 3200 : 1200, userHardCap: input.mode === 'initialize' ? 4096 : 2048,
          profileOverride: enabledProfileOverride(profile.capabilityOverride), reasoningLevel: 'off' })
        let history = state.messages.slice(-12).map(message => ({ role: message.role, content: message.content, mode: message.mode }))
        while (history.length && countTokens(JSON.stringify(history), profile.model) > 1500) history = history.slice(1)
        let map = { worldName: core.world.name, boards: core.world.boards.map(board => ({ id: board.id, name: board.name, parentEntryNodeId: board.parentEntryNodeId })),
          nodes: core.world.nodes.map(node => ({ id: node.id, kind: node.kind, name: node.name, boardId: node.boardId, parentNodeId: node.parentNodeId, childBoardId: node.childBoardId })),
          actors: core.world.actors.filter(actor => [actors.character, actors.persona].includes(actor.id)).map(actor => ({ id: actor.id, name: actor.displayName, kind: actor.kind })),
          placements: core.runtime.placements.filter(placement => [actors.character, actors.persona].includes(placement.actorId)).map(placement => ({ actorId: placement.actorId, boardId: placement.boardId, nodeId: placement.anchor.nodeId, position: placement.semanticPosition })),
          distances: core.world.distances.map(distance => ({ id: distance.id, sourceNodeId: distance.sourceNodeId, targetNodeId: distance.targetNodeId, measurement: distance.measurement })) }
        const cropped: string[] = []
        if (countTokens(JSON.stringify(map), profile.model) > 2000) {
          const selected = new Set(map.nodes.filter(node => input.text.includes(node.name) || map.placements.some(placement => placement.nodeId === node.id)).map(node => node.id))
          let grew = true
          while (grew) { grew = false; for (const node of map.nodes) if (selected.has(node.id) && node.parentNodeId && !selected.has(node.parentNodeId)) { selected.add(node.parentNodeId); grew = true } }
          map = { ...map, nodes: map.nodes.filter(node => selected.has(node.id)), distances: map.distances.filter(distance => selected.has(distance.sourceNodeId) && selected.has(distance.targetNodeId)) }
          cropped.push('远处地图索引：需要调整时请使用完整地点名称')
          if (countTokens(JSON.stringify(map), profile.model) > 2000) throw new Error('目标地图索引超出预算，请缩小指令涉及的范围')
        }
        const envelope = { mode: input.mode, instruction: options.text, allowedActors: actors, currentMap: map, history, sources: [] as SpatialSource[] }
        const systemPrompt = spatialAiSystemPrompt(input.mode)
        const contextLimit = resolveEffectiveContextLimit({ model: profile.model, profileMaxContext: profile.maxContext, capabilityOverride: profile.capabilityOverride })
        const overhead = countTokens(systemPrompt + JSON.stringify(envelope), profile.model) + plan.requestMaxTokens + 512
        const sourceBudget = Math.min(input.mode === 'initialize' ? 6000 : 1200, contextLimit - overhead)
        if (sourceBudget < 200) throw new Error('当前模型上下文预算不足以处理画板请求')
        const requestSources = input.mode !== 'instruction' ? fitSources(data.sources, sourceBudget, profile.model)
          : fitSources(data.sources.filter(source => source.kind === 'instruction'), sourceBudget, profile.model)
        if (input.mode === 'instruction' && requestSources.some(source => source.cropped)) throw new Error('画板指令超出预算，请缩短后重试')
        cropped.push(...requestSources.filter(source => source.cropped).map(source => source.label))
        const params: ChatParams = { requestId: input.requestId, provider: profile.provider as ChatParams['provider'], model: profile.model,
          apiKey: profile.apiKey, baseUrl: profile.baseUrl, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify({ ...envelope, sources: requestSources }) }],
          stream: false, temperature: 0.2, topP: 1, maxTokens: plan.requestMaxTokens, frequencyPenalty: 0, presencePenalty: 0,
          reasoningGate: { level: plan.reasoningGate.level, knob: plan.reasoningGate.knob, tokens: plan.reasoningGate.gateTokens }, observability: { source: 'aux', taskType: plan.task, characterId: scope.characterId, sessionId: scope.sessionId } }
        if (countTokens(JSON.stringify(params.messages), profile.model) + plan.requestMaxTokens + 128 > contextLimit) throw new Error('材料序列化后超出模型上下文预算，请减少来源或缩短指令')
        const controller = new AbortController()
        active.set(state.id, { taskId: input.requestId, controller })
        state.tasks.push({ id: input.requestId, requestHash, mode: input.mode, state: 'running', startedAt: Date.now(),
          profileId: settings.activeProfileId ?? undefined, model: profile.model, inputTokens: countTokens(JSON.stringify(params.messages), profile.model), croppedSources: cropped })
        state.messages.push({ id: randomUUID(), role: 'user', content: input.mode === 'initialize' ? `初始化场景${options.text ? `：${options.text}` : '：使用当前选定设定和正文'}` : options.text,
          mode: input.mode, createdAt: Date.now() })
        try { saveAi(state) } catch (error) { active.delete(state.id); throw error }
        return { state, core, actors, params, requestSources, sourceFingerprint: data.fingerprint, personaId: data.personaId,
          baseVersion: bound?.version ?? null, controller }
      })
      if ('done' in prepared) return prepared.done!
      publish(scope)
      const { state, core, actors, params, requestSources, controller } = prepared
      try {
        const completion = await deps.complete(params, controller.signal, input.mode === 'initialize' ? 90000 : 60000)
        if (controller.signal.aborted) throw new Error('已停止画板助手请求')
        if (completion.finishReason === 'length' || completion.finishReason === 'content_filter' || !completion.text.trim()) throw new Error('画板 AI 输出不完整，请缩小范围后重试')
        const reply = parseSpatialAiReply(stripAllThinking(completion.text), input.mode, core, actors, requestSources, !!prepared.baseVersion, false)
        return await spatialRepository.locked(async () => {
          if (deleted.has(state.id) || active.get(state.id)?.controller !== controller) return state
          const latest = loadAi(state.id)
          const task = latest.tasks.find(task => task.id === input.requestId)!
          if (task.state !== 'running' || controller.signal.aborted || active.get(state.id)?.controller !== controller) return latest
          task.state = 'completed'; task.completedAt = Date.now(); task.elapsedMs = task.completedAt - task.startedAt
          task.outputTokens = completion.usage?.completionTokens ?? countTokens(completion.text, params.model)
          task.inputTokens = completion.usage?.promptTokens ?? task.inputTokens
          const proposalId = randomUUID()
          if (reply.commands.length || reply.preview) latest.proposals.push({ id: proposalId, taskId: input.requestId, commitId: randomUUID(), mode: input.mode, status: 'pending',
            explanation: reply.explanation, summary: reply.summary, unresolved: reply.unresolved, evidence: reply.evidence,
            baseVersion: prepared.baseVersion, sourceFingerprint: prepared.sourceFingerprint, personaId: prepared.personaId,
            sources: requestSources, sourceOptions: options, commands: reply.commands, createdAt: Date.now(),
            ...(reply.preview ? { preview: { ...reply.preview, version: { worldId: reply.preview.world.id, runtimeId: reply.preview.runtime.runtimeId,
              bindingEpoch: `draft_${proposalId}`, runtimeRevision: reply.preview.runtime.revision, worldFingerprint: worldFingerprint(reply.preview.world) } } } : {}) })
          latest.messages.push({ id: randomUUID(), role: 'assistant', content: reply.explanation, mode: input.mode,
            ...(reply.commands.length || reply.preview ? { proposalId } : {}), createdAt: Date.now() })
          saveAi(latest)
          return latest
        })
      } catch (error) {
        return await spatialRepository.locked(() => {
          if (deleted.has(state.id) || active.get(state.id)?.controller !== controller) return state
          const latest = loadAi(state.id); const task = latest.tasks.find(task => task.id === input.requestId)!
          if (task.state === 'running') {
            task.state = controller.signal.aborted ? 'cancelled' : 'failed'; task.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
            task.completedAt = Date.now(); task.elapsedMs = task.completedAt - task.startedAt
            saveAi(latest)
          }
          return latest
        })
      } finally {
        const ownsLease = active.get(state.id)?.controller === controller
        if (ownsLease) active.delete(state.id)
        publish(scope)
        if (ownsLease && !deleted.has(state.id) && loadAi(state.id).tasks.some(task => task.state === 'queued')) dialogue.kick(scope)
      }
      } finally {
        if (directEpoch === restoreEpoch) {
          const count = (directPending.get(directKey) ?? 1) - 1
          if (count) directPending.set(directKey, count); else directPending.delete(directKey)
        }
        const session = await sessionFor(scope).catch(() => null)
        if (session?.spatialAiSessionId && !deleted.has(session.spatialAiSessionId) && loadAi(session.spatialAiSessionId).tasks.some(task => task.state === 'queued')) dialogue.kick(scope)
      }
    },

    async cancel(scope: SpatialScope): Promise<SpatialAiSession> {
      const state = await spatialRepository.locked(async () => {
        const current = await ensureLocked(scope)
        const lease = active.get(current.id)
        lease?.controller.abort()
        const task = current.tasks.find(task => task.id === lease?.taskId)
        if (task) { task.state = 'cancelled'; task.error = '用户停止请求'; saveAi(current) }
        return current
      })
      publish(scope); if (state.tasks.some(task => task.state === 'queued')) dialogue.kick(scope); return state
    },

    async discard(scope: SpatialScope, proposalId: string): Promise<SpatialAiSession> {
      const result = await spatialRepository.locked(async () => {
        const state = await ensureLocked(scope)
        const proposal = state.proposals.find(proposal => proposal.id === proposalId)
        if (!proposal) throw new Error('提案不存在或不属于当前画板助手')
        if (['pending','stale'].includes(proposal.status) && !proposal.replacedById) {
          proposal.status = 'discarded'; proposal.discardReason = '用户忽略本轮建议'
          state.messages.push({ id: randomUUID(), role: 'system', mode: 'result', content: '已忽略：用户忽略本轮建议；相同正文不会再次提议。', proposalId, createdAt: Date.now() })
          saveAi(state)
        }
        return state
      })
      publish(scope); return result
    },

    async targets(scope: SpatialScope) {
      return spatialRepository.locked(async () => {
        await ensureLocked(scope)
        const snapshot = await snapshotLocked(scope)
        if (!snapshot) return []
        const core = coreOf(snapshot)
        return core.world.nodes.filter(node => !node.tags.includes('system:offstage')).map(node => ({ id: node.id, boardId: node.boardId, path: spatialNodePath(core, node.id), canContain: node.kind === 'region' || !!node.childBoardId }))
      })
    },

    async review(scope: SpatialScope, proposalId: string, input: SpatialProposalReviewInput): Promise<SpatialAiSession> {
      const result = await withChatMessageLock(scope, () => spatialRepository.locked(async () => {
        const state = await dialogue.refresh(scope, await ensureLocked(scope)), original = state.proposals.find(item => item.id === proposalId)
        if (!original || original.mode !== 'dialogue_sync' || !['pending','stale'].includes(original.status) || original.replacedById || (original.status === 'stale' && !original.canReview)) throw new Error(original?.staleReason ?? '该剧情建议不能重新核对')
        const generation = state.dialogueGenerations?.find(item => item.id === original.dialogueId)
        if (!generation || !original.dialogueCandidates?.length) throw new Error('原动作依据缺失，请在助手明确指令调整')
        const reason = await dialogue.sourceError(scope, state, generation)
        if (reason) throw new Error(reason)
        if (!input || !input.targets || typeof input.targets !== 'object' || Array.isArray(input.targets) || Object.values(input.targets).some(value => typeof value !== 'string')) throw new Error('地点选择无效')
        const snapshot = (await snapshotLocked(scope))!, core = coreOf(snapshot)
        const character = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-character' && actor.externalRef.id === scope.characterId)
        const persona = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === generation.personaId)
        if (!character) throw new Error('原剧情人物已不存在')
        const reviewed = reviewDialogueCandidates(core, original.dialogueCandidates, input.targets, { character: character.id, persona: persona?.id }, { user: generation.userText, assistant: generation.body!, narrativeMode: generation.narrativeMode })
        const id = randomUUID()
        original.status = 'stale'; original.replacedById = id; original.staleReason = '已生成重新核对的建议'
        state.proposals.push({ ...original, id, commitId: randomUUID(), status: 'pending', replacedById: undefined, staleReason: undefined,
          automatic: original.automatic ? { status: 'confirmation', reason: '重新核对后需再次确认，不自动应用' } : undefined,
          reviewedFromId: original.id, canReview: false, baseVersion: snapshot.version, commands: reviewed.commands, summary: reviewed.summary,
          unresolved: reviewed.unresolved, dialogueCandidates: reviewed.candidates, comparisons: reviewed.comparisons, createdAt: Date.now() })
        state.messages.push({ id: randomUUID(), role: 'system', mode: 'result', content: `已按当前位置重新核对，尚未移动人物：${reviewed.summary.join('；')}。请再次确认。`, proposalId: id, createdAt: Date.now() })
        saveAi(state); return state
      }))
      publish(scope); return result
    },

    async preparePlace(scope: SpatialScope, proposalId: string, name: string, parentId: string | null): Promise<SpatialAiSession> {
      const result = await spatialRepository.locked(async () => {
        const state = await dialogue.refresh(scope, await ensureLocked(scope)), original = state.proposals.find(item => item.id === proposalId)
        if (!original || original.mode !== 'dialogue_sync' || !['pending','stale'].includes(original.status) || original.replacedById || (original.status === 'stale' && !original.canReview)) throw new Error('原剧情建议已失效')
        const generation = state.dialogueGenerations?.find(item => item.id === original.dialogueId)
        if (!generation) throw new Error('原剧情来源缺失')
        const reason = await dialogue.sourceError(scope, state, generation)
        if (reason) throw new Error(reason)
        if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new Error('地点名称须为 1 到 128 个字符')
        const snapshot = (await snapshotLocked(scope))!, core = coreOf(snapshot)
        const actors = { character: core.world.actors.find(actor => actor.externalRef.type === 'qingyu-character' && actor.externalRef.id === scope.characterId)?.id,
          persona: core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === generation.personaId)?.id }
        name = canonicalSpatialPlaceName(name.trim(), core, actors, (original.dialogueCandidates ?? []).map(candidate => spatialDialogueReference(core, actors,
          { user: generation.userText, assistant: generation.body!, narrativeMode: generation.narrativeMode }, candidate.evidenceSource, candidate.evidence)))
        const parent = parentId ? core.world.nodes.find(item => item.id === parentId && !item.tags.includes('system:offstage')) : null
        if (parentId && !parent) throw new Error('上级地点已不存在')
        if (parent && parent.kind !== 'region' && !parent.childBoardId) throw new Error('请选择区域或具有内部画板的地点作为上级')
        const boardId = parent?.childBoardId ?? parent?.boardId ?? core.world.rootBoardId
        const parentNodeId = parent?.childBoardId ? null : parent?.id ?? null
        if (core.world.nodes.some(node => node.boardId === boardId && node.parentNodeId === parentNodeId && node.name === name.trim())) throw new Error('此路径已有同名地点，请选择已有地点')
        const now = Date.now(), id = randomUUID(), nodeId = randomUUID()
        const commands: SpatialCommand[] = [{ type: 'create_node', payload: { id: nodeId, boardId, parentNodeId, childBoardId: null, kind: 'place', name: name.trim(),
          description: '', tags: [], createdAt: now, updatedAt: now, geometry: { x: 80 + core.world.nodes.length % 5 * 220, y: 160 + Math.floor(core.world.nodes.length / 5) * 180 }, iconKey: 'pin' } }]
        const checked = applyCommandBatch(core, { schemaVersion: 1, expectedRevision: core.runtime.revision, commands }, { source: 'user', now, idGen: randomUUID })
        if (!checked.ok) throw new Error(checked.message)
        state.proposals.push({ id, commitId: randomUUID(), mode: 'instruction', status: 'pending', explanation: '手动创建地点；本次不移动人物',
          summary: [`创建地点：${parent ? spatialNodePath(core, parent.id) + ' / ' : ''}${name.trim()}（不移动人物）`], unresolved: [], evidence: [],
          baseVersion: snapshot.version, personaId: generation.personaId, sourceFingerprint: original.sourceFingerprint, sources: [], sourceOptions: { text: '', loreEntryIds: [] }, commands, createdAt: now })
        state.messages.push({ id: randomUUID(), role: 'user', mode: 'instruction', content: `创建地点：${name.trim()}；上级：${parent ? spatialNodePath(core, parent.id) : '世界根画板'}。本次不移动人物。`, proposalId: id, createdAt: now })
        saveAi(state); return state
      })
      publish(scope); return result
    },

    async undo(scope: SpatialScope, proposalId: string): Promise<{ state: SpatialAiSession; snapshot: SpatialSnapshot }> {
      const prepared = await spatialRepository.locked(async () => {
        const state = await ensureLocked(scope), proposal = state.proposals.find(item => item.id === proposalId), snapshot = await snapshotLocked(scope)
        if (!snapshot || !proposal || proposal.mode !== 'dialogue_sync') throw new Error('该记录不是当前画板的剧情提交')
        if (proposal.status === 'undone') return { done: { state, snapshot } }
        if (proposal.status !== 'applied' || !proposal.appliedVersion) throw new Error('该剧情建议尚未应用或缺少撤销记录')
        if (hashSpatialValue(snapshot.version) !== hashSpatialValue(proposal.appliedVersion)) throw new Error('剧情提交后画板已有其他修改，不能覆盖当前位置；请打开画板核对并手动调整')
        const receipt = stateFor(scope, snapshot.version.worldId, snapshot.version.runtimeId).commits[proposal.commitId]
        if (!receipt?.inverse?.length) throw new Error('剧情逆操作记录缺失，请恢复完整备份')
        const undoCommitId = proposal.undoCommitId ?? `undo_${proposal.commitId}`
        const companion: SpatialCompanion = { id: state.id, expectedHash: hashSpatialValue(state), validate: async () => {
          if ((await sessionFor(scope)).spatialAiSessionId !== state.id) throw new Error('原剧情画板绑定已改变')
        }, complete: (undoReceipt) => {
          const next = structuredClone(state), undone = next.proposals.find(item => item.id === proposalId)!
          undone.status = 'undone'; undone.undoCommitId = undoCommitId
          next.messages.push({ id: randomUUID(), role: 'system', mode: 'result', content: `已撤销本次剧情位置更新，位置版本 ${undoReceipt.revisionAfter}。`, proposalId, createdAt: Date.now() })
          next.updatedAt = Date.now(); return next
        } }
        return { snapshot, commands: [...receipt.inverse].reverse(), undoCommitId, companion }
      })
      if ('done' in prepared) return prepared.done!
      const v = prepared.snapshot.version
      const result = await spatialService.applyEditorBatch(scope.characterId, scope.sessionId, { commitId: prepared.undoCommitId, worldId: v.worldId, runtimeId: v.runtimeId,
        bindingEpoch: v.bindingEpoch, expectedRuntimeRevision: v.runtimeRevision, expectedWorldFingerprint: v.worldFingerprint, commands: prepared.commands }, prepared.companion, undefined, true)
      if (!result.ok) throw new Error(result.message)
      publish(scope); return { state: loadAi(prepared.companion.id), snapshot: result.snapshot }
    },

    async editDraft(scope: SpatialScope, proposalId: string, input: SpatialEditorCommit) {
      const edited = await spatialRepository.locked(async () => {
        const state = await ensureLocked(scope)
        const proposal = state.proposals.find(proposal => proposal.id === proposalId)
        if (!proposal?.preview || proposal.status !== 'pending' || proposal.mode !== 'initialize') throw new Error('初始化草稿不可编辑')
        safeId(input.commitId)
        const requestHash = hashSpatialValue(input)
        const previous = proposal.draftCommits?.[input.commitId]
        if (previous) {
          if (previous.requestHash !== requestHash) throw new Error('草稿提交 ID 已用于不同操作')
          return { ok: true as const, snapshot: proposal.preview, duplicate: true, receipt: previous.receipt }
        }
        const version = proposal.preview.version
        if (input.worldId !== version.worldId || input.runtimeId !== version.runtimeId || input.bindingEpoch !== version.bindingEpoch ||
          input.expectedRuntimeRevision !== version.runtimeRevision || input.expectedWorldFingerprint !== version.worldFingerprint) {
          return { ok: false as const, code: 'version_conflict', message: '草稿已更新，请重新核对', snapshot: proposal.preview }
        }
        if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 100 ||
          input.commands.some(command => !command || typeof command !== 'object' || ['create_actor', 'update_actor', 'delete_actor'].includes(String((command as { type?: unknown }).type)))) throw new Error('草稿编辑命令无效')
        const preview = proposal.preview
        const base = proposal.baseVersion ? coreOf((await snapshotLocked(scope))!) : {
          world: { ...coreOf(preview).world, name: coreOf(preview).world.name,
            nodes: coreOf(preview).world.nodes.filter(node => node.tags.includes('system:offstage')), boards: coreOf(preview).world.boards.filter(board => board.id === coreOf(preview).world.rootBoardId), distances: [] },
          runtime: createEmptyRuntime(version.worldId, version.runtimeId, Date.now()) }
        const result = applyCommandBatch(coreOf(proposal.preview), { schemaVersion: 1, expectedRevision: version.runtimeRevision, commands: input.commands as SpatialCommand[] },
          { source: 'user', now: Date.now(), idGen: randomUUID })
        if (!result.ok) return { ok: false as const, code: result.code, message: result.message, snapshot: proposal.preview }
        assertInitializationPreview(base, result.state)
        const next = { ...result.state, version: { ...version, runtimeRevision: result.state.runtime.revision, worldFingerprint: worldFingerprint(result.state.world) } }
        proposal.preview = next; proposal.commands = initializationCommands(base, result.state, !!proposal.baseVersion)
        const receipt = { commitId: input.commitId, revisionBefore: version.runtimeRevision, revisionAfter: next.version.runtimeRevision, worldFingerprintAfter: next.version.worldFingerprint }
        proposal.draftCommits = { ...proposal.draftCommits, [input.commitId]: { requestHash, receipt } }
        proposal.summary = [...result.state.world.nodes.filter(node => !node.tags.includes('system:offstage')).map(node => `地点：${node.name}`),
          ...result.state.runtime.placements.map(placement => `${result.state.world.actors.find(actor => actor.id === placement.actorId)?.displayName} → ${result.state.world.nodes.find(node => node.id === placement.anchor.nodeId)?.name ?? '未明确地点'}`)]
        saveAi(state)
        return { ok: true as const, snapshot: next, duplicate: false, receipt }
      })
      if (edited.ok && !edited.duplicate) publish(scope)
      return edited
    },

    apply: (scope: SpatialScope, proposalId: string, acknowledgeUnresolved = false) => apply(scope, proposalId, acknowledgeUnresolved),
  }
}

export const spatialAiService = createSpatialAiService()
