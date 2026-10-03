import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { applyCommandBatch, createEmptyRuntime, createWorldWithDefaults } from '@qingyu/spatial-core'
// eslint-disable-next-line no-restricted-imports
import type { SpatialCommand, SpatialCoreState, SpatialWorldDocumentV1 } from '@qingyu/spatial-core'
import type { Character, Persona, Settings, ChatSession, GroupSession } from '../../shared/types'
import type { SpatialCommitReceipt, SpatialCommitResult, SpatialEditorCommit, SpatialSnapshot, SpatialUpdatedEvent } from '../../shared/spatial'
import type { SpatialAiSession, SpatialGroupAiSession } from '../../shared/spatial-ai'
import { chatData } from '../ipc/chat'
import { groupData } from '../ipc/group'
import { safeId } from '../utils/pathGuard'
import { DIRS, listJsonFiles, readJson } from './storage'
import { hashSpatialValue, readSpatialJson, SpatialRepository, spatialPaths, validateSpatialPackage, worldFingerprint,
  isGroupScope, spatialRuntimeId, validateSpatialScope,
  type SpatialBinding, type SpatialScope, type SpatialOwnerScope, type SpatialGroupScope, type SpatialSessionState } from './spatialRepository'

export function sessionFor(scope: SpatialScope): Promise<ChatSession>
export function sessionFor(scope: SpatialGroupScope): Promise<GroupSession>
export function sessionFor(scope: SpatialOwnerScope): Promise<ChatSession | GroupSession>
export async function sessionFor(scope: SpatialOwnerScope): Promise<ChatSession | GroupSession> {
  validateSpatialScope(scope)
  if (isGroupScope(scope) && !groupData.listGroups().some(group => group.id === scope.groupId)) throw new Error('群聊不存在')
  const sessions = isGroupScope(scope) ? groupData.readSessions(scope.groupId) : await chatData.listSessions(scope.characterId)
  const session = sessions.find((item) => item.id === scope.sessionId)
  if (!session || (isGroupScope(scope) && (session as GroupSession).groupId !== scope.groupId)) throw new Error('画板所属会话不存在')
  return session
}

export const spatialRepository = new SpatialRepository({
  read: async (scope) => {
    const session = await sessionFor(scope)
    return { worldId: session.spatialWorldId ?? null, runtimeId: session.spatialRuntimeId ?? null }
  },
  compareAndSet: (scope, before, after) => isGroupScope(scope)
    ? groupData.updateSpatialBindingIfMatches(scope.groupId, scope.sessionId, before, after)
    : chatData.updateSpatialBindingIfMatches(scope.characterId, scope.sessionId, before, after),
})

export function stateFor(scope: SpatialOwnerScope, worldId: string, runtimeId: string): SpatialSessionState {
  const state = readSpatialJson<SpatialSessionState>(spatialPaths.state(scope))
  if (!state) {
    if (isGroupScope(scope)) throw new Error('群聊画板提交记录缺失，请恢复数据')
    return { schemaVersion: 1, worldId, runtimeId, bindingEpoch: 'legacy', commits: {} }
  }
  if (state.schemaVersion !== 1 || state.worldId !== worldId || state.runtimeId !== runtimeId ||
    typeof state.bindingEpoch !== 'string' || !state.commits || typeof state.commits !== 'object' || Array.isArray(state.commits)) {
    throw new Error('画板提交记录与当前绑定不一致')
  }
  return state
}

export async function snapshotLocked(scope: SpatialOwnerScope): Promise<SpatialSnapshot | null> {
  const session = await sessionFor(scope)
  if (!session.spatialWorldId) return null
  const world = readSpatialJson<SpatialWorldDocumentV1>(spatialPaths.world(session.spatialWorldId))
  const runtime = readSpatialJson<SpatialCoreState['runtime']>(spatialPaths.runtime(scope))
  if (!world) throw new Error('绑定的空间世界不存在或无法读取')
  if (!runtime) throw new Error('绑定的画板运行状态缺失，请恢复数据；不会自动重建位置')
  const runtimeId = session.spatialRuntimeId ?? spatialRuntimeId(scope)
  if (isGroupScope(scope) && runtimeId !== spatialRuntimeId(scope)) throw new Error('群聊画板运行状态属于其他会话')
  if (world.id !== session.spatialWorldId || runtime.worldId !== world.id || runtime.runtimeId !== runtimeId) {
    throw new Error('画板运行状态与会话绑定不一致')
  }
  validateSpatialPackage({ world, runtime })
  const state = stateFor(scope, world.id, runtimeId)
  return { world, runtime, ...(isGroupScope(scope) ? { activeActorIds: groupActorIds(scope, world, session.personaId) } : {}), version: { worldId: world.id, runtimeId, bindingEpoch: state.bindingEpoch,
    runtimeRevision: runtime.revision, worldFingerprint: worldFingerprint(world) } }
}

