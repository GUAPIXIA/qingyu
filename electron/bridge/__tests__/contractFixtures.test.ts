/**
 * G-05 契约测试：双向共享 fixture（单处权威 = repo 根 shared/fixtures/）。
 *
 * 职责（PC 侧半边）：
 * - settings_snapshot.json 必须是合法 Snapshot（可用 buildSettingsSnapshot 的产物结构
 *   解析/比对），values 键集与 MobileSafeSettings 白名单完全一致，且绝不含敏感字段
 *   （apiKey/connectionProfiles/provider 凭据/PC 显示偏好）——白名单钉死即防漂移断言；
 * - settings_patch_request.json 交给 validateSettingsPatch 校验：合法字段 accepted、
 *   非法/敏感字段进 rejectedFields（field_not_allowed）且不影响合法字段；
 * - pairing_qr_v2.json 能被共享 parsePairingQr 解析为 v2 且字段齐全；
 * - task_event_envelope.json 形状对齐 shared/chat-core/events.ts TaskEventEnvelope。
 *
 * 对应的 Android 半边：android/app/src/test/java/com/qingyu/companion/model/ProtocolContractTest.kt
 * 读取 android/app/src/test/resources/fixtures/ 下的**同一份**副本（复制自 shared/fixtures/，
 * 漂移时以 shared/fixtures/ 为权威）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSettingsSnapshot,
  computeRevision,
  SETTINGS_SNAPSHOT_CAPABILITIES,
  toMobileSafeSettings,
  validateSettingsPatch,
  type SettingsSnapshot,
  type SettingsPatchRequest,
} from '../settingsSync'
import { parsePairingQr, type PairingQrPayloadV2 } from '../../../shared/pairingQr'
import type { TaskEventEnvelope } from '../../../shared/chat-core/events'
import type { GroupMessage, Message } from '../../../shared/types'
import { resolveMessageSpeakerKind } from '../../../shared/messageIdentity'

// vitest 以 repo 根为 cwd；fixture 单处权威 = repo 根 shared/fixtures/
const FIXTURE_DIR = join(process.cwd(), 'shared/fixtures')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8')
}

/** 白名单钉死：出现新字段必须显式评审，防止无意引入敏感/PC-only 字段 */
const EXPECTED_WHITELIST = [
  'activeModel', 'activePresetId', 'autoScroll', 'autoTitle', 'exampleDialogMode',
  'htmlRendering', 'imageGenAutoEnabled', 'lorebookRatio',
  'showTokenCount', 'streamOutput', 'translationTargetLang', 'userDescription',
  'userName', 'userPersona', 'defaultNarrativeMode', 'omniscientNarrativeRules',
]

// 注意：'token' 不能作为整串子串断言——白名单合法字段 showTokenCount 含该子串；
// 敏感检查改为逐 key 白名单 + 下方显式子串（凭据/连接配置/PC 显示偏好）。
const SENSITIVE_SUBSTRINGS = [
  'apiKey', 'sk-', 'connectionProfiles', 'providers', 'ttsModels', 'imageGenModels',
  'visionModels', 'secret', 'password', 'fontSize', 'themeColor', 'bubbleStyle',
  'messageWidth', 'messageSpacing',
]

