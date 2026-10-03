import { trimFeatureHistory } from '../../../../shared/featureHistory'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { applyCommandBatch, createEmptyRuntime, createWorldWithDefaults, type SpatialCoreState, type SpatialCommand } from '@qingyu/spatial-core'
import type { AICompletion, ChatParams, Persona } from '../../../../shared/types'
import type { SpatialAiProposal, SpatialAiRequest, SpatialGroupAiSession, SpatialInitializationSources, SpatialSource, SpatialProposalReviewInput } from '../../../../shared/spatial-ai'
import type { SpatialCommitReceipt, SpatialEditorCommit, SpatialSnapshot } from '../../../../shared/spatial'
import { stripAllThinking } from '../../../../shared/thoughtMarkup'
import { resolveSessionPersonaFields } from '../../../../shared/personaResolution'
import { resolveMessageSpeakerKind } from '../../../../shared/messageIdentity'
import { resolveGenerationTaskBudget } from '../../../../shared/generationTaskBudget'
import { enabledProfileOverride, resolveEffectiveContextLimit } from '../../../../shared/modelOutputProfile'
import { groupData } from '../../../ipc/group'
import { getCharacter } from '../../../services/charCard'
import { listLorebookViews } from '../../../services/lorebookDocumentStore'
import { DIRS, readJson, writeJson } from '../../../services/storage'
import { safeId } from '../../../utils/pathGuard'
import { readChatSettings, resolveChatProfile } from '../../../services/chatConnection'
import { countTokens } from '../../../services/tokenizer'
import { hashSpatialValue, readSpatialJson, spatialPaths, worldFingerprint, spatialRuntimeId, type SpatialGroupScope } from '../repository'
import { groupActors, syncGroupLocked, validateGroupActorCommands, sessionFor, snapshotLocked, stateFor, spatialRepository, spatialService, type SpatialCompanion } from '../commitService'
import { assertInitializationPreview, initializationCommands, isBlankSpatial, parseSpatialAiReply, spatialAiSystemPrompt } from './protocol'
import { createSpatialGroupDialogueQueue } from '../dialogue/groupQueue'
import { clearGroupSpatialCheckpoints } from '../dialogue/groupCheckpoint'
import { reviewDialogueCandidates, spatialNodePath } from '../dialogue/protocol'
import { assertSpatialBoardEnabled, cancelSpatialWork } from '../board'
import { canonicalSpatialPlaceName, spatialDialogueReference } from '../placeNames'

const coreOf = (snapshot: SpatialSnapshot): SpatialCoreState => snapshot as SpatialCoreState & SpatialSnapshot
const listeners = new Set<(scope: SpatialGroupScope) => void>()
const publish = (scope: SpatialGroupScope) => { for (const listener of listeners) listener(scope) }

function saveAi(state: SpatialGroupAiSession): void {
  trimFeatureHistory(state)
  if (Buffer.byteLength(JSON.stringify(state)) > 5 * 1024 * 1024) throw new Error('画板助手记录过大，请缩小初始化来源或处理待确认提案')
  state.updatedAt = Date.now()
  writeJson(spatialPaths.ai(state.id), state)
}
function loadAi(id: string): SpatialGroupAiSession {
  const state = readSpatialJson<SpatialGroupAiSession>(spatialPaths.ai(safeId(id)))
  if (!state || state.schemaVersion !== 1 || state.id !== id || !Array.isArray(state.messages) ||
    !Array.isArray(state.proposals) || !Array.isArray(state.tasks) || !state.scope) throw new Error('画板助手记录缺失或损坏，请恢复数据')
  return state
}

