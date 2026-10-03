/** @vitest-environment node */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
const { root } = vi.hoisted(() => ({ root: `${process.env.TEMP}/qingyu-spatial-session-feature-${process.pid}` }))
vi.mock('electron', () => ({ app: { getPath: () => root, getVersion: () => 'test' }, BrowserWindow: { getAllWindows: () => [] } }))
import { registerSpatialIPC } from '../spatial'
import { chatData } from '../../features/chat/chatData'
import { groupData } from '../group'
import { spatialAiService } from '../../services/spatialAiService'
import { spatialService } from '../../features/spatial/commitService'
import { spatialContextService } from '../../features/spatial/contextService'
import { DIRS, writeJson } from '../../services/storage'
import { getDefaultSettings } from '../../../shared/defaults'
import type { ChatSession, GroupChat, GroupSession } from '../../../shared/types'

const handlers = new Map<string, (...args: any[]) => Promise<any>>()
beforeAll(() => registerSpatialIPC({ handle: (channel: string, handler: (...args: any[]) => Promise<any>) => handlers.set(channel, handler) } as never))
beforeEach(() => {
  writeJson(join(DIRS.config(), 'settings.json'), { ...getDefaultSettings(), spatialBoardEnabled: true })
  writeJson(join(DIRS.characters(), 'char.json'), { id: 'char', name: '林雪' })
  writeJson(join(DIRS.chats(), 'char', 'sessions.json'), ['s1', 's2'].map(id => ({ id, characterId: 'char', title: '单聊', createdAt: 1, updatedAt: 1 } as ChatSession)))
  writeJson(join(DIRS.groups(), 'index.json'), [{ id: 'group', name: '群聊', memberIds: ['char'] } as GroupChat])
  writeJson(join(DIRS.groups(), 'group', 'sessions.json'), ['s1', 's2'].map(id => ({ id, groupId: 'group', title: '群聊', messageCount: 0, createdAt: 1, updatedAt: 1 } as GroupSession)))
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

describe('会话画板开关 IPC', () => {
  it.each(['single', 'group'])('%s 默认关闭，一次启用完成建图和助手关联，不影响另一会话', async kind => {
    const group = kind === 'group', owner = group ? 'group' : 'char'
    const toggle = handlers.get(group ? 'spatial:setGroupEnabled' : 'spatial:setEnabled')!
    const snapshot = await toggle({}, owner, 's1', true)
    const sessions = group ? groupData.readSessions(owner) : await chatData.listSessions(owner)
    expect(snapshot.world.name).toBe('会话画板')
    expect(sessions.find(session => session.id === 's1')).toMatchObject({ spatialBoardEnabled: true, spatialNarrativeSyncPolicy: 'suggest' })
    expect(sessions.find(session => session.id === 's1')?.spatialAiSessionId).toBeTruthy()
    expect(sessions.find(session => session.id === 's2')?.spatialBoardEnabled).toBeUndefined()
    await toggle({}, owner, 's1', false)
    expect(group ? await spatialContextService.readGroup({ kind: 'group', groupId: owner, sessionId: 's1' })
      : await spatialContextService.read({ characterId: owner, sessionId: 's1' })).toBeNull()
    expect((await toggle({}, owner, 's1', true)).version).toEqual(snapshot.version)
  })

  it('首次启用助手失败保持关闭，重试复用已创建画板', async () => {
    const toggle = handlers.get('spatial:setEnabled')!
    vi.spyOn(spatialAiService, 'get').mockRejectedValueOnce(new Error('助手初始化失败'))
    await expect(toggle({}, 'char', 's1', true)).rejects.toThrow('助手初始化失败')
    expect((await chatData.listSessions('char')).find(session => session.id === 's1')?.spatialBoardEnabled).toBe(false)
    const created = await spatialService.loadBound('char', 's1')
    expect((await toggle({}, 'char', 's1', true)).version).toEqual(created!.version)
  })
})
