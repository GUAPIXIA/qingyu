/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testRoot = join(tmpdir(), 'qingyu-spatial-ipc-test')
vi.mock('electron', () => ({ app: { getPath: () => testRoot }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../features/chat/chatData', () => ({
  chatData: { listSessions: vi.fn(), updateSpatialBindingIfMatches: vi.fn() },
}))

import { chatData } from '../../features/chat/chatData'
import { registerSpatialIPC, spatialData } from '../spatial'
import * as storage from '../../services/storage'
import { spatialPaths, worldFingerprint } from '../../features/spatial/repository'
import type { SessionPreview } from '../../../shared/types'
import type { SpatialEditorCommit, SpatialSnapshot } from '../../../shared/spatial'
import type { SpatialCoreState, SpatialCommand } from '@qingyu/spatial-core'

type Snapshot = SpatialSnapshot & SpatialCoreState
const scope = { characterId: 'char-a', sessionId: 'session-a' }
const sessions: SessionPreview[] = []
const view = (value: SpatialSnapshot | null) => value as Snapshot
const load = async (sessionId = 'session-a') => view(await spatialData.loadBound('char-a', sessionId))
const create = async () => view(await spatialData.createAndBind('char-a', 'session-a', '青石城'))
function request(snapshot: Snapshot, commands: SpatialCommand[], commitId = randomUUID()): SpatialEditorCommit {
  const version = snapshot.version
  return { commitId, commands, worldId: version.worldId, runtimeId: version.runtimeId, bindingEpoch: version.bindingEpoch,
    expectedRuntimeRevision: version.runtimeRevision, expectedWorldFingerprint: version.worldFingerprint }
}
const commit = (input: SpatialEditorCommit, sessionId = 'session-a') => spatialData.applyEditorBatch('char-a', sessionId, input)