export function chatActors(world: SpatialWorldDocumentV1, characterId: string, personaId?: string | null): SpatialWorldDocumentV1 {
  const actors = [...world.actors]
  const character = readJson<Character>(join(DIRS.characters(), `${safeId(characterId)}.json`))
  if (character && !actors.some((actor) => actor.externalRef.type === 'qingyu-character' && actor.externalRef.id === characterId)) {
    actors.push({ id: randomUUID(), kind: 'character', externalRef: { type: 'qingyu-character', id: characterId },
      displayName: character.name || '角色', description: character.description?.slice(0, 4000) })
  }
  const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'))
  const effectivePersonaId = personaId === undefined ? settings?.defaultPersonaId : personaId
  if (effectivePersonaId) {
    const personas = readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []
    const persona = personas.find((item) => item.id === safeId(effectivePersonaId))
    if (persona && !actors.some((actor) => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === persona.id)) {
      actors.push({ id: randomUUID(), kind: 'persona', externalRef: { type: 'qingyu-persona', id: persona.id },
        displayName: persona.name || '用户', description: persona.description?.slice(0, 4000) })
    }
  }
  return { ...world, actors }
}

function groupMemberIds(scope: SpatialGroupScope): string[] {
  const group = groupData.listGroups().find(group => group.id === scope.groupId)
  if (!group || !Array.isArray(group.memberIds)) throw new Error('群聊成员索引无效')
  return [...new Set(group.memberIds.map(id => safeId(id)))]
}
function effectivePersona(personaId?: string | null): string | null {
  const id = personaId === undefined ? readJson<Settings>(join(DIRS.config(), 'settings.json'))?.defaultPersonaId : personaId
  return id ? safeId(id) : null
}
export function groupActors(scope: SpatialGroupScope, world: SpatialWorldDocumentV1, personaId?: string | null): SpatialWorldDocumentV1 {
  for (const id of groupMemberIds(scope)) world = chatActors(world, id, null)
  const actorPersonaId = effectivePersona(personaId)
  if (actorPersonaId) {
    const persona = (readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []).find(item => item.id === actorPersonaId)
    if (persona && !world.actors.some(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === persona.id)) {
      world = { ...world, actors: [...world.actors, { id: randomUUID(), kind: 'persona', externalRef: { type: 'qingyu-persona', id: persona.id }, displayName: persona.name || '用户', description: persona.description?.slice(0, 4000) }] }
    }
  }
  const ids = new Set(groupMemberIds(scope))
  const personas = readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []
  return { ...world, actors: world.actors.map(actor => {
    const ref = actor.externalRef
    const source = ref.type === 'qingyu-character' && ids.has(ref.id) ? readJson<Character>(join(DIRS.characters(), `${safeId(ref.id)}.json`))
      : ref.type === 'qingyu-persona' && ref.id === actorPersonaId ? personas.find(item => item.id === ref.id) : undefined
    return source ? { ...actor, displayName: source.name || (actor.kind === 'persona' ? '用户' : '角色') } : actor
  }) }
}
function groupActorIds(scope: SpatialGroupScope, world: SpatialWorldDocumentV1, personaId?: string | null): string[] {
  const members = new Set(groupMemberIds(scope)), persona = effectivePersona(personaId)
  const personaExists = (readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []).some(item => item.id === persona)
  return world.actors.filter(actor => actor.externalRef.type === 'qingyu-character' ? members.has(actor.externalRef.id)
    : actor.externalRef.type === 'qingyu-persona' && personaExists && actor.externalRef.id === persona).map(actor => actor.id)
}
export async function syncGroupLocked(scope: SpatialGroupScope): Promise<SpatialSnapshot | null> {
  const snapshot = await snapshotLocked(scope)
  if (!snapshot) return null
  const session = await sessionFor(scope)
  const world = groupActors(scope, snapshot.world as SpatialWorldDocumentV1, session.personaId)
  if (hashSpatialValue(world) !== hashSpatialValue(snapshot.world)) {
    world.metadata = { ...world.metadata, updatedAt: Date.now() }
    const runtime = snapshot.runtime as SpatialCoreState['runtime']
    validateSpatialPackage({ world, runtime })
    await spatialRepository.persist(scope, world.id, randomUUID(), { world, runtime, state: stateFor(scope, world.id, runtime.runtimeId) })
  }
  return snapshotLocked(scope)
}
export function validateGroupActorCommands(core: SpatialCoreState, commands: SpatialCommand[], activeIds: string[]): void {
  const active = new Set(activeIds)
  for (const command of commands) {
    if (command.type === 'create_actor' || command.type === 'delete_actor' ||
      command.type === 'update_actor') throw new Error('群聊角色映射由当前成员和用户身份管理')
    if ('actorId' in command && (!active.has(command.actorId) || !core.world.actors.some(actor => actor.id === command.actorId))) throw new Error('该角色不属于当前群聊成员或用户身份')
  }
}

