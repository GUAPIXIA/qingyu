/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { IpcMain } from 'electron'
import type { GroupChat, GroupSession } from '../../../shared/types'
import type { SpatialEditorCommit, SpatialSnapshot } from '../../../shared/spatial'
import type { SpatialCommand, SpatialCoreState } from '@qingyu/spatial-core'

const root = join(tmpdir(), 'qingyu-spatial-group-test')
vi.mock('electron', () => ({ app: { getPath: () => root, getVersion: () => 'test' }, safeStorage: { isEncryptionAvailable: () => false } }))
import { groupData, registerGroupIPC } from '../../ipc/group'
import { spatialRepository, spatialService } from '../../features/spatial/commitService'
import { spatialPaths, spatialRuntimeId, validateSpatialScope, hashSpatialValue, type SpatialGroupScope, type SpatialSessionState } from '../../features/spatial/repository'
import * as storage from '../storage'
import { createBackupV2, restoreBackupV2 } from '../backup'
import { onGroupSessionDeleting, onGroupSpatialSourceChanged, notifyGroupSpatialActorsChanged } from '../groupLifecycle'

type Snapshot = SpatialSnapshot & SpatialCoreState
const scope: SpatialGroupScope = { kind: 'group', groupId: 'group-a', sessionId: 'same-session' }
const group = (id = scope.groupId, memberIds = ['char-a', 'char-b']): GroupChat => ({ id, name: '夜谈', memberIds,
  currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 100,
  lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 1, updatedAt: 1 })
const session = (groupId: string, id = scope.sessionId): GroupSession => ({ id, groupId, spatialBoardEnabled: true, title: '开场', messageCount: 0, createdAt: 1, updatedAt: 1, personaId: 'persona-a' })
const view = (snapshot: SpatialSnapshot | null) => snapshot as Snapshot
const load = async (groupId = scope.groupId, sessionId = scope.sessionId) => view(await spatialService.loadGroupBound(groupId, sessionId))
const create = async () => view(await spatialService.createGroupAndBind(scope.groupId, scope.sessionId, '青石城'))
const request = (snapshot: Snapshot, commands: SpatialCommand[]): SpatialEditorCommit => ({ commitId: randomUUID(),
  worldId: snapshot.version.worldId, runtimeId: snapshot.version.runtimeId, bindingEpoch: snapshot.version.bindingEpoch,
  expectedRuntimeRevision: snapshot.version.runtimeRevision, expectedWorldFingerprint: snapshot.version.worldFingerprint, commands })
const commit = (input: SpatialEditorCommit, groupId = scope.groupId, sessionId = scope.sessionId) => spatialService.applyGroupEditorBatch(groupId, sessionId, input)
const place = (snapshot: Snapshot, actorId = snapshot.activeActorIds![0]): SpatialCommand => ({ type: 'place_actor', actorId,
  placement: { boardId: snapshot.world.rootBoardId, anchor: { kind: 'board' }, position: { x: 400, y: 250 }, semanticPosition: { precision: 'approximate' } } })
const write = storage.writeJson
beforeEach(() => {
  rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true })
  for (const id of ['char-a', 'char-b', 'char-c']) write(join(storage.DIRS.characters(), `${id}.json`), { id, name: id, description: '' })
  write(join(storage.DIRS.config(), 'settings.json'), { defaultPersonaId: 'persona-a' })
  write(join(storage.DIRS.config(), 'personas.json'), [{ id: 'persona-a', name: '旅人' }, { id: 'persona-b', name: '旁观者' }])
  write(join(storage.DIRS.groups(), 'index.json'), [group(), group('group-b')])
  for (const id of ['group-a', 'group-b']) write(join(storage.DIRS.groups(), id, 'sessions.json'), [session(id), session(id, 'session-b')])
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

