/**
 * 阶段 C：设置同步 v2 快照端点集成测试。
 * - GET/PATCH /api/v1/settings/snapshot（新端点）；
 * - 旧 /settings GET/PATCH 行为不变（回归）；
 * - 陈旧 baseRevision -> 409 settings_conflict 且文件未写入；
 * - 非法字段进 rejectedFields，合法字段照常应用；
 * - snapshot 不含敏感字段；
 * - WS settings:updated 广播（revision/changedFields/sourceDeviceId）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-settings-snapshot-test', getVersion: () => '0.16.6' },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { DIRS } from '../../services/storage'
import { buildBridgeRouter } from '../routes'
import { WsHub } from '../ws'
import { BridgeChatService } from '../chatService'
import { signToken, registerDevice } from '../auth'
import { buildSettingsSnapshot, toMobileSafeSettings } from '../settingsSync'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Settings } from '../../../shared/types'

const TEST_ROOT = '/tmp/qingyu-settings-snapshot-test'

function listen(app: express.Express): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port })
      else reject(new Error('无地址'))
    })
    server.on('error', reject)
  })
}

function settingsFile(): string {
  return join(DIRS.config(), 'settings.json')
}

function writeSettings(s: Settings): void {
  mkdirSync(DIRS.config(), { recursive: true })
  // 带当前 schemaVersion：避免 readJson('settings') 触发迁移回写导致文件字节漂移
  // （settings 最新版本见 electron/services/migration.ts 的 LATEST_VERSION）
  writeFileSync(settingsFile(), JSON.stringify({ ...s, schemaVersion: 3 }))
}

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsFile(), 'utf-8')) as Settings
}

interface TestContext {
  hub: WsHub
  broadcasts: Array<{ event: string; payload: unknown }>
  base: string
  server: ReturnType<typeof createServer>
  headers: Record<string, string>
}

async function startServer(): Promise<TestContext> {
  const hub = new WsHub()
  const broadcasts: Array<{ event: string; payload: unknown }> = []
  const hubProxy = new Proxy(hub, {
    get(target, prop) {
      if (prop === 'broadcast') {
        return (event: string, payload?: unknown) => {
          broadcasts.push({ event, payload })
        }
      }
      return Reflect.get(target, prop)
    },
  })
  const device = registerDevice('快照测试设备', 'fp-snapshot')
  const token = signToken(device.deviceId)
  const app = express()
  app.use(express.json())
  app.use('/api/v1', buildBridgeRouter(
    hubProxy,
    new BridgeChatService(hub, () => {}),
    () => {},
  ))
  const { server, port } = await listen(app)
  return {
    hub,
    broadcasts,
    base: `http://127.0.0.1:${port}/api/v1`,
    server,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  const s = getDefaultSettings()
  writeSettings({
    ...s,
    connectionProfiles: [
      { id: 'p1', name: 'A', provider: 'openai', apiKey: 'sk-top-secret', baseUrl: 'https://api.example.com', model: 'gpt-4o', maxContext: 8000 },
    ],
    activeProfileId: 'p1',
    activeModel: 'gpt-4o',
  })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('GET /settings/snapshot', () => {
  it('返回 schemaVersion=4 快照：revision/updatedAt/values/capabilities，且无敏感字段', async () => {
    const ctx = await startServer()
    try {
      const res = await fetch(`${ctx.base}/settings/snapshot`, { headers: ctx.headers })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.schemaVersion).toBe(4)
      expect(body.revision).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof body.updatedAt).toBe('number')
      expect(body.capabilities).toContain('settings_snapshot_v2')
      expect(body.values.activeModel).toBe('gpt-4o')
      const json = JSON.stringify(body)
      expect(json).not.toContain('apiKey')
      expect(json).not.toContain('sk-top-secret')
      expect(json).not.toContain('connectionProfiles')
      expect(json).not.toContain('messageWidth')
      // revision 与磁盘安全子集内容寻址一致
      expect(body.revision).toBe(buildSettingsSnapshot(readSettings()).revision)
    } finally {
      ctx.server.close()
    }
  })

  it('未认证访问返回 401', async () => {
    const ctx = await startServer()
    try {
      const res = await fetch(`${ctx.base}/settings/snapshot`)
      expect(res.status).toBe(401)
    } finally {
      ctx.server.close()
    }
  })
})

describe('PATCH /settings/snapshot', () => {
  it('合法字段应用：返回新快照 + appliedFields + WS 广播 settings:updated', async () => {
    const ctx = await startServer()
    try {
      const current = buildSettingsSnapshot(readSettings())
      const res = await fetch(`${ctx.base}/settings/snapshot`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({
          baseRevision: current.revision,
          patch: { translationTargetLang: '  日语  ', streamOutput: false, lorebookRatio: 0.8 },
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.appliedFields).toEqual(expect.arrayContaining(['translationTargetLang', 'streamOutput', 'lorebookRatio']))
      expect(body.rejectedFields).toEqual([])
      expect(body.values.translationTargetLang).toBe('日语')
      expect(body.revision).not.toBe(current.revision)
      // 落盘验证
      const saved = readSettings()
      expect(saved.translationTargetLang).toBe('日语')
      expect(saved.streamOutput).toBe(false)
      expect(saved.lorebookRatio).toBe(0.8)
      // 广播验证（sourceDeviceId = 配对设备）
      const settingsEvents = ctx.broadcasts.filter((b) => b.event === 'settings:updated')
      expect(settingsEvents).toHaveLength(1)
      expect(settingsEvents[0].payload).toMatchObject({
        revision: body.revision,
        changedFields: expect.arrayContaining(['translationTargetLang', 'streamOutput', 'lorebookRatio']),
      })
      expect((settingsEvents[0].payload as { sourceDeviceId: string }).sourceDeviceId).toBeTruthy()
    } finally {
      ctx.server.close()
    }
  })

  it('陈旧 baseRevision -> 409 settings_conflict（携带 current），文件未被写入', async () => {
    const ctx = await startServer()
    try {
      const before = readFileSync(settingsFile(), 'utf-8')
      const res = await fetch(`${ctx.base}/settings/snapshot`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({
          baseRevision: 'stale-revision-not-current',
          patch: { userName: '不应写入' },
        }),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toBe('settings_conflict')
      expect(body.current.revision).toBe(buildSettingsSnapshot(readSettings()).revision)
      expect(body.current.values.userName).not.toBe('不应写入')
      // 文件逐字节未变
      expect(readFileSync(settingsFile(), 'utf-8')).toBe(before)
      expect(ctx.broadcasts.filter((b) => b.event === 'settings:updated')).toHaveLength(0)
    } finally {
      ctx.server.close()
    }
  })

  it('非法字段进 rejectedFields，合法字段照常应用', async () => {
    const ctx = await startServer()
    try {
      const current = buildSettingsSnapshot(readSettings())
      const res = await fetch(`${ctx.base}/settings/snapshot`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({
          baseRevision: current.revision,
          patch: {
            apiKey: 'sk-hacked',                 // 非白名单
            fontSize: 12,                        // PC-only 显示偏好
            lorebookRatio: 42,                   // 超范围
            translationTargetLang: '',           // 太短
            userName: '合法用户',                 // 合法
            activePresetId: 'ghost-preset',      // 不存在的预设
          },
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.appliedFields).toEqual(['userName'])
      const rejected = new Map<string, string>(
        (body.rejectedFields as Array<{ field: string; reason: string }>).map((r) => [r.field, r.reason]),
      )
      expect(rejected.get('apiKey')).toBe('field_not_allowed')
      expect(rejected.get('fontSize')).toBe('field_not_allowed')
      expect(rejected.get('lorebookRatio')).toBe('out_of_range')
      expect(rejected.get('translationTargetLang')).toBe('invalid_length')
      expect(rejected.get('activePresetId')).toBe('unknown_preset')
      const saved = readSettings()
      expect(saved.userName).toBe('合法用户')
      expect((saved as unknown as Record<string, unknown>).apiKey).toBeUndefined()
      expect(saved.fontSize).toBe(getDefaultSettings().fontSize)
    } finally {
      ctx.server.close()
    }
  })

  it('无变更字段时不广播（appliedFields 空）', async () => {
    const ctx = await startServer()
    try {
      const current = buildSettingsSnapshot(readSettings())
      const res = await fetch(`${ctx.base}/settings/snapshot`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({
          baseRevision: current.revision,
          patch: { badFieldOnly: true },
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.appliedFields).toEqual([])
      expect(body.revision).toBe(current.revision)
      expect(ctx.broadcasts.filter((b) => b.event === 'settings:updated')).toHaveLength(0)
    } finally {
      ctx.server.close()
    }
  })
})

describe('旧 /settings 端点回归（行为逐字节不变）', () => {
  it('GET /settings 仍返回旧 toApiSettings 形状（含 PC 显示偏好、无 revision 包装）', async () => {
    const ctx = await startServer()
    try {
      const res = await fetch(`${ctx.base}/settings`, { headers: ctx.headers })
      expect(res.status).toBe(200)
      const body = await res.json()
      // 旧形状：顶层即设置子集，无 schemaVersion/revision/values 包装
      expect(body.schemaVersion).toBeUndefined()
      expect(body.revision).toBeUndefined()
      expect(body.values).toBeUndefined()
      // 旧清单含 PC 显示偏好（新快照不含）
      expect(body).toHaveProperty('fontSize')
      expect(body).toHaveProperty('themeColor')
      expect(body).toHaveProperty('messageWidth')
      expect(body).toHaveProperty('translationTargetLang')
      expect(JSON.stringify(body)).not.toContain('apiKey')
    } finally {
      ctx.server.close()
    }
  })

  it('PATCH /settings 仍按旧白名单直写、返回 {ok:true}', async () => {
    const ctx = await startServer()
    try {
      const res = await fetch(`${ctx.base}/settings`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ userName: '旧路径用户', fontSize: 'compact' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      const saved = readSettings()
      expect(saved.userName).toBe('旧路径用户')
      expect(saved.fontSize).toBe('compact')
    } finally {
      ctx.server.close()
    }
  })
})

describe('server/info capabilities（C-05）', () => {
  it('增量返回 serverId + capabilities（旧字段不动）', async () => {
    const ctx = await startServer()
    try {
      const res = await fetch(`${ctx.base}/server/info`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiVersion).toBe(1)
      expect(body.appVersion).toBe('0.16.6')
      expect(typeof body.serverId).toBe('string')
      expect(body.serverId.length).toBeGreaterThanOrEqual(8)
      expect(body.capabilities).toEqual(expect.arrayContaining([
        'settings_snapshot_v2',
        'settings_events_v1',
        'pairing_qr_v2',
        'task_events_v2',
      ]))
    } finally {
      ctx.server.close()
    }
  })
})

describe('移动安全子集与快照一致性', () => {
  it('toMobileSafeSettings 字段集与快照 values 键完全一致（白名单防漂移）', async () => {
    const snapshot = buildSettingsSnapshot(readSettings())
    const expectedKeys = Object.keys(toMobileSafeSettings(readSettings())).sort()
    expect(Object.keys(snapshot.values).sort()).toEqual(expectedKeys)
    // 显式钉死白名单，防止无意加入敏感字段
    expect(expectedKeys).toEqual([
      'activeModel', 'activePresetId', 'autoScroll', 'autoTitle', 'defaultNarrativeMode', 'exampleDialogMode',
      'htmlRendering', 'lorebookRatio',
      'omniscientNarrativeRules', 'showTokenCount', 'streamOutput', 'translationTargetLang', 'userDescription',
      'userName', 'userPersona',
    ])
  })
})