function protectSharedReferences(ownerScope: SpatialOwnerScope, before: SpatialCoreState, after: SpatialCoreState): void {
  const changedNodes = new Set(before.world.nodes.filter((node) => {
    const next = after.world.nodes.find((item) => item.id === node.id)
    return !next || next.boardId !== node.boardId || next.parentNodeId !== node.parentNodeId || next.childBoardId !== node.childBoardId
  }).map((node) => node.id))
  const changedBoards = new Set(before.world.boards.filter((board) => {
    const next = after.world.boards.find((item) => item.id === board.id)
    return !next || next.parentEntryNodeId !== board.parentEntryNodeId
  }).map((board) => board.id))
  const changedActors = new Set(before.world.actors.filter((actor) => {
    const next = after.world.actors.find((item) => item.id === actor.id)
    return !next || hashSpatialValue(next.externalRef) !== hashSpatialValue(actor.externalRef)
  }).map((actor) => actor.id))
  let grew = true
  while (grew) {
    grew = false
    for (const board of before.world.boards) {
      if (board.parentEntryNodeId && changedNodes.has(board.parentEntryNodeId) && !changedBoards.has(board.id)) {
        changedBoards.add(board.id); grew = true
      }
    }
    for (const node of before.world.nodes) {
      if ((changedBoards.has(node.boardId) || (node.parentNodeId && changedNodes.has(node.parentNodeId))) && !changedNodes.has(node.id)) {
        changedNodes.add(node.id); grew = true
      }
    }
  }
  const affected: string[] = []
  for (const { scope, runtime } of spatialRepository.runtimes()) {
    if (runtime.worldId !== before.world.id) continue
    // 本会话的位置已随命令批次更新并校验，不能再用落盘的旧位置拦截自身。
    if (spatialPaths.runtime(scope) === spatialPaths.runtime(ownerScope)) continue
    validateSpatialPackage({ world: before.world, runtime })
    if (runtime.placements.some((placement) => changedActors.has(placement.actorId) || changedBoards.has(placement.boardId) ||
      (placement.anchor.nodeId && changedNodes.has(placement.anchor.nodeId)) ||
      placement.semanticPosition.containmentPath.some((id) => changedNodes.has(id)) ||
      (placement.semanticPosition.relativeToNodeId && changedNodes.has(placement.semanticPosition.relativeToNodeId)))) {
      affected.push(`${isGroupScope(scope) ? `群聊 ${scope.groupId}` : scope.characterId}/${scope.sessionId}`)
    } else {
      validateSpatialPackage({ world: after.world, runtime })
    }
  }
  if (affected.length) throw new Error(`结构调整被拒绝：仍被会话引用 ${affected.join('、')}；请先调整角色位置`)
}

const updateListeners = new Set<(event: SpatialUpdatedEvent) => void>()
function publish(event: SpatialUpdatedEvent) { for (const listener of updateListeners) listener(event) }

/** 仅供主进程助手服务：正式状态与助手确认结果进入同一事务。 */
export interface SpatialCompanion {
  id: string
  expectedHash: string
  validate: () => Promise<void>
  complete: (receipt: SpatialCommitReceipt, snapshot: SpatialSnapshot) => SpatialAiSession | SpatialGroupAiSession
}
async function validateCompanion(companion: SpatialCompanion): Promise<void> {
  if (hashSpatialValue(readSpatialJson(spatialPaths.ai(companion.id))) !== companion.expectedHash) throw new Error('助手会话已更新，请刷新后核对提案')
  await companion.validate()
}

