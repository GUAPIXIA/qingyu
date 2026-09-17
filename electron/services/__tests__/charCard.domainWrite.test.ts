/**
 * S2-04 写入口收口回归（character / usage 域）。
 *
 * 覆盖：
 * - flag 开启：角色 JSON 与头像/封面媒体在同一事务内提交，payload 仅含 schema 允许字段；
 * - 删除产生 tombstone，并删除聚合内的 JSON 与媒体文件；
 * - 角色卡前端扩展的跨域写入（regex_rule / quick_reply_set）各自记账；
 * - usage 记录单入口记账（不再由 IPC 二次记账），clear 产生 tombstone + usage_clear_marker；
 * - flag 关闭：保持旧直写语义且不写 journal。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// vi.hoisted 早于 import 求值，因此这里只用字符串拼接；目录在 beforeAll 中创建
const { ROOT, USER_DATA } = vi.hoisted(() => {
  const root = `${process.cwd()}/.tmp-s204-${process.pid}-${Date.now()}`
  return { ROOT: root, USER_DATA: `${root}/userdata` }
})

vi.mock('electron', () => ({ app: { getPath: () => USER_DATA } }))

import {
  deleteCharacterThroughDomain,
  importCardFrontendExtensions,
  saveCharacterThroughDomain,
} from '../charCard'
import { clearUsage, recordUsage } from '../usage'
import { getSyncDomain, resetSyncDomainForTest, setSyncDomainUserDataDirForTest } from '../../domain/syncDomainService'
import { SyncMetaDb } from '../../domain/syncMeta'
import type { Character } from '../../../shared/types'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-s204',
    name: '收口验证角色',
    avatar: `data:image/png;base64,${PNG_B64}`,
    cover: `data:image/png;base64,${PNG_B64}`,
    description: '描述',
    personality: '冷静',
    scenario: '雨夜',
    firstMessage: '你好',
    exampleDialog: '示例',
    tags: ['合成', 's204'],
    lorebookId: null,
    creator: 'qingyu',
    createdAt: 1,
    updatedAt: 2,
    alternateGreetings: ['嗨'],
    systemPrompt: '保持简洁',
    boundLorebookIds: [],
    boundPresetId: null,
    extensions: { k: 1 },
    ...overrides,
  }
}

const CHARACTER_ALLOWED_KEYS = new Set([
  'name', 'description', 'personality', 'scenario', 'firstMessage', 'exampleDialog',
  'tags', 'creator', 'boundLorebookIds', 'boundPresetId', 'alternateGreetings',
  'systemPrompt', 'avatarBlobId', 'extensions',
])

describe('S2-04 character 域收口（flag 开启）', () => {
  beforeAll(() => {
    mkdirSync(join(USER_DATA, 'data', 'config'), { recursive: true })
    mkdirSync(join(USER_DATA, 'data', 'characters'), { recursive: true })
    writeFileSync(
      join(USER_DATA, 'data', 'config', 'sync-repo-flags.json'),
      JSON.stringify({ character: true, usage_record: true, regex_rule: true, quick_reply_set: true }),
      'utf8',
    )
    setSyncDomainUserDataDirForTest(USER_DATA)
  })

  afterAll(() => {
    resetSyncDomainForTest()
    // Windows 上文件句柄/杀软可能短暂占用，清理失败不应让整组测试失败
    try {
      rmSync(ROOT, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 })
    } catch {
      /* 临时目录残留不影响结论 */
    }
  })

  it('角色 JSON 与头像/封面媒体同事务提交，payload 符合 character schema 字段集', () => {
    saveCharacterThroughDomain(makeCharacter())

    const dir = join(USER_DATA, 'data', 'characters')
    const jsonPath = join(dir, 'char-s204.json')
    const avatarPath = join(dir, 'char-s204.png')
    const coverPath = join(dir, 'char-s204_cover.png')

    const persisted = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>
    expect(persisted.avatar).toBe('')
    expect(persisted.cover).toBe('')
    expect(persisted.name).toBe('收口验证角色')
    expect(persisted.tags).toEqual(['合成', 's204'])
    expect(JSON.stringify(persisted)).not.toContain('base64')

    // 媒体逐字节一致
    expect(readFileSync(avatarPath).equals(PNG)).toBe(true)
    expect(readFileSync(coverPath).equals(PNG)).toBe(true)

    // journal：head 存在且非删除，payload 仅含 schema 允许字段
    const { meta } = getSyncDomain()
    const head = meta.getHead('character', 'char-s204')
    expect(head).toBeTruthy()
    expect(head?.deleted).toBe(0)
    const changes = meta.changesAfter(0, 20).rows
    const entry = changes.find((c) => c.entityType === 'character' && c.entityId === 'char-s204')
    expect(entry).toBeTruthy()
    const payload = JSON.parse(entry!.envelope).payload as Record<string, unknown>
    for (const key of Object.keys(payload)) {
      expect(CHARACTER_ALLOWED_KEYS.has(key)).toBe(true)
    }
    expect(payload.name).toBe('收口验证角色')
    expect(payload.alternateGreetings).toEqual(['嗨'])
    expect(payload.systemPrompt).toBe('保持简洁')
    expect(payload.extensions).toEqual({ k: 1 })
    // 未实现 blob 通道前不下发悬空引用
    expect(payload.avatarBlobId).toBeUndefined()

    // staging 已清理
    const stagingRoot = join(USER_DATA, 'data', 'config', '.sync-tx')
    expect(existsSync(stagingRoot) ? readdirSync(stagingRoot) : []).toEqual([])
  })

  it('删除产生 tombstone 并删除 JSON 与媒体文件', () => {
    deleteCharacterThroughDomain('char-s204')

    const dir = join(USER_DATA, 'data', 'characters')
    expect(existsSync(join(dir, 'char-s204.json'))).toBe(false)
    expect(existsSync(join(dir, 'char-s204.png'))).toBe(false)
    expect(existsSync(join(dir, 'char-s204_cover.png'))).toBe(false)

    const { meta } = getSyncDomain()
    const head = meta.getHead('character', 'char-s204')
    expect(head?.deleted).toBe(1)
  })

  it('角色卡前端扩展：regex_rule 与 quick_reply_set 各自记账', () => {
    const character = makeCharacter({
      id: 'char-ext',
      avatar: '',
      cover: '',
      extensions: {
        regex_scripts: [{ scriptName: '清理星号', findRegex: '\\*\\*', replaceString: '' }],
        quick_replies: [{ id: 'qr-s204', label: '摸头', message: '*摸摸你的头*' }],
      },
    })
    const result = importCardFrontendExtensions(character)
    expect(result.regexCount).toBe(1)
    expect(result.quickReplyCount).toBe(1)

    const rules = JSON.parse(
      readFileSync(join(USER_DATA, 'data', 'config', 'regex', 'rules.json'), 'utf8'),
    ) as Array<{ id: string }>
    expect(rules).toHaveLength(1)

    const { meta } = getSyncDomain()
    expect(meta.getHead('regex_rule', rules[0].id)?.deleted).toBe(0)
    expect(meta.getHead('quick_reply_set', 'quick-replies-root')?.deleted).toBe(0)
  })

  it('usage 记录单入口记账：文件与 journal 一致', async () => {
    const full = await recordUsage({
      timestamp: 1789562000000,
      characterId: 'char-s204',
      sessionId: 'session-1',
      model: 'model-1',
      inputChars: 10,
      outputChars: 20,
      totalChars: 30,
    })
    const usagePath = join(USER_DATA, 'data', 'config', 'usage.json')
    const records = JSON.parse(readFileSync(usagePath, 'utf8')) as Array<Record<string, unknown>>
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(full.id)
    expect(records[0].totalChars).toBe(30)

    const { meta } = getSyncDomain()
    expect(meta.getHead('usage_record', full.id)?.deleted).toBe(0)
    const changes = meta.changesAfter(0, 50).rows.filter((c) => c.entityType === 'usage_record')
    expect(changes).toHaveLength(1)
    const payload = JSON.parse(changes[0].envelope).payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual([
      'characterId', 'inputChars', 'model', 'outputChars', 'sessionId', 'timestamp', 'totalChars',
    ])
  })

  it('clear 产生 tombstone 且写入 usage_clear_marker（clearedThrough 语义保留）', async () => {
    const full = await recordUsage({
      timestamp: 1789562001000,
      characterId: 'char-s204',
      sessionId: 'session-1',
      model: 'model-1',
      inputChars: 1,
      outputChars: 2,
      totalChars: 3,
    })
    clearUsage()

    const usagePath = join(USER_DATA, 'data', 'config', 'usage.json')
    expect(readFileSync(usagePath, 'utf8')).toBe(JSON.stringify([], null, 2))

    const { meta, repo } = getSyncDomain()
    expect(meta.getHead('usage_record', full.id)?.deleted).toBe(1)
    const marker = meta.getHead('usage_clear_marker', 'usage-clear-marker')
    expect(marker).toBeTruthy()
    expect(marker?.deleted).toBe(0)
    const markerChange = meta
      .changesAfter(0, 200)
      .rows
      .find((c) => c.entityType === 'usage_clear_marker')
    const markerPayload = JSON.parse(markerChange!.envelope).payload as {
      clearedThrough: Record<string, string>
    }
    expect(Object.keys(markerPayload.clearedThrough)).toEqual([repo.deviceId()])
    expect(/^(0|[1-9][0-9]*)$/.test(markerPayload.clearedThrough[repo.deviceId()])).toBe(true)
  })
})

describe('S2-04 character 域 flag 关闭时保持旧直写语义', () => {
  it('直写文件、不写 journal', () => {
    resetSyncDomainForTest()
    saveCharacterThroughDomain(makeCharacter({ id: 'char-off' }))

    const dir = join(USER_DATA, 'data', 'characters')
    expect(readFileSync(join(dir, 'char-off.png')).equals(PNG)).toBe(true)
    const persisted = JSON.parse(readFileSync(join(dir, 'char-off.json'), 'utf8')) as Record<string, unknown>
    expect(persisted.name).toBe('收口验证角色')
    expect(persisted.avatar).toBe('')

    const meta = new SyncMetaDb(join(USER_DATA, 'data', 'config', 'sync-meta.db'))
    try {
      expect(meta.getHead('character', 'char-off')).toBeNull()
    } finally {
      meta.close()
    }
  })
})