async function collectSources(scope: SpatialGroupScope, options: { text: string; loreEntryIds: string[]; memberIds?: string[] }) {
  const session = await sessionFor(scope), group = groupData.listGroups().find(item => item.id === scope.groupId)!
  const settings = readChatSettings(), personas = readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []
  const identity = resolveSessionPersonaFields(session, settings, personas)
  const persona = personas.find(item => item.id === identity.activePersonaId) ?? null
  const members = group.memberIds.map(id => getCharacter(id)).filter((item): item is NonNullable<typeof item> => !!item)
  const selected = options.memberIds ?? members.map(member => member.id)
  if (selected.some(id => !members.some(member => member.id === id)) || new Set(selected).size !== selected.length) throw new Error('选定成员已变化，请重新选择初始化来源')
  const sources: SpatialSource[] = []
  if (options.text.trim()) sources.push({ id: 'instruction', label: '本次场景说明', kind: 'instruction', text: options.text.trim(), speaker: { role: 'user' } })
  const messages = groupData.readMessages(scope.groupId, scope.sessionId).filter(message => stripAllThinking(message.content).trim()).slice(-12).reverse()
  for (const message of messages) sources.push({ id: `message:${message.id}`, label: `${message.characterId === '__user__' ? identity.userName : members.find(member => member.id === message.characterId)?.name ?? '群聊正文'} · 已保存正文`, kind: 'message', text: stripAllThinking(message.content), speaker: { role: resolveMessageSpeakerKind(message) === 'narrator' ? 'narrator' : message.characterId === '__user__' ? 'user' : 'character', characterId: message.characterId === '__user__' ? undefined : message.characterId } })
  if (group.systemPrompt) sources.push({ id: 'group:setting', label: '群聊公共设定', kind: 'group', text: group.systemPrompt })
  for (const member of members.filter(member => selected.includes(member.id))) {
    if (member.scenario) sources.push({ id: `character:${member.id}:scenario`, label: `${member.name} · 场景设定（非已发生剧情）`, kind: 'character', text: member.scenario, subject: { kind: 'character', id: member.id } })
    if (member.description) sources.push({ id: `character:${member.id}:description`, label: `${member.name} · 角色描述`, kind: 'character', text: member.description, subject: { kind: 'character', id: member.id } })
  }
  if (persona) sources.push({ id: `persona:${persona.id}`, label: `${persona.name} · 用户身份`, kind: 'persona', text: `${persona.description}\n${persona.persona}`, subject: { kind: 'persona', id: persona.id } })
  const activeBooks = new Set([...group.lorebookIds, ...members.flatMap(member => member.boundLorebookIds ?? (member.lorebookId ? [member.lorebookId] : []))])
  const books = (await listLorebookViews(DIRS.lorebooks())).filter(book => book.enabled && activeBooks.has(book.id))
  const loreEntries = books.flatMap(book => book.entries.filter(entry => entry.enabled).map(entry => ({ id: `${book.id}:${entry.id}`, label: `${book.name} / ${entry.keywords.join('、') || entry.id}`, text: entry.content })))
  for (const id of options.loreEntryIds) {
    const entry = loreEntries.find(entry => entry.id === id)
    if (!entry) throw new Error('选中的世界书条目已停用或不属于当前群聊')
    sources.push({ id: `lorebook:${entry.id}`, label: entry.label, kind: 'lorebook', text: entry.text })
  }
  // 成员、身份和会话叙事视角是所有请求的来源边界，包括显式指令。
  const roster = hashSpatialValue({ ...(settings.spatialSourceEpoch ? {configEpoch:settings.spatialSourceEpoch} : {}), ...(group.spatialSourceEpoch ? {groupEpoch:group.spatialSourceEpoch} : {}), ...(session.spatialNarrativeSyncEpoch ? {sessionEpoch:session.spatialNarrativeSyncEpoch} : {}), members: members.map(member => ({ id: member.id, name: member.name })), memberIds: group.memberIds, persona, mode: group.chatMode, narrativeMode: session.narrativeMode })
  return { session, members, personaId: persona?.id ?? null, sources, roster,
    loreEntries: loreEntries.map(({ id, label }) => ({ id, label })), fingerprint: hashSpatialValue({ roster, sources, selected }) }
}