async function createBinding(scope: SpatialOwnerScope, name?: string, existingWorldId?: string, reuse = false): Promise<SpatialSnapshot> {
  const commitId = randomUUID()
  const snapshot = await spatialRepository.locked(async () => {
    const session = await sessionFor(scope)
    if (reuse && session.spatialWorldId) return (await snapshotLocked(scope))!
    if (session.spatialWorldId) throw new Error('当前会话已绑定画板')
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!existingWorldId && (!trimmed || trimmed.length > 128)) throw new Error('世界名称需为 1–128 字')
    const stored = existingWorldId ? readSpatialJson<SpatialWorldDocumentV1>(spatialPaths.world(existingWorldId)) : null
    if (existingWorldId && !stored) throw new Error('空间世界不存在或无法读取')
    if (readSpatialJson(spatialPaths.runtime(scope))) throw new Error('发现已有位置文件，请先恢复原绑定，不能覆盖')
    const initial = stored ?? createWorldWithDefaults(randomUUID(), trimmed, { now: Date.now() })
    const world = isGroupScope(scope) ? groupActors(scope, initial, session.personaId) : chatActors(initial, scope.characterId, session.personaId)
    const runtime = createEmptyRuntime(world.id, spatialRuntimeId(scope), Date.now())
    validateSpatialPackage({ world, runtime })
    const state: SpatialSessionState = { schemaVersion: 1, worldId: world.id, runtimeId: runtime.runtimeId,
      bindingEpoch: randomUUID(), commits: {}, initialization: { commitId, mode: existingWorldId ? 'bound' : 'blank', createdAt: Date.now() } }
    const before: SpatialBinding = { worldId: session.spatialWorldId ?? null, runtimeId: session.spatialRuntimeId ?? null }
    await spatialRepository.persist(scope, world.id, commitId, { world, runtime, state },
      { before, after: { worldId: world.id, runtimeId: runtime.runtimeId } })
    return (await snapshotLocked(scope))!
  })
  publish({ ...scope, worldId: snapshot.version.worldId, commitId })
  return snapshot
}