describe('契约 fixture：settings_snapshot.json（PC 半边）', () => {
  const snapshot = JSON.parse(readFixture('settings_snapshot.json')) as SettingsSnapshot

  it('结构：schemaVersion/revision/updatedAt/values/capabilities 齐全且 revision 内容寻址', () => {
    expect(snapshot.schemaVersion).toBe(3)
    expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof snapshot.updatedAt).toBe('number')
    expect(snapshot.values).toBeTruthy()
    expect(snapshot.capabilities).toBeTruthy()
    // revision 必须等于稳定序列化安全子集的 sha256（与 PC 实现一致）
    expect(snapshot.revision).toBe(computeRevision(snapshot.values))
  })

  it('values 键集 === MobileSafeSettings 白名单（防漂移，允许顺序不同）', () => {
    expect(Object.keys(snapshot.values).sort()).toEqual([...EXPECTED_WHITELIST].sort())
    expect(Object.keys(toMobileSafeSettings(snapshot.values as unknown as Parameters<typeof toMobileSafeSettings>[0])).sort())
      .toEqual(Object.keys(snapshot.values).sort())
  })

  it('绝不含敏感字段/PC 显示偏好/凭据（断言点）', () => {
    const json = JSON.stringify(snapshot)
    for (const s of SENSITIVE_SUBSTRINGS) {
      expect(json.toLowerCase()).not.toContain(s.toLowerCase())
    }
    // values 内逐字段断言（防大小写/嵌套绕过）
    for (const key of Object.keys(snapshot.values)) {
      expect(EXPECTED_WHITELIST).toContain(key)
    }
    // showTokenCount 是合法白名单字段，仅证明其存在且为 boolean
    expect(typeof snapshot.values.showTokenCount).toBe('boolean')
  })

  it('fixture 可被 PC 快照构造函数的输出形状兼容（buildSettingsSnapshot 结构一致）', () => {
    const built = buildSettingsSnapshot(snapshot.values as unknown as Parameters<typeof buildSettingsSnapshot>[0], snapshot.updatedAt)
    expect(built.schemaVersion).toBe(snapshot.schemaVersion)
    expect(built.revision).toBe(snapshot.revision)
    expect(built.capabilities).toEqual(SETTINGS_SNAPSHOT_CAPABILITIES)
    expect(built.updatedAt).toBe(snapshot.updatedAt)
  })

  it('Android fixture 副本与共享权威文件完全一致', () => {
    const androidCopy = readFileSync(
      join(process.cwd(), 'android/app/src/test/resources/fixtures/settings_snapshot.json'),
      'utf-8',
    )
    expect(androidCopy).toBe(readFixture('settings_snapshot.json'))
  })
})

describe('契约 fixture：settings_patch_request.json（PC 半边）', () => {
  const request = JSON.parse(readFixture('settings_patch_request.json')) as SettingsPatchRequest

  it('结构：baseRevision + patch + sourceDeviceId', () => {
    expect(typeof request.baseRevision).toBe('string')
    expect(request.baseRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof request.sourceDeviceId).toBe('string')
    expect(request.patch).toBeTruthy()
  })

  it('合法字段全部 accepted（translationTargetLang/streamOutput/lorebookRatio/userName/activePresetId）', () => {
    const ctx = { knownModelIds: ['gpt-4o'], knownPresetIds: ['builtin-default'] }
    const result = validateSettingsPatch(request.patch as Record<string, unknown>, ctx)
    expect(result.accepted).toEqual({
      translationTargetLang: '英语',
      streamOutput: false,
      lorebookRatio: 0.6,
      userName: '轻语用户',
      activePresetId: 'builtin-default',
    })
  })

  it('非法/敏感字段进入 rejectedFields 且全部 field_not_allowed（断言点）', () => {
    const ctx = { knownModelIds: ['gpt-4o'], knownPresetIds: ['builtin-default'] }
    const result = validateSettingsPatch(request.patch as Record<string, unknown>, ctx)
    const rejectedMap = new Map(result.rejected.map((r) => [r.field, r.reason]))
    expect(rejectedMap.get('apiKey')).toBe('field_not_allowed')
    expect(rejectedMap.get('connectionProfiles')).toBe('field_not_allowed')
    expect(rejectedMap.get('fontSize')).toBe('field_not_allowed')
    expect(rejectedMap.get('themeColor')).toBe('field_not_allowed')
    expect(rejectedMap.get('messageWidth')).toBe('field_not_allowed')
    expect(rejectedMap.get('bubbleStyle')).toBe('field_not_allowed')
    expect(rejectedMap.get('messageSpacing')).toBe('field_not_allowed')
    // 非白名单字段不会混入 accepted
    expect(Object.keys(result.accepted)).not.toContain('apiKey')
  })

  it('patch 载荷本身不含任何真实凭据（禁止把敏感样本写入契约 fixture）', () => {
    const json = JSON.stringify(request)
    for (const s of ['sk-top-secret', 'sk-hacked', 'sk-x', 'password', 'Bearer ']) {
      expect(json).not.toContain(s)
    }
  })
})

