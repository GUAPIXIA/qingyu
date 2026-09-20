/**
 * 阶段 5：跨端**同步实体 payload** golden。
 *
 * 为什么单独成组、且优先级高于界面：
 * `contentHash` 是对 payload 的 canonical JSON 求 sha256，而阶段 7 的合并规则完全建立在
 * 「两端对同一份数据算出同一个哈希」之上。少一个键、多一个键、把 null 写成缺省、
 * 或数组截断上限不同，都会让同一实体出现两个不同哈希 —— 于是
 * 「同内容并发版本应自动收敛」失效，用户看到满屏伪冲突（总方案 §12 验收项）。
 *
 * 这类漂移**单测抓不到**：两端各自测自己的映射都「对」，只有对同一份输入比输出才会暴露。
 * 阶段 3 就因此把 Room 列名写进了信封，而 PC 用的是契约键名（见阶段 5 报告 §2.1）。
 *
 * oracle 直接取 PC 生产代码里的 payload 构造函数本身（不是复制一份规则），
 * 所以 PC 改动会立刻反映到 fixture；这些函数原本模块私有，为可测性加了 export，
 * 不改变任何行为。
 *
 * 生成：
 *   $env:SYNC_PAYLOAD_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/syncPayloadGolden.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

// 这些 payload 构造函数所在的模块会在导入期读取 `app.getPath('userData')`
// （storage.ts 的目录解析），vitest 环境里没有 electron 运行时，因此按仓库既有做法打桩。
vi.mock('electron', () => ({ app: { getPath: () => join(tmpdir(), 'qingyu-sync-payload-golden') } }))

import {
  characterEntityPayload,
  lorebookEntityPayload,
  regexRulePayload,
} from '../../electron/services/charCard'
import { personaEntityPayload } from '../../electron/ipc/persona'
import { presetEntityPayload } from '../../electron/ipc/preset'
import { ruleEntityPayload } from '../../electron/ipc/regex'
import { quickReplyStorePayload } from '../../electron/ipc/quickReply'
import { settingsPublicPayload } from '../../electron/ipc/settings'
import { usageRecordPayload } from '../../electron/services/usage'
import { MAX_RECORDS } from '../../electron/services/usage'
import { validateCharacterCard } from '../../electron/services/charCardValidator'
import { normalizePreset } from '../preset'
import type { Character } from '../types'

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'cross-platform', 'sync-payload')
const UPDATE = process.env.SYNC_PAYLOAD_UPDATE_FIXTURES === '1'

function writeFixture(name: string, data: unknown): void {
  const file = join(FIXTURE_DIR, `${name}.json`)
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  }
  if (!existsSync(file)) {
    throw new Error(
      `缺少 golden fixture：${file}\n首次生成：$env:SYNC_PAYLOAD_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/syncPayloadGolden.test.ts`,
    )
  }
  // 只读模式也要重新算一遍并比对：PC 改了 payload 规则而没重生成，这里必须先红
  expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual(data)
}

/** 一个基线角色，所有字段都填：用于观察 PC 到底下发了哪些键。 */
function fullCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-full',
    name: '完整角色',
    avatar: 'data:image/png;base64,iVBORw0KGgo=',
    cover: 'data:image/png;base64,iVBORw0KGgo=',
    description: '描述',
    personality: '性格',
    scenario: '场景',
    firstMessage: '你好',
    exampleDialog: '<START>\n用户: 在吗\n角色: 在',
    tags: ['A', 'B'],
    lorebookId: null,
    boundLorebookIds: ['lb-1', 'lb-2'],
    boundPresetId: 'preset-1',
    creator: '作者',
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    alternateGreetings: ['备选1', '备选2'],
    systemPrompt: '角色级系统提示',
    postHistoryInstructions: '这段不该进 payload',
    creatorNotes: '这段也不该进 payload',
    characterVersion: '1.2.3',
    groupOnlyGreetings: ['群聊开场'],
    extensions: { translation: { name: '译名' } },
    translatedContent: { name: '译名' },
    ...overrides,
  } as Character
}

const CHARACTER_CASES = [
  { label: 'full-character', input: fullCharacter() },
  { label: 'blank-name-falls-back', input: fullCharacter({ name: '   ' }) },
  { label: 'empty-name', input: fullCharacter({ name: '' }) },
  { label: 'no-bindings', input: fullCharacter({ boundLorebookIds: [], boundPresetId: null }) },
  {
    label: 'bound-preset-id-null-explicit',
    input: fullCharacter({ boundPresetId: null }),
  },
  {
    // 脏 tags：非字符串项要被过滤、超过 64 项要截断 —— 上限不同就哈希不同
    label: 'tags-dirty-and-truncated',
    input: fullCharacter({ tags: [...Array(70).keys()].map((n) => `t${n}`) as unknown as string[] }),
  },
  {
    label: 'alternate-greetings-truncated',
    input: fullCharacter({ alternateGreetings: [...Array(40).keys()].map((n) => `g${n}`) }),
  },
  { label: 'no-extensions', input: fullCharacter({ extensions: undefined }) },
  {
    label: 'minimal',
    input: { id: 'char-min', name: '最小角色' } as unknown as Character,
  },
]