export const spatialService = {
  /** 开关保存到会话；首次开启自动建图，重新开启保留原来的地图和位置。 */
  async setEnabled(scope: SpatialOwnerScope, enabled: boolean): Promise<SpatialSnapshot | null> {
    if (typeof enabled !== 'boolean') throw new Error('画板开关参数无效')
    validateSpatialScope(scope)
    const snapshot = enabled ? await createBinding(scope, '会话画板', undefined, true) : null
    await spatialRepository.locked(async () => {
      const session = await sessionFor(scope)
      const updates = { spatialBoardEnabled: enabled, ...(enabled ? {
        spatialContextEnabled: session.spatialContextEnabled ?? true,
        spatialNarrativeSyncPolicy: session.spatialNarrativeSyncPolicy ?? 'suggest',
      } : {}) }
      if (isGroupScope(scope)) await groupData.updateSession(scope.groupId, scope.sessionId, updates)
      else await chatData.updateSession(scope.characterId, scope.sessionId, updates)
    })
    return snapshot
  },
  onUpdated: (listener: (event: SpatialUpdatedEvent) => void) => { updateListeners.add(listener); return () => { updateListeners.delete(listener) } },
  recoverTransactions: () => spatialRepository.locked(() => undefined),
  async notifyRestored(): Promise<void> {
    const events = await spatialRepository.locked(async () => {
      const result: SpatialUpdatedEvent[] = []
      for (const { scope } of spatialRepository.runtimes()) {
        const snapshot = await snapshotLocked(scope)
        if (snapshot) result.push({ ...scope, worldId: snapshot.version.worldId, commitId: `restore_${randomUUID()}` })
      }
      return result
    })
    for (const event of events) publish(event)
  },
  listWorlds: () => spatialRepository.locked(() => listJsonFiles<SpatialWorldDocumentV1>(join(DIRS.spatial(), 'worlds'))
    .filter((world) => world.schemaVersion === 1 && typeof world.id === 'string')
    .map((world) => ({ id: world.id, name: world.name, updatedAt: world.metadata?.updatedAt ?? 0 })).sort((a, b) => b.updatedAt - a.updatedAt)),
  loadBound: (characterId: string, sessionId: string) => spatialRepository.locked(() => snapshotLocked({ characterId, sessionId })),
  createAndBind: (characterId: string, sessionId: string, name: string) => createBinding({ characterId, sessionId }, name),
  bindWorld: (characterId: string, sessionId: string, worldId: string) => createBinding({ characterId, sessionId }, undefined, safeId(worldId)),
  loadGroupBound: (groupId: string, sessionId: string) => spatialRepository.locked(() => syncGroupLocked({ kind: 'group', groupId, sessionId })),
  createGroupAndBind: (groupId: string, sessionId: string, name: string) => createBinding({ kind: 'group', groupId, sessionId }, name),
  bindGroupWorld: (groupId: string, sessionId: string, worldId: string) => createBinding({ kind: 'group', groupId, sessionId }, undefined, safeId(worldId)),
  applyGroupEditorBatch: (groupId: string, sessionId: string, input: SpatialEditorCommit, companion?: SpatialCompanion, initialization?: { sourceFingerprint: string }, story = false) => applyEditorBatch({ kind: 'group', groupId, sessionId }, input, companion, initialization, story),
  async refreshGroup(groupId: string, sessionId?: string): Promise<void> {
    const events = await spatialRepository.locked(async () => {
      const scopes = spatialRepository.runtimes().map(item => item.scope).filter((scope): scope is SpatialGroupScope => isGroupScope(scope) && scope.groupId === groupId && (!sessionId || scope.sessionId === sessionId))
      const events: SpatialUpdatedEvent[] = []
      for (const scope of scopes) {
        const snapshot = await syncGroupLocked(scope)
        if (snapshot) events.push({ ...scope, worldId: snapshot.version.worldId, commitId: `members_${randomUUID()}` })
      }
      return events
    })
    for (const event of events) publish(event)
  },
  async deleteGroupScope(groupId: string, sessionId?: string): Promise<void> {
    safeId(groupId)
    if (sessionId) safeId(sessionId)
    await spatialRepository.locked(async () => {
      const sessions = groupData.readSessions(groupId).filter(session => !sessionId || session.id === sessionId)
      for (const session of sessions) {
        const scope: SpatialGroupScope = { kind: 'group', groupId, sessionId: session.id }
        await groupData.updateSpatialBindingIfMatches(groupId, session.id,
          { worldId: session.spatialWorldId ?? null, runtimeId: session.spatialRuntimeId ?? null }, { worldId: null, runtimeId: null })
        for (const path of [spatialPaths.runtime(scope), spatialPaths.state(scope)]) if (existsSync(path)) unlinkSync(path)
      }
    })
  },

  initializeFromDraft: async (scope: SpatialOwnerScope, core: SpatialCoreState, commitId: string, sourceFingerprint: string, companion: SpatialCompanion): Promise<SpatialSnapshot> => {
    const snapshot = await spatialRepository.locked(async () => {
      await validateCompanion(companion)
      const session = await sessionFor(scope)
      if (session.spatialWorldId || readSpatialJson(spatialPaths.runtime(scope))) throw new Error('会话已有画板或位置文件，请刷新后核对')
      validateSpatialPackage(core)
      if (core.runtime.runtimeId !== spatialRuntimeId(scope)) throw new Error('初始化运行状态范围无效')
      const bindingEpoch = randomUUID()
      const version = { worldId: core.world.id, runtimeId: core.runtime.runtimeId, bindingEpoch,
        runtimeRevision: core.runtime.revision, worldFingerprint: worldFingerprint(core.world) }
      const result: SpatialSnapshot = { ...core, version, ...(isGroupScope(scope) ? { activeActorIds: groupActorIds(scope, core.world, session.personaId) } : {}) }
      const receipt = { commitId, revisionBefore: 0, revisionAfter: core.runtime.revision, worldFingerprintAfter: version.worldFingerprint }
      const state: SpatialSessionState = { schemaVersion: 1, worldId: core.world.id, runtimeId: core.runtime.runtimeId, bindingEpoch,
        initialization: { commitId, mode: 'generated', sourceFingerprint, createdAt: Date.now() },
        commits: { [commitId]: { requestHash: hashSpatialValue({ core, sourceFingerprint }), receipt, inverse: [] } } }
      await spatialRepository.persist(scope, core.world.id, commitId,
        { ...core, state, ai: companion.complete(receipt, result) },
        { before: { worldId: null, runtimeId: session.spatialRuntimeId ?? null }, after: { worldId: core.world.id, runtimeId: core.runtime.runtimeId } }, companion.id)
      return result
    })
    publish({ ...scope, worldId: snapshot.version.worldId, commitId })
    return snapshot
  },

  applyEditorBatch: (characterId: string, sessionId: string, input: SpatialEditorCommit, companion?: SpatialCompanion,
    initialization?: { sourceFingerprint: string }, story = false) => applyEditorBatch({ characterId, sessionId }, input, companion, initialization, story),
}