function groupPrompt(mode: SpatialAiRequest['mode']): string {
  return spatialAiSystemPrompt(mode).split('当前聊天角色和有效 persona').join('当前群聊成员和有效 persona').split('2人物位置').join('本轮 allowedActors 数量以内的人物位置') + `
本轮属于群聊。allowedActors.members 是正式人物 ID 列表；每个 ID 的姓名见 currentMap.actors。初始化 placements.actor 只能填写本轮正式成员 ID 或有效 persona，不使用 character 别名。
多位成员的个人住所不等于公共场景，不能合并矛盾的成员场景。同群不代表同地，未知位置不等于未参与对话。角色默认问候、未实际选中开场白和示例对话不是发生过的正文。只根据最近保存正文、本轮明确说明及选定空间设定；冲突写 unresolved 并保留未放置。`
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

export function createSpatialGroupAiService(deps: { complete: (params: ChatParams, signal: AbortSignal, timeout: number) => Promise<AICompletion> } = {
  complete: async (params, signal, timeout) => { const { chatWithRetry, getAdapter } = await import('../../../services/ai'); return chatWithRetry(getAdapter(params.provider), params, () => {}, signal, 0, undefined, timeout) },
}) {
  const active = new Map<string, { taskId: string; controller: AbortController; fingerprint?: string; options?: { text: string; loreEntryIds: string[]; memberIds?: string[] } }>()
  const deleted = new Set<string>()
  const deletedScopes = new Set<string>()
  const directPending = new Set<string>()
  let restoring = false
  let restoreEpoch = 0

  const ensureLocked = async (scope: SpatialGroupScope): Promise<SpatialGroupAiSession> => {
    if (restoring) throw new Error('正在恢复数据，请稍后重试画板请求')
    if (deletedScopes.has(hashSpatialValue(scope))) throw new Error('当前群聊已删除，不能恢复旧助手请求')
    const session = await sessionFor(scope)
    const snapshot = await syncGroupLocked(scope)
    const identity = { ...scope, worldId: snapshot?.version.worldId ?? null, runtimeId: snapshot?.version.runtimeId ?? null, bindingEpoch: snapshot?.version.bindingEpoch ?? null }
    if (session.spatialAiSessionId) {
      const state = loadAi(session.spatialAiSessionId)
      if (state.scope.kind !== 'group' || state.scope.groupId !== scope.groupId || state.scope.sessionId !== scope.sessionId) throw new Error('画板助手记录属于其他群聊，不能恢复到当前会话')
      if (hashSpatialValue(state.scope) === hashSpatialValue(identity)) {
        const interrupted = state.tasks.filter(task => task.state === 'running' && active.get(state.id)?.taskId !== task.id)
        const unfinished = state.proposals.filter(proposal => proposal.automatic?.status === 'applying' &&
          state.tasks.find(task => task.id === active.get(state.id)?.taskId)?.dialogueId !== proposal.dialogueId)
        if (interrupted.length || unfinished.length) {
          for (const task of interrupted) { task.state = 'interrupted'; task.error = '请求在上次运行中中断，结果未知；不会自动重发模型请求' }
          for (const proposal of unfinished) proposal.automatic = { status: 'confirmation', reason: '自动应用在上次运行中中断，请核对后手动确认' }
          saveAi(state)
        }
        return state
      }
    }
    const now = Date.now()
    const state: SpatialGroupAiSession = { schemaVersion: 1, id: randomUUID(), scope: identity, messages: [], proposals: [], tasks: [], createdAt: now, updatedAt: now }
    saveAi(state)
    await groupData.attachSpatialAiSession(scope.groupId, scope.sessionId,
      { worldId: session.spatialWorldId ?? null, runtimeId: session.spatialRuntimeId ?? null, aiSessionId: session.spatialAiSessionId ?? null }, state.id)
    return state
  }

  const completeState = (state: SpatialGroupAiSession, proposal: SpatialAiProposal, receipt: SpatialCommitReceipt, snapshot: SpatialSnapshot, automatic = false): SpatialGroupAiSession => {
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

  const dialogue = createSpatialGroupDialogueQueue({ ensure: ensureLocked, load: loadAi, save: saveAi, active, deleted, publish, complete: deps.complete, isDirectPending: scope => directPending.has(hashSpatialValue(scope)),
    context: async scope => {
      const session = await sessionFor(scope), group = groupData.listGroups().find(item => item.id === scope.groupId)!
      const settings = readChatSettings(), personas = readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []
      const identity = resolveSessionPersonaFields(session, settings, personas), persona = personas.find(item => item.id === identity.activePersonaId)
      const profile = resolveChatProfile(settings)
      return { session, group, personaId: persona?.id ?? null, fingerprint: hashSpatialValue({ ...(settings.spatialSourceEpoch ? {configEpoch:settings.spatialSourceEpoch} : {}), ...(group.spatialSourceEpoch ? {groupEpoch:group.spatialSourceEpoch} : {}), ...(session.spatialNarrativeSyncEpoch ? {sessionEpoch:session.spatialNarrativeSyncEpoch} : {}), memberIds: group.memberIds, members: group.memberIds.map(id => getCharacter(id)?.name), persona, mode: group.chatMode, narrativeMode: session.narrativeMode ?? 'immersive', connection: profile ? { id: settings.activeProfileId, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, apiKey: profile.apiKey } : null }) }
    } })

  async function apply(scope: SpatialGroupScope, proposalId: string, acknowledgeUnresolved = false): Promise<{ state: SpatialGroupAiSession; snapshot: SpatialSnapshot }> {
    assertSpatialBoardEnabled(await sessionFor(scope))
    const prepared = await spatialRepository.locked(async () => {
      const state = await refresh(scope), proposal = state.proposals.find(item => item.id === proposalId)
      if (!proposal || !['pending','applied'].includes(proposal.status)) throw new Error(proposal?.staleReason ?? '提案不存在或已忽略')
      if (proposal.status === 'applied') return { done: { state, snapshot: (await snapshotLocked(scope))! } }
      if (proposal.mode === 'dialogue_sync' && !proposal.commands.length) throw new Error('未明确或未完成的动作不能应用，请在画板助手明确指令调整')
      if (proposal.unresolved.length && !acknowledgeUnresolved) throw new Error('请先核对草稿中的未明确项')
      const companion: SpatialCompanion = { id: state.id, expectedHash: hashSpatialValue(state), validate: async () => {
        assertSpatialBoardEnabled(await sessionFor(scope))
        if ((await sessionFor(scope)).spatialAiSessionId !== state.id) throw new Error('提案所属群聊助手已改变')
        if (proposal.mode === 'dialogue_sync' || proposal.placeForId) {
          const batch = state.groupDialogueBatches?.find(item => item.id === proposal.dialogueId)
          if (!batch) throw new Error('群聊剧情来源批次缺失')
          const reason = await dialogue.sourceError(scope, state, batch)
          if (reason) throw new Error(reason)
          if (proposal.placeForId && !state.proposals.some(item => item.id === proposal.placeForId && ['pending','stale'].includes(item.status))) throw new Error('原剧情建议已忽略或不再可核对')
        } else {
          const data = await collectSources(scope, proposal.sourceOptions)
          if (data.fingerprint !== proposal.sourceFingerprint) throw new Error('群聊成员、身份或来源已改变，请重新核对提案')
        }
        if (proposal.mode === 'initialize' && proposal.baseVersion) {
          const bound = await snapshotLocked(scope)
          if (!bound || !isBlankSpatial(coreOf(bound))) throw new Error('当前地图已不再是空白状态')
        }
      }, complete: (receipt, snapshot) => completeState(state, proposal, receipt, snapshot) }
      return { proposal, companion }
    })
    if ('done' in prepared) return prepared.done!
    const { proposal, companion } = prepared
    let snapshot: SpatialSnapshot
    if (!proposal.baseVersion) {
      if (!proposal.preview || proposal.mode !== 'initialize') throw new Error('无绑定初始化草稿缺失')
      const preview = coreOf(proposal.preview), base = { world: { ...preview.world, nodes: preview.world.nodes.filter(node => node.tags.includes('system:offstage')), boards: preview.world.boards.filter(board => board.id === preview.world.rootBoardId), distances: [] }, runtime: createEmptyRuntime(preview.world.id, preview.runtime.runtimeId, Date.now()) }
      const commands = initializationCommands(base, preview, false)
      const applied = applyCommandBatch(base, { schemaVersion: 1, expectedRevision: 0, commands }, { source: 'system', now: Date.now(), idGen: randomUUID })
      if (!applied.ok) throw new Error(applied.message)
      snapshot = await spatialService.initializeFromDraft(scope, applied.state, proposal.commitId, proposal.sourceFingerprint, companion)
    } else {
      const version = proposal.baseVersion
      const commit = () => spatialService.applyGroupEditorBatch(scope.groupId, scope.sessionId, { commitId: proposal.commitId, ...version, expectedRuntimeRevision: version.runtimeRevision, expectedWorldFingerprint: version.worldFingerprint, commands: proposal.commands }, companion, proposal.mode === 'initialize' ? { sourceFingerprint: proposal.sourceFingerprint } : undefined, proposal.mode === 'dialogue_sync')
      const result = proposal.mode === 'dialogue_sync' || proposal.placeForId ? await groupData.withMessagesLock(scope.groupId, scope.sessionId, commit) : await commit()
      if (!result.ok) throw new Error(result.message)
      snapshot = result.snapshot
    }
    publish(scope); return { state: loadAi(companion.id), snapshot }
  }

  const refresh = async (scope: SpatialGroupScope) => {
    const state = await ensureLocked(scope)
    let changed = false
    const lease = active.get(state.id)
    if (lease?.options) {
      let current: string | null = null
      try { current = (await collectSources(scope, lease.options)).fingerprint } catch { /* 成员或来源被移除。 */ }
      if (current !== lease.fingerprint) {
        lease.controller.abort(); active.delete(state.id)
        const task = state.tasks.find(item => item.id === lease.taskId)
        if (task?.state === 'running') { task.state = 'interrupted'; task.error = '群聊成员、身份或来源已改变，本次请求已停止'; task.completedAt = Date.now(); changed = true }
      }
    }
    for (const proposal of state.proposals.filter(item => item.status === 'pending' && item.mode !== 'dialogue_sync' && !item.placeForId)) {
      try { if ((await collectSources(scope, proposal.sourceOptions)).fingerprint === proposal.sourceFingerprint) continue } catch { /* 来源移除同样使旧提案失效。 */ }
      proposal.status = 'stale'; proposal.staleReason = '群聊成员、身份或来源已改变，请重新生成核对'; changed = true
    }
    const snapshot = await snapshotLocked(scope)
    for (const proposal of state.proposals.filter(item => item.status === 'pending' && item.placeForId)) {
      if (hashSpatialValue(snapshot?.version) !== hashSpatialValue(proposal.baseVersion)) {
        proposal.status = 'stale'; proposal.staleReason = '地点创建期间画板已改变，请重新预览地点'; changed = true
      }
    }
    if (changed) saveAi(state)
    return dialogue.refresh(scope, state)
  }

  async function reviewSource(scope: SpatialGroupScope, state: SpatialGroupAiSession, proposalId: string) {
    const original = state.proposals.find(item => item.id === proposalId)
    if (!original || original.mode !== 'dialogue_sync' || !['pending','stale'].includes(original.status) || original.replacedById || (original.status === 'stale' && !original.canReview)) throw new Error(original?.staleReason ?? '该群聊剧情建议不能重新核对')
    const batch = state.groupDialogueBatches?.find(item => item.id === original.dialogueId)
    if (!batch || !original.dialogueCandidates?.length || original.sourceFingerprint !== batch.sourceFingerprint) throw new Error('原群聊剧情动作依据缺失')
    const reason = await dialogue.sourceError(scope, state, batch)
    if (reason) throw new Error(reason)
    const messages = groupData.readMessages(scope.groupId, scope.sessionId)
    const captured = coreOf(batch.snapshot)
    const body = batch.generations.filter(item => item.state === 'registered').flatMap(item => item.messageIds.map(id => messages.find(message => message.id === id)!))
      .map(message => `【${captured.world.actors.find(actor => actor.externalRef.id === message.characterId)?.displayName ?? '群聊叙事'}】\n${stripAllThinking(message.content).trim()}`).join('\n\n')
    return { original, batch, body }
  }

  return {
    dialogue,
    onUpdated(listener: (scope: SpatialGroupScope) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async disable(scope?: SpatialGroupScope) {
      if (scope) dialogue.cancelScope(scope)
      else dialogue.suspend()
      if (!scope) for (const lease of active.values()) lease.controller.abort()
      await spatialRepository.locked(() => {
        const directory = join(DIRS.spatial(), 'ai-sessions')
        if (!existsSync(directory)) return
        for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
          const raw = readSpatialJson<SpatialGroupAiSession>(join(directory, file))
          if (raw?.scope.kind === 'group' && (!scope || (raw.scope.groupId === scope.groupId && raw.scope.sessionId === scope.sessionId))) {
            active.get(raw.id)?.controller.abort()
            saveAi(cancelSpatialWork(loadAi(raw.id)))
          }
        }
      })
    },
    suspendRestore() { restoring = true; restoreEpoch++; directPending.clear(); dialogue.suspend(); clearGroupSpatialCheckpoints(); for (const lease of active.values()) lease.controller.abort(); active.clear() },
    resumeRestore() { restoring = false; deleted.clear(); deletedScopes.clear() },
    async deleteScope(groupId: string, sessionId?: string) {
      await spatialRepository.locked(() => {
        for (const session of groupData.readSessions(safeId(groupId)).filter(item => !sessionId || item.id === sessionId)) deletedScopes.add(hashSpatialValue({ kind: 'group', groupId, sessionId: session.id }))
        const directory = join(DIRS.spatial(), 'ai-sessions')
        if (existsSync(directory)) for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
          const raw = readSpatialJson<{ scope?: { kind?: string; groupId?: string; sessionId?: string } }>(join(directory, file))
          if (raw?.scope?.kind !== 'group' || raw.scope.groupId !== groupId || (sessionId && raw.scope.sessionId !== sessionId)) continue
          const id = file.slice(0,-5); deleted.add(id); active.get(id)?.controller.abort(); active.delete(id); unlinkSync(spatialPaths.ai(id))
        }
      })
    },
    get: (scope: SpatialGroupScope) => spatialRepository.locked(() => refresh(scope)),
    targets: (scope: SpatialGroupScope) => spatialRepository.locked(async () => {
      await ensureLocked(scope)
      const snapshot = await snapshotLocked(scope)
      if (!snapshot) return []
      const core = coreOf(snapshot)
      return core.world.nodes.filter(node => !node.tags.includes('system:offstage')).map(node => ({id:node.id,boardId:node.boardId,path:spatialNodePath(core,node.id),canContain:node.kind === 'region' || !!node.childBoardId}))
    }),
    async review(scope: SpatialGroupScope, proposalId: string, input: SpatialProposalReviewInput) {
      const result = await groupData.withMessagesLock(scope.groupId, scope.sessionId, () => spatialRepository.locked(async () => {
        const state = await refresh(scope), {original,batch,body} = await reviewSource(scope,state,proposalId)
        if (!input?.targets || typeof input.targets !== 'object' || Array.isArray(input.targets) || Object.values(input.targets).some(value => typeof value !== 'string')) throw new Error('地点选择无效')
        const snapshot = (await snapshotLocked(scope))!, core = coreOf(snapshot)
        const actors = {members:core.world.actors.filter(item => item.externalRef.type === 'qingyu-character' && batch.memberIds.includes(item.externalRef.id)).map(item => item.id),persona:core.world.actors.find(item => item.externalRef.type === 'qingyu-persona' && item.externalRef.id === batch.personaId)?.id}
        const reviewed = reviewDialogueCandidates(core,original.dialogueCandidates!,input.targets,actors,{user:batch.userText,assistant:body,narrativeMode:batch.narrativeMode})
        const id = randomUUID()
        original.status = 'stale'; original.replacedById = id; original.canReview = false; original.staleReason = '已生成重新核对的群聊建议'
        state.proposals.push({...original,id,commitId:randomUUID(),status:'pending',replacedById:undefined,staleReason:undefined,automatic:undefined,reviewedFromId:original.id,canReview:false,baseVersion:snapshot.version,commands:reviewed.commands,summary:reviewed.summary,unresolved:reviewed.unresolved,dialogueCandidates:reviewed.candidates,comparisons:reviewed.comparisons,createdAt:Date.now()})
        state.messages.push({id:randomUUID(),role:'system',mode:'result',content:`已按群聊当前位置重新核对，尚未移动人物：${reviewed.summary.join('；')}。请再次确认。`,proposalId:id,createdAt:Date.now()})
        saveAi(state); return state
      }))
      publish(scope); return result
    },
    async preparePlace(scope: SpatialGroupScope, proposalId: string, name: string, parentId: string | null) {
      const result = await groupData.withMessagesLock(scope.groupId,scope.sessionId,() => spatialRepository.locked(async () => {
        const state = await refresh(scope), {original,batch,body} = await reviewSource(scope,state,proposalId)
        if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new Error('地点名称须为 1 到 128 个字符')
        if (state.proposals.filter(item => item.status === 'pending').length >= 20) throw new Error('请先处理已有的待确认调整')
        const snapshot = (await snapshotLocked(scope))!, core = coreOf(snapshot)
        if (!original.dialogueCandidates?.some(item => item.eligible && !core.world.nodes.some(node => node.id === item.targetNodeId && !node.tags.includes('system:offstage')))) throw new Error('没有需要创建地点的已完成动作')
        const actors = { members: core.world.actors.filter(actor => actor.externalRef.type === 'qingyu-character' && batch.memberIds.includes(actor.externalRef.id)).map(actor => actor.id),
          persona: core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === batch.personaId)?.id }
        name = canonicalSpatialPlaceName(name.trim(), core, actors, original.dialogueCandidates.map(candidate => spatialDialogueReference(core, actors,
          { user: batch.userText, assistant: body, narrativeMode: batch.narrativeMode }, candidate.evidenceSource, candidate.evidence)))
        const parent = parentId ? core.world.nodes.find(item => item.id === parentId && !item.tags.includes('system:offstage')) : null
        if (parentId && !parent) throw new Error('上级地点已不存在')
        if (parent && parent.kind !== 'region' && !parent.childBoardId) throw new Error('请选择区域或具有内部画板的地点作为上级')
        const boardId = parent?.childBoardId ?? parent?.boardId ?? core.world.rootBoardId, parentNodeId = parent?.childBoardId ? null : parent?.id ?? null
        if (core.world.nodes.some(node => node.boardId === boardId && node.parentNodeId === parentNodeId && node.name === name.trim())) throw new Error('此路径已有同名地点，请选择已有地点')
        const now = Date.now(), id = randomUUID(), nodeId = randomUUID()
        const commands: SpatialCommand[] = [{type:'create_node',payload:{id:nodeId,boardId,parentNodeId,childBoardId:null,kind:'place',name:name.trim(),description:'',tags:[],createdAt:now,updatedAt:now,geometry:{x:80 + core.world.nodes.length % 5 * 220,y:160 + Math.floor(core.world.nodes.length / 5) * 180},iconKey:'pin'}}]
        const checked = applyCommandBatch(core,{schemaVersion:1,expectedRevision:core.runtime.revision,commands},{source:'user',now,idGen:randomUUID})
        if (!checked.ok) throw new Error(checked.message)
        state.proposals.push({id,commitId:randomUUID(),mode:'instruction',status:'pending',placeForId:original.id,dialogueId:batch.id,explanation:'手动创建群聊地点；本次不移动人物',summary:[`创建地点：${parent ? spatialNodePath(core,parent.id)+' / ' : ''}${name.trim()}（不移动人物）`],unresolved:[],evidence:[],baseVersion:snapshot.version,personaId:batch.personaId,sourceFingerprint:original.sourceFingerprint,sources:[],sourceOptions:{text:'',loreEntryIds:[]},commands,createdAt:now})
        state.messages.push({id:randomUUID(),role:'user',mode:'instruction',content:`创建地点：${name.trim()}；上级：${parent ? spatialNodePath(core,parent.id) : '世界根画板'}。本次不移动人物。`,proposalId:id,createdAt:now})
        saveAi(state); return state
      }))
      publish(scope); return result
    },
    async undo(scope: SpatialGroupScope, proposalId: string) {
      const prepared = await spatialRepository.locked(async () => {
        const state = await ensureLocked(scope), proposal = state.proposals.find(item => item.id === proposalId), snapshot = await snapshotLocked(scope)
        if (!snapshot || !proposal || proposal.mode !== 'dialogue_sync') throw new Error('该记录不是当前群聊画板的剧情提交')
        if (proposal.status === 'undone') return {done:{state,snapshot}}
        if (proposal.status !== 'applied' || !proposal.appliedVersion) throw new Error('该群聊剧情建议尚未应用或缺少撤销记录')
        if (hashSpatialValue(snapshot.version) !== hashSpatialValue(proposal.appliedVersion)) throw new Error('剧情提交后画板已有其他修改，不能覆盖当前位置；请打开画板核对并手动调整')
        const receipt = stateFor(scope,snapshot.version.worldId,snapshot.version.runtimeId).commits[proposal.commitId]
        if (!receipt?.inverse?.length) throw new Error('群聊剧情逆操作记录缺失，请恢复完整备份')
        const undoCommitId = proposal.undoCommitId ?? `undo_${proposal.commitId}`
        const companion: SpatialCompanion = {id:state.id,expectedHash:hashSpatialValue(state),validate:async () => {
          if ((await sessionFor(scope)).spatialAiSessionId !== state.id) throw new Error('原群聊剧情画板绑定已改变')
        },complete:(undoReceipt) => {
          const next = structuredClone(state), undone = next.proposals.find(item => item.id === proposalId)!
          undone.status = 'undone'; undone.undoCommitId = undoCommitId
          next.messages.push({id:randomUUID(),role:'system',mode:'result',content:`已撤销本次群聊剧情位置更新，位置版本 ${undoReceipt.revisionAfter}。`,proposalId,createdAt:Date.now()})
          next.updatedAt = Date.now(); return next
        }}
        return {snapshot,commands:[...receipt.inverse].reverse(),undoCommitId,companion}
      })
      if ('done' in prepared) return prepared.done!
      const v = prepared.snapshot.version
      const result = await spatialService.applyGroupEditorBatch(scope.groupId,scope.sessionId,{commitId:prepared.undoCommitId,worldId:v.worldId,runtimeId:v.runtimeId,bindingEpoch:v.bindingEpoch,expectedRuntimeRevision:v.runtimeRevision,expectedWorldFingerprint:v.worldFingerprint,commands:prepared.commands},prepared.companion,undefined,true)
      if (!result.ok) throw new Error(result.message)
      publish(scope); return {state:loadAi(prepared.companion.id),snapshot:result.snapshot}
    },
    sources: (scope: SpatialGroupScope): Promise<SpatialInitializationSources> => spatialRepository.locked(async () => {
      const data = await collectSources(scope, { text: '', loreEntryIds: [] }), snapshot = await syncGroupLocked(scope)
      return { sources: data.sources, loreEntries: data.loreEntries, members: data.members.map(member => ({ id: member.id, name: member.name })), canInitialize: !snapshot || isBlankSpatial(coreOf(snapshot)), sharedSessions: snapshot ? spatialRepository.runtimes().filter(item => item.runtime.worldId === snapshot.version.worldId).length : 0 }
    }),
    async ask(scope: SpatialGroupScope, input: SpatialAiRequest): Promise<SpatialGroupAiSession> {
      assertSpatialBoardEnabled(await sessionFor(scope))
      safeId(input.requestId)
      if (!['initialize', 'instruction', 'positions'].includes(input.mode) || typeof input.text !== 'string' || input.text.length > 12000 ||
        (input.mode === 'instruction' && !input.text.trim()) || (input.loreEntryIds && (!Array.isArray(input.loreEntryIds) || input.loreEntryIds.length > 20 || input.loreEntryIds.some(id => typeof id !== 'string')))) throw new Error('画板助手请求无效')
      if (input.memberIds && (!Array.isArray(input.memberIds) || input.memberIds.length > 50 || input.memberIds.some(id => typeof id !== 'string'))) throw new Error('成员来源选择无效')
      const options = { text: input.text.trim(), loreEntryIds: input.loreEntryIds ?? [], memberIds: input.memberIds }
      const prepared = await (async () => {
        const directKey = hashSpatialValue(scope); directPending.add(directKey)
        try {
          const directEpoch = restoreEpoch
          await collectSources(scope, options)
          if (restoring || directEpoch !== restoreEpoch) throw new Error('数据已恢复，旧画板请求已取消')
          await spatialService.loadGroupBound(scope.groupId, scope.sessionId)
          const prepared = await spatialRepository.locked(async () => {
            assertSpatialBoardEnabled(await sessionFor(scope))
            if (directEpoch !== restoreEpoch) throw new Error('数据已恢复，旧画板请求已取消')
            const state = await refresh(scope)
            const requestHash = hashSpatialValue({ mode: input.mode, ...options })
            const oldTask = state.tasks.find(task => task.id === input.requestId)
            if (oldTask) { if (oldTask.requestHash !== requestHash) throw new Error('请求 ID 已用于不同指令'); return { done: state } }
            const lease = active.get(state.id), extraction = state.tasks.find(item => item.id === lease?.taskId && item.mode === 'dialogue_sync')
            if (lease && extraction) { lease.controller.abort(); active.delete(state.id); extraction.state = 'cancelled'; extraction.error = '主动画板指令优先，本次剧情提取已停止'; extraction.completedAt = Date.now(); saveAi(state) }
            if (active.has(state.id)) throw new Error('画板助手正在处理上一条请求')
            if (state.proposals.filter(proposal => proposal.status === 'pending').length >= 20) throw new Error('请先处理已有的待确认调整')
            const data = await collectSources(scope, options)
            const bound = await snapshotLocked(scope)
            if (input.mode !== 'initialize' && !bound) throw new Error('请先初始化或绑定世界')
            let core = bound ? coreOf(bound) : { world: groupActors(scope, createWorldWithDefaults(randomUUID(), '场景草稿', { now: Date.now() }), data.personaId), runtime: null as unknown as SpatialCoreState['runtime'] }
            if (!bound) core = { ...core, runtime: createEmptyRuntime(core.world.id, spatialRuntimeId(scope), Date.now()) }
            if (input.mode === 'initialize' && !isBlankSpatial(core)) throw new Error('当前地图已有地点或人物位置，不能重新初始化')
            const memberActors = core.world.actors.filter(actor => actor.externalRef.type === 'qingyu-character' && data.members.some(member => member.id === actor.externalRef.id))
            const personaActor = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === data.personaId)
            const actors = { members: memberActors.map(actor => actor.id), ...(personaActor ? { persona: personaActor.id } : {}) }
            const allowedIds = [...actors.members, actors.persona]
            const settings = readChatSettings(); const profile = resolveChatProfile(settings)
            if (!profile || !profile.model || !profile.baseUrl) throw new Error('请先配置当前聊天的连接和模型')
            const plan = resolveGenerationTaskBudget({ task: input.mode === 'initialize' ? 'spatial_initialize' : 'spatial_instruction', model: profile.model,
              expectedBodyChars: input.mode === 'initialize' ? 3200 : 1200, userHardCap: input.mode === 'initialize' ? 4096 : 2048,
              profileOverride: enabledProfileOverride(profile.capabilityOverride), reasoningLevel: 'off' })
            let history = state.messages.slice(-12).map(message => ({ role: message.role, content: message.content, mode: message.mode }))
            while (history.length && countTokens(JSON.stringify(history), profile.model) > 1500) history = history.slice(1)
            let map = { worldName: core.world.name, boards: core.world.boards.map(board => ({ id: board.id, name: board.name, parentEntryNodeId: board.parentEntryNodeId })),
              nodes: core.world.nodes.map(node => ({ id: node.id, kind: node.kind, name: node.name, boardId: node.boardId, parentNodeId: node.parentNodeId, childBoardId: node.childBoardId })),
              actors: core.world.actors.filter(actor => allowedIds.includes(actor.id)).map(actor => ({ id: actor.id, name: actor.displayName, kind: actor.kind })),
              placements: core.runtime.placements.filter(placement => allowedIds.includes(placement.actorId)).map(placement => ({ actorId: placement.actorId, boardId: placement.boardId, nodeId: placement.anchor.nodeId, position: placement.semanticPosition })),
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
            const systemPrompt = groupPrompt(input.mode)
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
              reasoningGate: { level: plan.reasoningGate.level, knob: plan.reasoningGate.knob, tokens: plan.reasoningGate.gateTokens }, observability: { source: 'aux', taskType: plan.task, characterId: `group:${scope.groupId}`, sessionId: scope.sessionId } }
            if (countTokens(JSON.stringify(params.messages), profile.model) + plan.requestMaxTokens + 128 > contextLimit) throw new Error('材料序列化后超出模型上下文预算，请减少来源或缩短指令')
            const controller = new AbortController()
            active.set(state.id, { taskId: input.requestId, controller, fingerprint: data.fingerprint, options })
            state.tasks.push({ id: input.requestId, requestHash, mode: input.mode, state: 'running', startedAt: Date.now(),
              profileId: settings.activeProfileId ?? undefined, model: profile.model, inputTokens: countTokens(JSON.stringify(params.messages), profile.model), croppedSources: cropped })
            state.messages.push({ id: randomUUID(), role: 'user', content: input.mode === 'initialize' ? `初始化场景${options.text ? `：${options.text}` : '：使用当前选定设定和正文'}` : options.text,
              mode: input.mode, createdAt: Date.now() })
            try { saveAi(state) } catch (error) { active.delete(state.id); throw error }
            return { state, core, actors, params, requestSources, sourceFingerprint: data.fingerprint, personaId: data.personaId,
              baseVersion: bound?.version ?? null, controller }
          })
          return prepared
        } finally { directPending.delete(directKey); dialogue.kick(scope) }
      })()
      if ('done' in prepared) return prepared.done!
      publish(scope)
      const { state, core, actors, params, requestSources, controller } = prepared
      try {
        const completion = await deps.complete(params, controller.signal, input.mode === 'initialize' ? 90000 : 60000)
        if (controller.signal.aborted) throw new Error('已停止画板助手请求')
        if (completion.finishReason === 'length' || completion.finishReason === 'content_filter' || !completion.text.trim()) throw new Error('画板 AI 输出不完整，请缩小范围后重试')
        const reply = parseSpatialAiReply(stripAllThinking(completion.text), input.mode, core, actors, requestSources, !!prepared.baseVersion, false)
        return await spatialRepository.locked(async () => {
          if (deleted.has(state.id)) return state
          if (active.get(state.id)?.controller !== controller) return loadAi(state.id)
          const latest = loadAi(state.id)
          if ((await collectSources(scope, options)).fingerprint !== prepared.sourceFingerprint) throw new Error('群聊成员、身份或来源已改变，本次结果已停止')
          if ((await sessionFor(scope)).spatialAiSessionId !== state.id) throw new Error('画板绑定已改变，本次结果已停止')
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
            ...(reply.preview ? { preview: { ...reply.preview, activeActorIds: [...actors.members, ...(actors.persona ? [actors.persona] : [])], version: { worldId: reply.preview.world.id, runtimeId: reply.preview.runtime.runtimeId,
              bindingEpoch: `draft_${proposalId}`, runtimeRevision: reply.preview.runtime.revision, worldFingerprint: worldFingerprint(reply.preview.world) } } } : {}) })
          latest.messages.push({ id: randomUUID(), role: 'assistant', content: reply.explanation, mode: input.mode,
            ...(reply.commands.length || reply.preview ? { proposalId } : {}), createdAt: Date.now() })
          saveAi(latest)
          return latest
        })
      } catch (error) {
        return await spatialRepository.locked(() => {
          if (deleted.has(state.id)) return state
          if (active.get(state.id)?.controller !== controller) return loadAi(state.id)
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
        if (ownsLease && !deleted.has(state.id)) dialogue.kick(scope)
      }
    },

    async cancel(scope: SpatialGroupScope): Promise<SpatialGroupAiSession> {
      const state = await spatialRepository.locked(async () => {
        const current = await refresh(scope)
        const lease = active.get(current.id)
        lease?.controller.abort()
        for (const task of current.tasks.filter(item => item.state === 'queued' || item.id === lease?.taskId && item.state === 'running')) { task.state = 'cancelled'; task.error = '用户停止请求'; task.completedAt = Date.now() }
        saveAi(current)
        return current
      })
      publish(scope); return state
    },

    async discard(scope: SpatialGroupScope, proposalId: string): Promise<SpatialGroupAiSession> {
      const result = await spatialRepository.locked(async () => {
        const state = await refresh(scope)
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

    async editDraft(scope: SpatialGroupScope, proposalId: string, input: SpatialEditorCommit) {
      const edited = await spatialRepository.locked(async () => {
        const state = await refresh(scope)
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
        validateGroupActorCommands(coreOf(preview), input.commands as SpatialCommand[], preview.activeActorIds ?? [])
        const base = proposal.baseVersion ? coreOf((await snapshotLocked(scope))!) : {
          world: { ...coreOf(preview).world, name: coreOf(preview).world.name,
            nodes: coreOf(preview).world.nodes.filter(node => node.tags.includes('system:offstage')), boards: coreOf(preview).world.boards.filter(board => board.id === coreOf(preview).world.rootBoardId), distances: [] },
          runtime: createEmptyRuntime(version.worldId, version.runtimeId, Date.now()) }
        const result = applyCommandBatch(coreOf(proposal.preview), { schemaVersion: 1, expectedRevision: version.runtimeRevision, commands: input.commands as SpatialCommand[] },
          { source: 'user', now: Date.now(), idGen: randomUUID })
        if (!result.ok) return { ok: false as const, code: result.code, message: result.message, snapshot: proposal.preview }
        assertInitializationPreview(base, result.state)
        const next = { ...result.state, activeActorIds: result.state.world.actors.filter(actor => actor.externalRef.type === 'qingyu-character' ? groupData.listGroups().find(group => group.id === scope.groupId)!.memberIds.includes(actor.externalRef.id) : actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === proposal.personaId).map(actor => actor.id), version: { ...version, runtimeRevision: result.state.runtime.revision, worldFingerprint: worldFingerprint(result.state.world) } }
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
    apply: (scope: SpatialGroupScope, proposalId: string, acknowledgeUnresolved = false) => apply(scope, proposalId, acknowledgeUnresolved),
  }
}

export const spatialGroupAiService = createSpatialGroupAiService()