beforeEach(() => {
  sessions.length = 0
  sessions.push(
    { id: 'session-a', characterId: 'char-a', personaId: 'persona-a', messageCount: 0, lastMessage: '' } as SessionPreview,
    { id: 'session-b', characterId: 'char-a', messageCount: 0, lastMessage: '' } as SessionPreview,
  )
  mkdirSync(join(testRoot, 'data', 'characters'), { recursive: true })
  mkdirSync(join(testRoot, 'data', 'config'), { recursive: true })
  writeFileSync(join(testRoot, 'data', 'characters', 'char-a.json'), JSON.stringify({ id: 'char-a', name: '林雪', description: '旅者' }))
  writeFileSync(join(testRoot, 'data', 'config', 'personas.json'), JSON.stringify([{ id: 'persona-a', name: '我', description: '见证者' }]))
  vi.mocked(chatData.listSessions).mockImplementation(async () => sessions)
  vi.mocked(chatData.updateSpatialBindingIfMatches).mockImplementation(async (_characterId, sessionId, before, after) => {
    const session = sessions.find((item) => item.id === sessionId)!
    const current = { worldId: session.spatialWorldId ?? null, runtimeId: session.spatialRuntimeId ?? null }
    if (JSON.stringify(current) === JSON.stringify(after)) return
    if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error('绑定已改变')
    Object.assign(session, { spatialWorldId: after.worldId, spatialRuntimeId: after.runtimeId })
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testRoot, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('空间阶段 0：主进程命令、版本和恢复', () => {
  it('共享地图且运行状态按单聊隔离', async () => {
    const updated = vi.fn()
    const unsubscribe = spatialData.onUpdated(updated)
    const first = await create()
    expect(first.world.actors.map((actor) => actor.externalRef.type)).toEqual(['qingyu-character', 'qingyu-persona'])
    const second = view(await spatialData.bindWorld('char-a', 'session-b', first.world.id))
    expect(updated).toHaveBeenLastCalledWith(expect.objectContaining({ worldId: first.world.id, sessionId: 'session-b' }))
    unsubscribe()
    expect(second.runtime.runtimeId).toBe('single_session-b')
    expect(await commit(request(first, [{ type: 'update_world', patch: { name: '夜景' } }]))).toMatchObject({ ok: true })
    expect((await load()).runtime.revision).toBe(1)
    expect((await load('session-b')).runtime.revision).toBe(0)
    expect((await load('session-b')).world.name).toBe('夜景')
  })

  it('拒绝另一个会话的运行身份', async () => {
    const first = await create()
    const second = view(await spatialData.bindWorld('char-a', 'session-b', first.world.id))
    expect(await commit(request(second, [{ type: 'update_world', patch: { name: '不应保存' } }]))).toMatchObject({ ok: false, code: 'binding_conflict' })
    expect((await load()).world.name).toBe('青石城')
  })

  it('两个并发旧基线只允许一个提交，重试不能覆盖胜者', async () => {
    const first = await create()
    const left = request(first, [{ type: 'update_world', patch: { name: '左侧' } }])
    const right = request(first, [{ type: 'update_world', patch: { name: '右侧' } }])
    const results = await Promise.all([commit(left), commit(right)])
    expect(results.map((result) => result.ok)).toEqual([true, false])
    expect(await commit(right)).toMatchObject({ ok: false, code: 'version_conflict' })
    expect((await load()).world.name).toBe('左侧')
  })

  it('其他会话改变共享世界后，即使本会话 revision 不变也拒绝旧基线', async () => {
    const first = await create()
    const other = view(await spatialData.bindWorld('char-a', 'session-b', first.world.id))
    const node = other.world.nodes[0]!
    expect(await commit(request(other, [{ type: 'update_node', nodeId: node.id, patch: { geometry: { x: node.geometry.x + 10 } } }]), 'session-b')).toMatchObject({ ok: true })
    expect((await load()).runtime.revision).toBe(0)
    expect(await commit(request(first, [{ type: 'update_world', patch: { name: '过期' } }]))).toMatchObject({ ok: false, code: 'version_conflict' })
  })

  it('重复 commit 返回原收据及当前快照，事件裁剪不丢去重标记', async () => {
    const first = await create()
    const input = request(first, [{ type: 'update_world', patch: { name: '第一次' } }])
    const applied = await commit(input)
    expect(applied.ok).toBe(true)
    const next = await load()
    await commit(request(next, [{ type: 'update_world', patch: { name: '第二次' } }]))
    const path = spatialPaths.runtime(scope)
    const runtime = JSON.parse(readFileSync(path, 'utf8'))
    runtime.events = []
    storage.writeJson(path, runtime)
    const duplicate = await commit(input)
    expect(duplicate).toMatchObject({ ok: true, duplicate: true, receipt: { revisionAfter: 1 }, snapshot: { runtime: { revision: 2 }, world: { name: '第二次' } } })
    expect((await load()).runtime.events).toHaveLength(0)
    expect(await commit({ ...input, commands: [{ type: 'update_world', patch: { name: '伪造' } }] })).toMatchObject({ ok: false, code: 'commit_id_conflict' })
  })

  it('一条命令无效时整批不写入', async () => {
    const first = await create()
    const result = await commit(request(first, [
      { type: 'update_world', patch: { name: '不能部分保存' } },
      { type: 'remove_actor_from_board', actorId: 'missing-actor' },
    ]))
    expect(result.ok).toBe(false)
    expect((await load()).world.name).toBe('青石城')
    expect((await load()).runtime.revision).toBe(0)
    expect(readdirSync(join(testRoot, 'data', 'spatial', 'transactions'))).toEqual([])
  })

  it.each(['拖动地点', '修改上级'])('当前会话%s可同步更新位置，不误判为其他会话引用', async (action) => {
    const first = await create(), boardId = first.world.rootBoardId, actorId = first.world.actors[0]!.id
    const region = { ...first.world.nodes[0]!, id: 'target', name: '目标区域', tags: [] }
    const place = { ...region, id: 'occupied', kind: 'place' as const, name: '房间', geometry: { x: 500, y: 300 }, iconKey: 'pin' }
    expect(await commit(request(first, [
      { type: 'create_node', payload: region }, { type: 'create_node', payload: place },
      { type: 'place_actor', actorId, placement: { boardId, anchor: { kind: 'node', nodeId: place.id }, position: { x: 500, y: 300 }, semanticPosition: { precision: 'inside-only', note: '停留在房间' } } },
    ]))).toMatchObject({ ok: true })
    const before = await load(), commands: SpatialCommand[] = [{ type: 'update_node', nodeId: place.id, patch: { parentNodeId: region.id, geometry: { x: 100, y: 100 } } }]
    if (action === '拖动地点') commands.push({ type: 'move_actor', actorId, from: { revision: before.runtime.placements[0]!.revision }, to: {
      boardId, anchor: { kind: 'node', nodeId: place.id }, position: { x: 100, y: 100 }, semanticPosition: { precision: 'inside-only', note: '停留在房间' },
    } })
    expect(await commit(request(before, commands))).toMatchObject({ ok: true })
    const after = await load(), placement = after.runtime.placements[0]!
    expect(placement.anchor.nodeId).toBe(place.id)
    expect(placement.semanticPosition.containmentPath).toEqual([region.id,place.id])
    expect(placement.semanticPosition.note).toBe('停留在房间')
    expect(placement.position).toEqual(action === '拖动地点' ? { x: 100, y: 100 } : { x: 500, y: 300 })
    const undoCommands = storage.readJson<any>(spatialPaths.state(scope))!.commits
    const inverse = Object.values(undoCommands).at(-1) as { inverse: SpatialCommand[] }
    expect(await commit(request(after, [...inverse.inverse].reverse()))).toMatchObject({ ok: true })
    expect((await load()).runtime.placements[0]!.semanticPosition.containmentPath).toEqual([place.id])
  })

  it('其他会话占用地点时仍拒绝调整上级，不改变任一会话的位置', async () => {
    const first = await create(), region = { ...first.world.nodes[0]!, id: 'target', name: '目标区域', tags: [] }
    const place = { ...region, id: 'occupied', kind: 'place' as const, name: '房间', geometry: { x: 500, y: 300 }, iconKey: 'pin' }
    await commit(request(first, [{ type: 'create_node', payload: region }, { type: 'create_node', payload: place }]))
    const other = view(await spatialData.bindWorld('char-a','session-b',first.world.id))
    await commit(request(other,[{ type: 'place_actor', actorId: other.world.actors[0]!.id, placement: { boardId: place.boardId, anchor: { kind: 'node', nodeId: place.id } } }]),'session-b')
    const before = await load(), otherBefore = await load('session-b')
    const refused = await commit(request(before,[{ type: 'update_node', nodeId: place.id, patch: { parentNodeId: region.id } }]))
    expect(refused).toMatchObject({ ok: false })
    if (!refused.ok) expect(refused.message).toContain('session-b')
    expect((await load()).version).toEqual(before.version)
    expect((await load('session-b')).runtime).toEqual(otherBefore.runtime)
  })

  it('其他角色即使 runtimeId 相同也不能绕过共享结构保护', async () => {
    const first = await create(), region = { ...first.world.nodes[0]!, id: 'target', name: '目标区域', tags: [] }
    const place = { ...region, id: 'occupied', kind: 'place' as const, name: '房间', geometry: { x: 500, y: 300 }, iconKey: 'pin' }
    await commit(request(first,[{ type: 'create_node', payload: region }, { type: 'create_node', payload: place },
      { type: 'place_actor', actorId: first.world.actors[0]!.id, placement: { boardId: place.boardId, anchor: { kind: 'node', nodeId: place.id } } }]))
    const before = await load(), otherPath = spatialPaths.runtime({ characterId: 'char-b', sessionId: scope.sessionId })
    storage.writeJson(otherPath,before.runtime)
    const refused = await commit(request(before,[{ type: 'update_node', nodeId: place.id, patch: { parentNodeId: region.id } }]))
    expect(refused).toMatchObject({ ok: false })
    if (!refused.ok) expect(refused.message).toContain('char-b/session-a')
    expect((await load()).version).toEqual(before.version)
    expect(storage.readJson(otherPath)).toEqual(before.runtime)
  })

  it('拒绝删除仍被其他会话引用的区域，改名保留位置', async () => {
    const first = await create()
    const other = view(await spatialData.bindWorld('char-a', 'session-b', first.world.id))
    const node = other.world.nodes[0]!
    const actorId = other.world.actors[0]!.id
    expect(await commit(request(other, [{ type: 'place_actor', actorId, placement: { boardId: node.boardId, anchor: { kind: 'node', nodeId: node.id } } }]), 'session-b')).toMatchObject({ ok: true })
    const current = await load()
    const refused = await commit(request(current, [{ type: 'delete_node', nodeId: node.id, strategy: 'cascade' }]))
    expect(refused).toMatchObject({ ok: false })
    if (!refused.ok) expect(refused.message).toContain('session-b')
    expect((await load('session-b')).runtime.placements).toHaveLength(1)
    expect(await commit(request(current, [{ type: 'update_node', nodeId: node.id, patch: { name: '区域新名' } }]))).toMatchObject({ ok: true })
    expect((await load('session-b')).runtime.placements[0]?.anchor.nodeId).toBe(node.id)
  })

  it('主进程产生位置事件，逆命令作为新事务撤销', async () => {
    const first = await create()
    const actorId = first.world.actors[0]!.id
    const applied = await commit(request(first, [{ type: 'place_actor', actorId, placement: { boardId: first.world.rootBoardId, anchor: { kind: 'board' }, position: { x: 21, y: 34 } } }]))
    expect(applied.ok).toBe(true)
    const current = await load()
    expect(current.runtime.placements[0]?.updatedBy).toBe('user')
    const state = storage.readJson<any>(spatialPaths.state(scope))!
    const inverse = state.commits[(applied as any).receipt.commitId].inverse.reverse()
    expect(await commit(request(current, inverse))).toMatchObject({ ok: true })
    expect((await load()).runtime.placements).toEqual([])
    expect((await load()).runtime.revision).toBe(2)
  })

  it('只读加载不增加 actor、不创建缺失 runtime，也不覆盖损坏文件', async () => {
    const first = await create()
    const beforeWorld = readFileSync(spatialPaths.world(first.world.id), 'utf8')
    const beforeRuntime = readFileSync(spatialPaths.runtime(scope), 'utf8')
    sessions[0]!.personaId = null
    await load()
    expect(readFileSync(spatialPaths.world(first.world.id), 'utf8')).toBe(beforeWorld)
    expect(readFileSync(spatialPaths.runtime(scope), 'utf8')).toBe(beforeRuntime)
    unlinkSync(spatialPaths.runtime(scope))
    await expect(load()).rejects.toThrow('缺失')
    expect(existsSync(spatialPaths.runtime(scope))).toBe(false)
    writeFileSync(spatialPaths.runtime(scope), '{broken')
    await expect(load()).rejects.toThrow('损坏')
    expect(readFileSync(spatialPaths.runtime(scope), 'utf8')).toBe('{broken')
  })

  it('时间戳、头像和视口不改变语义指纹，几何会改变', async () => {
    const first = await create()
    const decorated = structuredClone(first.world)
    decorated.metadata.updatedAt += 100
    decorated.actors[0]!.avatarAssetRef = 'display-only'
    decorated.boards[0]!.viewportHint = { x: 40, y: 20, zoom: 2 }
    expect(worldFingerprint(decorated)).toBe(first.version.worldFingerprint)
    decorated.nodes[0]!.geometry.x += 1
    expect(worldFingerprint(decorated)).not.toBe(first.version.worldFingerprint)
  })

  it('runtime 已写而收据未写时恢复事务，只执行一次', async () => {
    const first = await create()
    const input = request(first, [{ type: 'update_world', patch: { name: '恢复后的世界' } }])
    const original = storage.writeJson
    let interrupted = false
    vi.spyOn(storage, 'writeJson').mockImplementation((path, value, domain) => {
      if (path === spatialPaths.state(scope) && !interrupted) { interrupted = true; throw new Error('模拟提交中断') }
      original(path, value, domain)
    })
    await expect(commit(input)).rejects.toThrow('模拟提交中断')
    expect(existsSync(spatialPaths.transaction(input.commitId))).toBe(true)
    await spatialData.recoverTransactions()
    expect(await commit(input)).toMatchObject({ ok: true, duplicate: true, receipt: { revisionAfter: 1 } })
    expect((await load()).world.name).toBe('恢复后的世界')
    expect((await load()).runtime.events).toHaveLength(1)
    expect(existsSync(spatialPaths.transaction(input.commitId))).toBe(false)
  })

  it('恢复记录与后来改动不匹配时停止，不盲目重放', async () => {
    const first = await create()
    const input = request(first, [{ type: 'update_world', patch: { name: '中断' } }])
    const original = storage.writeJson
    let interrupted = false
    vi.spyOn(storage, 'writeJson').mockImplementation((path, value, domain) => {
      if (path === spatialPaths.runtime(scope) && !interrupted) { interrupted = true; throw new Error('中断') }
      original(path, value, domain)
    })
    await expect(commit(input)).rejects.toThrow('中断')
    original(spatialPaths.world(first.world.id), { ...first.world, name: '需要保留的后来改动' })
    await expect(spatialData.recoverTransactions()).rejects.toThrow('不匹配')
    expect(storage.readJson<any>(spatialPaths.world(first.world.id)).name).toBe('需要保留的后来改动')
    expect(storage.readJson<any>(spatialPaths.runtime(scope)).revision).toBe(0)
    expect(existsSync(spatialPaths.transaction(input.commitId))).toBe(true)
  })

  it('普通编辑恢复前核对会话绑定，解绑后不继续写入旧 runtime', async () => {
    const first = await create()
    const input = request(first, [{ type: 'update_world', patch: { name: '中断' } }])
    const original = storage.writeJson
    const write = vi.spyOn(storage, 'writeJson').mockImplementation((path, value, domain) => {
      if (path === spatialPaths.runtime(scope)) throw new Error('中断')
      original(path, value, domain)
    })
    await expect(commit(input)).rejects.toThrow('中断')
    write.mockRestore()
    Object.assign(sessions[0]!, { spatialWorldId: null, spatialRuntimeId: null })
    await expect(spatialData.recoverTransactions()).rejects.toThrow('绑定已改变')
    expect(storage.readJson<any>(spatialPaths.runtime(scope)).revision).toBe(0)
    expect(existsSync(spatialPaths.transaction(input.commitId))).toBe(true)
  })

  it('创建途中绑定写入失败后恢复同一世界和位置，不重复初始化', async () => {
    vi.mocked(chatData.updateSpatialBindingIfMatches).mockRejectedValueOnce(new Error('绑定中断'))
    await expect(create()).rejects.toThrow('绑定中断')
    expect(sessions[0]!.spatialWorldId).toBeUndefined()
    await spatialData.recoverTransactions()
    const restored = await load()
    expect(restored.world.name).toBe('青石城')
    expect(restored.runtime.revision).toBe(0)
    expect(readdirSync(join(testRoot, 'data', 'spatial', 'worlds'))).toHaveLength(1)
    expect(readdirSync(join(testRoot, 'data', 'spatial', 'transactions'))).toEqual([])
  })

  it('旧全量保存 IPC 始终被拒绝', () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    registerSpatialIPC({ handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as any)
    expect(() => handlers.get('spatial:saveBound')!()).toThrow('整份快照保存已停用')
  })
})