async function applyEditorBatch(scope: SpatialOwnerScope, input: SpatialEditorCommit, companion?: SpatialCompanion,
  initialization?: { sourceFingerprint: string }, story = false): Promise<SpatialCommitResult> {
  const result = await spatialRepository.locked(async (): Promise<SpatialCommitResult> => {
    const snapshot = isGroupScope(scope) ? await syncGroupLocked(scope) : await snapshotLocked(scope)
    if (!snapshot) throw new Error('当前会话没有绑定画板')
    const version = snapshot.version
    if (companion) await validateCompanion(companion)
    if (!input || typeof input !== 'object' || !Array.isArray(input.commands) ||
      input.commands.length < 1 || input.commands.length > 1000 ||
      !Number.isSafeInteger(input.expectedRuntimeRevision) || input.expectedRuntimeRevision < 0 ||
      typeof input.expectedWorldFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedWorldFingerprint) ||
      Buffer.byteLength(JSON.stringify(input)) > 5 * 1024 * 1024) throw new Error('画板命令批次无效')
    safeId(input.commitId)
    if (input.worldId !== version.worldId || input.runtimeId !== version.runtimeId || input.bindingEpoch !== version.bindingEpoch) {
      return { ok: false, code: 'binding_conflict', message: '画板数据与当前会话绑定不一致', snapshot }
    }
    const { commitId: _id, ...request } = input
    const requestHash = hashSpatialValue(request)
    const state = stateFor(scope, version.worldId, version.runtimeId)
    const previous = Object.prototype.hasOwnProperty.call(state.commits, input.commitId) ? state.commits[input.commitId] : undefined
    if (previous) {
      if (previous.requestHash !== requestHash) return { ok: false, code: 'commit_id_conflict', message: '提交 ID 已用于不同操作', snapshot }
      return { ok: true, snapshot, receipt: previous.receipt, duplicate: true }
    }
    if (input.expectedRuntimeRevision !== version.runtimeRevision || input.expectedWorldFingerprint !== version.worldFingerprint) {
      return { ok: false, code: 'version_conflict', message: '画板已更新，已保留未提交操作；请核对最新状态', snapshot }
    }
    const core = { world: snapshot.world, runtime: snapshot.runtime } as SpatialCoreState
    let applied
    try {
      if (isGroupScope(scope)) validateGroupActorCommands(core, input.commands as SpatialCommand[], snapshot.activeActorIds ?? [])
      applied = applyCommandBatch(core, { schemaVersion: 1, expectedRevision: version.runtimeRevision, commands: input.commands as SpatialCommand[] },
        { now: Date.now(), source: initialization ? 'system' : story ? 'story' : 'user', idGen: randomUUID })
      if (!applied.ok) return { ok: false, code: applied.code, message: applied.message, snapshot }
      validateSpatialPackage(applied.state)
      protectSharedReferences(scope, core, applied.state)
    } catch (error) {
      return { ok: false, code: 'command_invalid', message: error instanceof Error ? error.message : String(error), snapshot }
    }
    const receipt = { commitId: input.commitId, revisionBefore: version.runtimeRevision,
      revisionAfter: applied.state.runtime.revision, worldFingerprintAfter: worldFingerprint(applied.state.world) }
    const nextState: SpatialSessionState = { ...state, commits: { ...state.commits,
      [input.commitId]: { requestHash, receipt, inverse: applied.inverse } },
      ...(initialization ? { initialization: { commitId: input.commitId, mode: 'generated' as const, sourceFingerprint: initialization.sourceFingerprint, createdAt: Date.now() } } : {}) }
    const committed: SpatialSnapshot = { ...applied.state, version: { ...version, runtimeRevision: receipt.revisionAfter, worldFingerprint: receipt.worldFingerprintAfter } }
    await spatialRepository.persist(scope, version.worldId, input.commitId, { ...applied.state, state: nextState,
      ...(companion ? { ai: companion.complete(receipt, committed) } : {}) }, undefined, companion?.id)
    return { ok: true, snapshot: (await snapshotLocked(scope))!, receipt, duplicate: false }
  })
  if (result.ok && !result.duplicate) publish({ ...scope, worldId: result.snapshot.version.worldId, commitId: input.commitId })
  return result
}
