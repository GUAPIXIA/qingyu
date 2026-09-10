import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { getDefaultSettings } from '../../../shared/defaults'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-group-cas-test' },
}))

import { groupData } from '../group'
import type { GroupChat } from '../../../shared/types'

afterEach(() => {
  rmSync('/tmp/qingyu-group-cas-test', { recursive: true, force: true })
})

describe('groupData memory version CAS', () => {
  it('群聊写入边界补齐身份字段并对非法值安全回退', () => {
    groupData.appendMessage('group-identity', 'session-identity', {
      id: 'identity-1', groupId: 'group-identity', characterId: '__user__',
      content: '推动剧情', images: [], timestamp: 1, round: 1,
      narrativeMode: 'omniscient', speakerKind: 'invalid', generationKind: 'invalid',
    } as never)
    expect(groupData.readMessages('group-identity', 'session-identity')[0]).toMatchObject({
      speakerKind: 'narrator', generationKind: 'manual',
    })
  })

  it('新建群聊会话继承默认用户身份', async () => {
    const configDir = '/tmp/qingyu-group-cas-test/data/config'
    mkdirSync(configDir, { recursive: true })
    writeFileSync(`${configDir}/settings.json`, JSON.stringify({
      ...getDefaultSettings(),
      defaultPersonaId: 'persona-default',
    }))

    const session = await groupData.createSession('group-persona')

    expect(session.personaId).toBe('persona-default')
  })

  it('拒绝用旧版本覆盖已经提交的群聊记忆', async () => {
    const session = await groupData.createSession('group-cas')
    const first = await groupData.updateSessionIfMemoryVersion('group-cas', session.id, 0, {
      memory: '版本 1', memoryVersion: 1,
    })
    const stale = await groupData.updateSessionIfMemoryVersion('group-cas', session.id, 0, {
      memory: '过期版本', memoryVersion: 1,
    })

    expect(first).toEqual({ applied: true, currentVersion: 1 })
    expect(stale).toEqual({ applied: false, currentVersion: 1 })
    const persisted = (await groupData.listSessions('group-cas')).find((item) => item.id === session.id)!
    expect(persisted.memory).toBe('版本 1')
  })

  it('新群聊会话固化群聊默认叙事模式且不改写旧会话', async () => {
    const configDir = '/tmp/qingyu-group-cas-test/data/config'
    mkdirSync(configDir, { recursive: true })
    writeFileSync(`${configDir}/settings.json`, JSON.stringify({
      ...getDefaultSettings(),
      defaultNarrativeMode: 'omniscient',
    }))
    const now = Date.now()
    const group: GroupChat = {
      id: 'group-narrative', name: '群像', memberIds: [], currentSpeakerIndex: 0,
      autoMode: false, chatMode: 'polling', defaultNarrativeMode: 'immersive',
      maxRounds: 1, speakerInterval: 1000, lorebookIds: [], presetId: null,
      systemPrompt: '', createdAt: now, updatedAt: now,
    }
    await groupData.saveGroup(group)

    const first = await groupData.createSession(group.id)
    await groupData.saveGroup({ ...group, defaultNarrativeMode: 'omniscient' })
    const second = await groupData.createSession(group.id)

    expect(first.narrativeMode).toBe('immersive')
    expect(second.narrativeMode).toBe('omniscient')
    const persisted = await groupData.listSessions(group.id)
    expect(persisted.find((session) => session.id === first.id)?.narrativeMode).toBe('immersive')
  })

  it('拒绝非法群聊叙事模式写入会话或群聊默认值', async () => {
    const session = await groupData.createSession('group-invalid-mode')
    await expect(groupData.updateSession('group-invalid-mode', session.id, {
      narrativeMode: 'invalid',
    })).rejects.toThrow('narrativeMode')
    await expect(groupData.updateSession('group-invalid-mode', session.id, {
      gameMasterMode: 'yes',
    })).rejects.toThrow('gameMasterMode')
    await expect(groupData.saveGroup({
      id: 'group-invalid-mode', name: '非法', memberIds: [], currentSpeakerIndex: 0,
      autoMode: false, chatMode: 'polling', defaultNarrativeMode: 'invalid',
      maxRounds: 1, speakerInterval: 1000, lorebookIds: [], presetId: null,
      systemPrompt: '', createdAt: 0, updatedAt: 0,
    } as never)).rejects.toThrow('defaultNarrativeMode')
  })
})
