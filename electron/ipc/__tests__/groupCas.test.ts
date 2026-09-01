import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { getDefaultSettings } from '../../../shared/defaults'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-group-cas-test' },
}))

import { groupData } from '../group'

afterEach(() => {
  rmSync('/tmp/qingyu-group-cas-test', { recursive: true, force: true })
})

describe('groupData memory version CAS', () => {
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
})