describe('群聊空间阶段 0', () => {
  it('空白初始化按成员 ID 映射多个角色和当前身份，位置保持未知', async () => {
    const snapshot = await create()
    expect(snapshot.world.actors.map(actor => actor.externalRef.id)).toEqual(['char-a', 'char-b', 'persona-a'])
    expect(snapshot.activeActorIds).toHaveLength(3)
    expect(snapshot.runtime.placements).toEqual([])
    expect(snapshot.runtime.runtimeId).toBe(spatialRuntimeId(scope))
    expect(groupData.readSessions(scope.groupId)[0]).toMatchObject({ spatialWorldId: snapshot.world.id, spatialRuntimeId: snapshot.runtime.runtimeId })
  })
  it('同一世界在两个群聊及两个会话中复用，位置和运行身份完全隔离', async () => {
    const first = await create()
    const second = view(await spatialService.bindGroupWorld(scope.groupId, 'session-b', first.world.id))
    const other = view(await spatialService.bindGroupWorld('group-b', scope.sessionId, first.world.id))
    expect(new Set([first, second, other].map(item => item.runtime.runtimeId)).size).toBe(3)
    expect(await commit(request(first, [place(first)]))).toMatchObject({ ok: true })
    expect((await load()).runtime.placements).toHaveLength(1)
    expect((await load(scope.groupId, 'session-b')).runtime.placements).toEqual([])
    expect((await load('group-b')).runtime.placements).toEqual([])
  })
  it('单聊和群聊即使 ownerId、sessionId 相同也使用不同目录和运行身份', async () => {
    write(join(storage.DIRS.characters(), `${scope.groupId}.json`), { id: scope.groupId, name: '同名角色' })
    write(join(storage.DIRS.chats(), scope.groupId, 'sessions.json'), [{ ...session(scope.groupId), characterId: scope.groupId }])
    const single = view(await spatialService.createAndBind(scope.groupId, scope.sessionId, '单聊'))
    const shared = view(await spatialService.bindGroupWorld(scope.groupId, scope.sessionId, single.world.id))
    expect(spatialPaths.runtime(scope)).not.toBe(spatialPaths.runtime({ characterId: scope.groupId, sessionId: scope.sessionId }))
    expect(await commit(request(shared, [place(shared)]))).toMatchObject({ ok: true })
    expect(view(await spatialService.loadBound(scope.groupId, scope.sessionId)).runtime.placements).toEqual([])
  })
  it('拒绝跨群聊、跨会话提交和混合归属，不能将群聊当作首位成员单聊', async () => {
    const first = await create(), other = view(await spatialService.bindGroupWorld('group-b', scope.sessionId, first.world.id))
    expect(await commit(request(other, [place(other)]))).toMatchObject({ ok: false, code: 'binding_conflict' })
    expect(() => validateSpatialScope({ ...scope, characterId: 'char-a' } as SpatialGroupScope)).toThrow('不能包含单聊')
    expect(() => validateSpatialScope({ ...scope, kind: 'bad' } as unknown as SpatialGroupScope)).toThrow('范围无效')
    await expect(spatialService.loadGroupBound('missing', scope.sessionId)).rejects.toThrow('群聊不存在')
    expect((await load()).runtime.revision).toBe(0)
  })
  it('成员加入、移出和改名保留稳定 actor ID，移出成员位置保留但不参与视图', async () => {
    const first = await create(), actorId = first.activeActorIds![0]
    await commit(request(first, [place(first, actorId)]))
    write(join(storage.DIRS.characters(), 'char-a.json'), { id: 'char-a', name: '新名字' })
    await groupData.saveGroup(group(scope.groupId, ['char-a', 'char-c']))
    const added = await load()
    expect(added.world.actors.find(actor => actor.id === actorId)?.displayName).toBe('新名字')
    const newActor = added.world.actors.find(actor => actor.externalRef.id === 'char-c')!
    expect(added.activeActorIds).toContain(newActor.id)
    expect(added.runtime.placements.some(placement => placement.actorId === newActor.id)).toBe(false)
    await groupData.saveGroup(group(scope.groupId, ['char-c']))
    const removed = await load()
    expect(removed.activeActorIds).not.toContain(actorId)
    expect(removed.runtime.placements[0].actorId).toBe(actorId)
    expect(await commit(request(removed, [{ type: 'remove_actor_from_board', actorId }]))).toMatchObject({ ok: false, code: 'command_invalid' })
  })
  it('用户身份切换不继承旧身份的位置；null 无用户实体，undefined 使用全局默认', async () => {
    const first = await create(), persona = first.world.actors.find(actor => actor.kind === 'persona')!
    await commit(request(first, [place(first, persona.id)]))
    await groupData.updateSession(scope.groupId, scope.sessionId, { personaId: 'persona-b' })
    const changed = await load(), next = changed.world.actors.find(actor => actor.externalRef.id === 'persona-b')!
    expect(changed.activeActorIds).toContain(next.id); expect(changed.activeActorIds).not.toContain(persona.id)
    expect(changed.runtime.placements.some(placement => placement.actorId === next.id)).toBe(false)
    await groupData.updateSession(scope.groupId, scope.sessionId, { personaId: null })
    expect((await load()).activeActorIds).toHaveLength(2)
    const sessions = groupData.readSessions(scope.groupId); delete sessions[0].personaId
    write(join(storage.DIRS.groups(), scope.groupId, 'sessions.json'), sessions)
    expect((await load()).activeActorIds).toContain(persona.id)
  })
  it('重复提交返回原收据，手动撤销以反向命令保存并可重开读取', async () => {
    const first = await create(), input = request(first, [place(first)])
    expect(await commit(input)).toMatchObject({ ok: true, duplicate: false })
    expect(await commit(input)).toMatchObject({ ok: true, duplicate: true, receipt: { revisionAfter: 1 } })
    const state = storage.readJson<SpatialSessionState>(spatialPaths.state(scope))!
    expect(await commit(request(await load(), [...state.commits[input.commitId].inverse].reverse()))).toMatchObject({ ok: true })
    expect((await load()).runtime.placements).toEqual([])
    expect((await load()).runtime.revision).toBe(2)
  })
  it('共享地图更新拒绝旧基线；一个非法命令使整批不落盘', async () => {
    const first = await create(), second = view(await spatialService.bindGroupWorld('group-b', scope.sessionId, first.world.id))
    await commit(request(second, [{ type: 'update_world', patch: { name: '新世界' } }]), 'group-b')
    expect(await commit(request(first, [place(first)]))).toMatchObject({ ok: false, code: 'version_conflict' })
    const current = await load()
    expect(await commit(request(current, [place(current), { type: 'move_actor', actorId: 'missing', to: { boardId: current.world.rootBoardId, anchor: { kind: 'board' }, position: { x: 500, y: 300 } } }]))).toMatchObject({ ok: false })
    expect((await load()).runtime.placements).toEqual([])
  })
  it('共享结构保护遍历群聊运行状态，单聊也不能删除被群聊使用的角色', async () => {
    const first = await create(); await commit(request(first, [place(first)]))
    write(join(storage.DIRS.chats(), 'char-a', 'sessions.json'), [{ id: 'single', characterId: 'char-a' }])
    const single = view(await spatialService.bindWorld('char-a', 'single', first.world.id))
    const result = await spatialService.applyEditorBatch('char-a', 'single', request(single, [{ type: 'delete_actor', actorId: first.activeActorIds![0] }]))
    expect(result).toMatchObject({ ok: false, code: 'command_invalid' })
    if (!result.ok) expect(result.message).toContain('群聊 group-a')
  })
  it('写入中断按群聊归属恢复，保留同时更新的标题，重试不重复应用', async () => {
    const first = await create(), input = request(first, [place(first)])
    const original = storage.writeJson
    vi.spyOn(storage, 'writeJson').mockImplementation((path, value) => {
      if (path === spatialPaths.state(scope)) throw new Error('故障注入')
      return original(path, value)
    })
    await expect(commit(input)).rejects.toThrow('故障注入')
    await groupData.renameSession(scope.groupId, scope.sessionId, '同时改名')
    vi.restoreAllMocks()
    await spatialService.recoverTransactions()
    expect(groupData.readSessions(scope.groupId)[0].title).toBe('同时改名')
    expect(await commit(input)).toMatchObject({ ok: true, duplicate: true })
    expect((await load()).runtime.placements).toHaveLength(1)
    expect(readdirSync(join(storage.DIRS.spatial(), 'transactions'))).toEqual([])
  })
  it('缺失提交记录或损坏运行状态不会重新建图覆盖', async () => {
    await create(); unlinkSync(spatialPaths.state(scope))
    await expect(load()).rejects.toThrow('提交记录缺失')
    await expect(spatialService.createGroupAndBind(scope.groupId, scope.sessionId, '覆盖')).rejects.toThrow('已绑定')
  })
  it('成员变化广播包含群聊归属及共享地图身份', async () => {
    const first = await create(), listener = vi.fn(), unsubscribe = spatialService.onUpdated(listener)
    await groupData.saveGroup(group(scope.groupId, ['char-a', 'char-c']))
    await spatialService.refreshGroup(scope.groupId)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'group', groupId: scope.groupId, sessionId: scope.sessionId, worldId: first.world.id }))
    unsubscribe()
  })
  it('默认身份和身份资料变化按群聊广播；删除身份仅隐藏旧实体并保留位置', async () => {
    const first = await create(), persona = first.world.actors.find(actor => actor.kind === 'persona')!
    await commit(request(first, [place(first, persona.id)]))
    const changed = vi.fn().mockResolvedValue(undefined), remove = onGroupSpatialSourceChanged(changed)
    try {
      notifyGroupSpatialActorsChanged('char-a')
      expect(changed).toHaveBeenCalledWith({ groupId: 'group-a' }); expect(changed).toHaveBeenCalledWith({ groupId: 'group-b' })
      changed.mockClear(); notifyGroupSpatialActorsChanged('missing'); expect(changed).not.toHaveBeenCalled()
    } finally { remove() }
    write(join(storage.DIRS.config(), 'personas.json'), [{ id: 'persona-b', name: '旁观者' }])
    const after = await load()
    expect(after.activeActorIds).not.toContain(persona.id)
    expect(after.runtime.placements[0].actorId).toBe(persona.id)
  })
  it('群会话删除入口清理自己的运行状态，保留共享世界及其他群聊位置', async () => {
    const first = await create(), other = view(await spatialService.bindGroupWorld('group-b', scope.sessionId, first.world.id))
    await commit(request(other, [place(other)]), 'group-b')
    const remove = onGroupSessionDeleting(({ groupId, sessionId }) => spatialService.deleteGroupScope(groupId, sessionId))
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerGroupIPC({ handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } as unknown as IpcMain)
    try { await handlers.get('group:deleteSession')!(null, scope.groupId, scope.sessionId) } finally { remove() }
    expect(existsSync(spatialPaths.runtime(scope))).toBe(false)
    expect(existsSync(spatialPaths.state(scope))).toBe(false)
    expect(existsSync(spatialPaths.world(first.world.id))).toBe(true)
    expect((await load('group-b')).runtime.placements).toHaveLength(1)
    expect(spatialRepository.runtimes()).toHaveLength(1)
  })
  it('真实备份往返包含群聊绑定、位置、反向命令和提交去重记录', async () => {
    const first = await create(), input = request(first, [place(first)])
    await commit(input)
    const zip = join(root, 'backup.zip'); createBackupV2(zip)
    await commit(request(await load(), [{ type: 'remove_actor_from_board', actorId: first.activeActorIds![0] }]))
    restoreBackupV2(zip)
    expect((await load()).runtime.placements).toHaveLength(1)
    expect(await commit(input)).toMatchObject({ ok: true, duplicate: true })
    const state = storage.readJson<SpatialSessionState>(spatialPaths.state(scope))!
    expect(await commit(request(await load(), [...state.commits[input.commitId].inverse].reverse()))).toMatchObject({ ok: true })
    expect((await load()).runtime.placements).toEqual([])
  })
  it('备份恢复允许中断群聊事务的 before/after 混合文件，恢复后保持去重', async () => {
    const first = await create(), input = request(first, [place(first)])
    const original = storage.writeJson
    vi.spyOn(storage, 'writeJson').mockImplementation((path, value) => {
      if (path === spatialPaths.state(scope)) throw new Error('故障注入')
      return original(path, value)
    })
    await expect(commit(input)).rejects.toThrow('故障注入'); vi.restoreAllMocks()
    const zip = join(root, 'interrupted.zip'); createBackupV2(zip); restoreBackupV2(zip)
    await spatialService.recoverTransactions()
    expect(await commit(input)).toMatchObject({ ok: true, duplicate: true })
    expect((await load()).runtime.placements).toHaveLength(1)
  })
  for (const fault of ['missing-group', 'missing-session', 'missing-state', 'foreign-runtime', 'foreign-state', 'foreign-transaction', 'mixed-owner'] as const) {
    it(`备份归属预检拒绝 ${fault}，不覆盖已有数据`, async () => {
      const first = await create()
      if (fault === 'missing-group') write(join(storage.DIRS.groups(), 'index.json'), [group('group-b')])
      if (fault === 'missing-session') write(join(storage.DIRS.groups(), scope.groupId, 'sessions.json'), [session(scope.groupId, 'session-b')])
      if (fault === 'missing-state') unlinkSync(spatialPaths.state(scope))
      if (fault === 'foreign-runtime') write(spatialPaths.runtime(scope), { ...first.runtime, runtimeId: spatialRuntimeId({ ...scope, groupId: 'group-b' }) })
      if (fault === 'foreign-state') write(spatialPaths.state(scope), { ...storage.readJson<SpatialSessionState>(spatialPaths.state(scope))!, runtimeId: 'foreign' })
      if (fault === 'foreign-transaction' || fault === 'mixed-owner') {
        const txScope = fault === 'mixed-owner' ? { ...scope, characterId: 'char-a' } : { ...scope, groupId: 'group-b' }
        write(spatialPaths.transaction('foreign'), { schemaVersion: 1, id: 'foreign', scope: txScope, worldId: first.world.id,
          binding: { before: { worldId: first.world.id, runtimeId: first.runtime.runtimeId }, after: { worldId: first.world.id, runtimeId: first.runtime.runtimeId } }, files: [
            { kind: 'world', beforeHash: hashSpatialValue(first.world), afterHash: hashSpatialValue(first.world), after: first.world },
            { kind: 'runtime', beforeHash: null, afterHash: hashSpatialValue(first.runtime), after: first.runtime },
            { kind: 'state', beforeHash: null, afterHash: hashSpatialValue(storage.readJson(spatialPaths.state(scope))), after: storage.readJson(spatialPaths.state(scope)) },
          ] })
      }
      const zip = join(root, 'bad.zip'); createBackupV2(zip)
      const path = join(storage.DIRS.config(), 'settings.json'); write(path, { marker: '不应覆盖' })
      expect(() => restoreBackupV2(zip)).toThrow(/空间备份|空间会话|群聊范围/)
      expect(storage.readJson(path)).toEqual({ marker: '不应覆盖' })
    })
  }
})