describe('契约 fixture：pairing_qr_v2.json（PC 半边）', () => {
  const raw = readFixture('pairing_qr_v2.json')

  it('可被共享 parsePairingQr 解析为 v2 且字段齐全', () => {
    const fixture = JSON.parse(raw) as PairingQrPayloadV2
    const fixtureNow = fixture.expiresAt - 1
    const parsed = parsePairingQr(raw, fixtureNow)
    expect(parsed.kind).toBe('v2')
    if (parsed.kind !== 'v2') return
    const p = parsed.payload
    expect(p.version).toBe(2)
    expect(p.scheme).toBe('qingyu-pair')
    expect(p.serverId).toBe('contract-server-uuid-0001')
    expect(p.displayName).toBe('轻语-契约测试机')
    expect(p.apiVersion).toBe(1)
    expect(p.capabilities).toEqual(expect.arrayContaining(['settings_snapshot_v2', 'task_events_v2']))
    expect(p.pairingCode).toBe('contract-pairing-code-001')
    expect(p.expiresAt).toBeGreaterThan(fixtureNow)
    expect(p.endpoints.length).toBeGreaterThanOrEqual(1)
    expect(p.endpoints[0]).toMatchObject({ host: '192.168.1.8', port: 8321, security: 'LOCAL_CLEARTEXT' })
    expect(p.certificatePin).toBeNull()
  })

  it('结构类型与 shared/pairingQr.ts PairingQrPayloadV2 形状完全一致', () => {
    const obj = JSON.parse(raw) as PairingQrPayloadV2
    expect(typeof obj.serverId).toBe('string')
    expect(typeof obj.displayName).toBe('string')
    expect(typeof obj.apiVersion).toBe('number')
    expect(Array.isArray(obj.capabilities)).toBe(true)
    expect(typeof obj.pairingCode).toBe('string')
    expect(typeof obj.expiresAt).toBe('number')
    expect(Array.isArray(obj.endpoints)).toBe(true)
    for (const ep of obj.endpoints) {
      expect(typeof ep.host).toBe('string')
      expect(typeof ep.port).toBe('number')
    }
  })
})

describe('契约 fixture：task_event_envelope.json（PC 半边）', () => {
  const envelope = JSON.parse(readFixture('task_event_envelope.json')) as TaskEventEnvelope

  it('形状对齐 shared/chat-core/events.ts TaskEventEnvelope', () => {
    expect(envelope.protocolVersion).toBe(2)
    expect(typeof envelope.eventId).toBe('string')
    expect(typeof envelope.taskId).toBe('string')
    expect(typeof envelope.requestId).toBe('string')
    expect(typeof envelope.sessionId).toBe('string')
    expect(typeof envelope.sequence).toBe('number')
    expect(envelope.type).toBe('task:chunk')
    expect(typeof envelope.timestamp).toBe('number')
    expect(envelope.payload).toMatchObject({ delta: expect.any(String), accumulatedLength: 24 })
  })

  it('是合法 WS 帧的 payload（对齐 taskWsAdapter 定向转发信封本体）', () => {
    // taskWsAdapter 广播帧：{ event: 'task:chunk', payload: envelope }
    const frame = JSON.stringify({ event: envelope.type, payload: envelope })
    const parsed = JSON.parse(frame) as { event: string; payload: TaskEventEnvelope }
    expect(parsed.event).toBe('task:chunk')
    expect(parsed.payload.taskId).toBe('task-contract-0001')
    expect(parsed.payload.sequence).toBe(4)
    expect(parsed.payload.payload).toHaveProperty('delta')
  })

  it('不含敏感字段', () => {
    expect(JSON.stringify(envelope)).not.toContain('token')
  })
})

describe('契约 fixture：message_identity.json（PC 半边）', () => {
  const fixture = JSON.parse(readFixture('message_identity.json')) as {
    singleMessages: Message[]
    groupMessages: GroupMessage[]
  }

  it('单聊与群聊显式快照字段一致', () => {
    expect(fixture.singleMessages.map((message) => [message.speakerKind, message.generationKind])).toEqual([
      ['persona', 'manual'],
      ['narrator', 'input_continue'],
      ['character', 'assistant_reply'],
      [undefined, undefined],
    ])
    expect(fixture.groupMessages.map((message) => [message.speakerKind, message.generationKind])).toEqual([
      ['narrator', 'manual'],
      ['character', 'assistant_reply'],
    ])
  })

  it('旧版缺字段消息仍按全局叙事用户方向回退为旁白', () => {
    expect(resolveMessageSpeakerKind(fixture.singleMessages[3])).toBe('narrator')
    expect(resolveMessageSpeakerKind(fixture.singleMessages[2])).toBe('character')
  })

  it('Android fixture 副本与共享权威文件完全一致', () => {
    const androidCopy = readFileSync(
      join(process.cwd(), 'android/app/src/test/resources/fixtures/message_identity.json'),
      'utf-8',
    )
    expect(androidCopy).toBe(readFixture('message_identity.json'))
  })
})