describe('sync-payload / character', () => {
  it('pins characterEntityPayload', () => {
    writeFixture(
      'character-payload',
      {
        algorithm: 'electron/services/charCard.ts#characterEntityPayload',
        // 这份清单是 Android 必须**不发**的键：它们属于本地保真/Backup V3，不在契约里
        deliberatelyExcluded: [
          'avatarPath', 'backgroundPath', 'postHistoryInstructions', 'creatorNotes',
          'characterVersion', 'groupOnlyGreetings', 'authorNote', 'embeddedLorebook',
          'defaultMemoryMode', 'defaultNarrativeMode', 'translatedContent', 'lorebookId',
        ],
        cases: CHARACTER_CASES.map((entry) => {
          const validation = validateCharacterCard(entry.input)
          let payload: unknown = null
          let error: string | null = null
          try {
            payload = characterEntityPayload(entry.input as Character)
          } catch (cause) {
            error = (cause as Error).message
          }
          return {
            label: entry.label,
            keys: payload ? Object.keys(payload).sort() : null,
            payload,
            error,
            cardFormat: validation.format,
          }
        }),
      },
    )
  })
})

describe('sync-payload / other entity types', () => {
  it('pins persona, preset, regex, quick reply, usage, settings payloads', () => {
    const personas = [
      { label: 'full', input: { id: 'p-1', name: '小明', description: '说明', persona: '正文' } },
      { label: 'empty-optional', input: { id: 'p-2', name: '', description: '', persona: '' } },
    ].map((entry) => ({ label: entry.label, payload: personaEntityPayload(entry.input as never) }))

    const presets = [
      { label: 'min-normalized', input: normalizePreset({ id: 'pre-1', name: '默认' }) },
      {
        label: 'all-optional',
        input: normalizePreset({
          id: 'pre-2', name: '全字段', temperature: 1.1, topP: 0.9, maxTokens: 1024,
          contextTemplate: 'chatml', group: '风格', exampleDialogMode: 'first_turn',
          enableThoughtFormat: true, responseLengthHint: 'balanced', isBuiltin: true,
        }),
      },
    ].map((entry) => ({ label: entry.label, payload: presetEntityPayload(entry.input as never) }))

    const regexRules = [
      { label: 'minimal', input: { id: 'r-1', name: '清理', pattern: 'a+', replacement: 'b', enabled: true, scope: 'output' } },
      {
        label: 'full',
        input: {
          id: 'r-2', name: '全字段', pattern: 'x', replacement: 'y', flags: 'gi', enabled: true,
          scope: 'both', group: '格式清理', stage: 'markdown', triggerPattern: '触发',
          triggerFlags: 'i', stopStrings: ['\\n\\n', 'END'],
        },
      },
    ].map((entry) => ({
      label: entry.label,
      payload: regexRulePayload(entry.input as never),
      alsoViaIpc: ruleEntityPayload(entry.input as never),
    }))

    const quickReplyStores = [
      { label: 'empty-store', input: { global: [], byCharacter: {} } },
      {
        label: 'global-and-character',
        input: {
          global: [
            { id: 'q1', label: '甲', content: '你好', action: 'text', sendWithAI: true, order: 0, enabled: true },
            { id: 'q2', label: '切预设', content: '', action: 'preset', presetId: 'pre-1', sendWithAI: false, order: 1, enabled: true, hotkey: 3 },
          ],
          byCharacter: {
            'char-full': [{ id: 'q3', label: '命令', content: '', action: 'command', command: '/continue', sendWithAI: false, order: 0, enabled: false }],
            'char-empty': [],
          },
        },
      },
    ].map((entry) => ({ label: entry.label, payload: quickReplyStorePayload(entry.input as never) }))

    const usages = [
      { label: 'typical', input: { id: 'u1', timestamp: 1700000000000, characterId: 'char-full', sessionId: 's1', model: 'gpt-x', inputChars: 120, outputChars: 340, totalChars: 460 } },
      { label: 'no-session', input: { id: 'u2', timestamp: 1700000000001, model: 'claude-y', inputChars: 0, outputChars: 0, totalChars: 0 } },
    ].map((entry) => ({
      label: entry.label,
      payload: usageRecordPayload(entry.input as never),
      // PC 的 payload 不含 id：id 就是 entityId，重复下发会让两端哈希含不同信息
      containsId: 'id' in (usageRecordPayload(entry.input as never) as Record<string, unknown>),
    }))

    const settingsCases = [
      { label: 'empty', input: {} },
      { label: 'unknown-theme-dropped', input: { theme: 'hotdog', language: 'zh-CN' } },
      { label: 'valid-theme', input: { theme: 'dark', language: 'en' } },
      { label: 'long-language-dropped', input: { language: 'x'.repeat(33) } },
      { label: 'active-ids-null-preserved', input: { activePersonaId: null, activePresetId: 'p-1' } },
      { label: 'response-length-invalid', input: { responseLengthMode: 'extra-long' } },
    ].map((entry) => ({ label: entry.label, payload: settingsPublicPayload(entry.input as never) }))

    const lorebookDocs = [
      {
        label: 'canonical-v2-minimal',
        input: {
          schema: 'qingyu_lorebook', schemaVersion: 2, id: 'lb-1', revision: 1,
          name: '书', description: '', enabled: true,
          defaults: { scanDepth: 2, recursiveScanning: true },
          entries: [], createdAt: 1, updatedAt: 2,
        },
      },
      {
        label: 'with-foreign',
        input: {
          schema: 'qingyu_lorebook', schemaVersion: 2, id: 'lb-2', revision: 3,
          name: '带未知字段', description: 'd', enabled: false,
          defaults: { scanDepth: 1, recursiveScanning: false, tokenBudget: 300 },
          entries: [{ id: 'e1', enabled: true, content: 'c', activation: { mode: 'conditional', budgetTier: 'standard', primaryKeys: ['k'], secondaryKeys: [], aliases: [], keyLogic: 'any', caseSensitive: false, wholeWords: false, regex: { enabled: false, flags: '' }, retrieval: 'keyword' }, insertion: { kind: 'prompt', anchor: 'before_character' }, scheduling: { order: 0, probability: 100, recursion: { exclude: false, prevent: false, minDepth: 0 }, groups: [], groupScoring: false, ignoreBudget: false }, someUnknownField: { keep: 'me' } }],
          foreign: { vendorExtras: 1 }, createdAt: 1, updatedAt: 2,
        },
      },
    ].map((entry) => {
      const payload = lorebookEntityPayload(entry.input as never) as Record<string, unknown>
      return {
        label: entry.label,
        keys: Object.keys(payload).sort(),
        payload,
        // 世界书 payload 是「整个 canonical 文档去掉 id」，因此 entries/foreign 必须原样在里面
        hasEntries: Array.isArray(payload.entries),
        hasForeign: 'foreign' in payload,
      }
    })

    writeFixture('other-entity-payloads', {
      algorithms: {
        persona: 'electron/ipc/persona.ts#personaEntityPayload',
        preset: 'electron/ipc/preset.ts#presetEntityPayload',
        regex_rule: 'electron/services/charCard.ts#regexRulePayload + electron/ipc/regex.ts#ruleEntityPayload',
        quick_reply_set: 'electron/ipc/quickReply.ts#quickReplyStorePayload (整库单实体 quick-replies-root)',
        usage_record: 'electron/services/usage.ts#usageRecordPayload',
        settings_public: 'electron/ipc/settings.ts#settingsPublicPayload (整份设置单实体 settings-public)',
        lorebook: 'electron/services/charCard.ts#lorebookEntityPayload',
      },
      persona: personas,
      preset: presets,
      regex_rule: regexRules,
      quick_reply_set: quickReplyStores,
      usage_record: usages,
      settings_public: settingsCases,
      lorebook: lorebookDocs,
    })

    // 用量保留上限也是跨端确定性行为（超限时淘汰最旧并逐条产 tombstone）。
    // 只写在注释里等于没有守卫：PC 改了 10000、Android 没跟，不会有任何测试变红，
    // 而结果是两台设备看到不同的用量历史。
    writeFixture('usage-retention', {
      algorithm: 'electron/services/usage.ts#MAX_RECORDS',
      maxRecords: MAX_RECORDS,
    })
  })

  it('PC 的两处 regexRulePayload 实现彼此一致', () => {
    // 同一条规则在 charCard 与 ipc/regex 两处各有一份 `{...rule} - id`，
    // 两处若漂移，PC 自己的 bootstrap 与增量写就会给出不同哈希。
    const rule = { id: 'r-x', name: 'n', pattern: 'p', replacement: 'r', flags: 'g', enabled: true, scope: 'output' }
    expect(JSON.stringify(regexRulePayload(rule as never))).toBe(JSON.stringify(ruleEntityPayload(rule as never)))
  })
})
