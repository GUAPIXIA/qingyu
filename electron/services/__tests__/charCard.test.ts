/**
 * 角色卡前端扩展适配单元测试
 *
 * 覆盖：regex_scripts / quick_replies 转换、落地、幂等、跳过不支持项。
 * 通过 mock electron 的 userData 路径隔离到临时目录。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'

// electron 运行时依赖 mock（storage.ts 使用 app.getPath）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-char-card-test' },
}))

import { importCardFrontendExtensions } from '../charCard'
import type { Character } from '../../../shared/types'

const TEST_DATA_DIR = '/tmp/qingyu-char-card-test/data'

function makeCharacter(extensions: Record<string, unknown> | undefined): Character {
  return {
    id: 'char-1',
    name: '测试角色',
    avatar: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '你好',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    alternateGreetings: [],
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    extensions,
  }
}

function readRegexRules() {
  const p = join(TEST_DATA_DIR, 'config', 'regex', 'rules.json')
  if (!existsSync(p)) return []
  return JSON.parse(readFileSync(p, 'utf-8')) as Array<{ name: string; pattern: string; scope: string; stage?: string; group?: string; enabled: boolean }>
}

function readQuickReplyStore() {
  const p = join(TEST_DATA_DIR, 'config', 'quickReplies.json')
  if (!existsSync(p)) return { global: [], byCharacter: {} }
  return JSON.parse(readFileSync(p, 'utf-8')) as { global: unknown[]; byCharacter: Record<string, Array<{ id: string; label: string; content: string }>> }
}

beforeEach(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true })
})

describe('importCardFrontendExtensions', () => {
  it('无 extensions 时返回空结果且不写文件', () => {
    const r = importCardFrontendExtensions(makeCharacter(undefined))
    expect(r).toEqual({ regexCount: 0, quickReplyCount: 0, skipped: [] })
    expect(existsSync(join(TEST_DATA_DIR, 'config', 'regex'))).toBe(false)
    expect(existsSync(join(TEST_DATA_DIR, 'config', 'quickReplies.json'))).toBe(false)
  })

  it('导入官方 regex_scripts：placement → scope 映射', () => {
    const r = importCardFrontendExtensions(makeCharacter({
      regex_scripts: [
        { scriptName: '清理星号', findRegex: '\\*\\*', replaceString: '', placement: ['ai_output'], disabled: false },
        { scriptName: '输入清洗', findRegex: '\\{\\{x\\}\\}', replaceString: 'y', placement: ['user_input'], disabled: false },
        { scriptName: '双向规则', findRegex: 'a', replaceString: 'b', placement: ['user_input', 'ai_output'], disabled: false },
      ],
    }))
    expect(r.regexCount).toBe(3)
    const rules = readRegexRules()
    expect(rules).toHaveLength(3)
    expect(rules[0]).toMatchObject({ name: '清理星号', pattern: '\\*\\*', scope: 'output', flags: 'gi', group: '角色卡导入', enabled: true, stage: 'text' })
    expect(rules[1].scope).toBe('input')
    expect(rules[2].scope).toBe('both')
  })

  it('placement 缺失时默认 both（与 ST 默认一致）', () => {
    importCardFrontendExtensions(makeCharacter({
      regex_scripts: [{ scriptName: '默认', findRegex: 'x', replaceString: 'y' }],
    }))
    const rules = readRegexRules()
    expect(rules[0].scope).toBe('both')
  })

  it('disabled 与 markdownOnly 映射', () => {
    importCardFrontendExtensions(makeCharacter({
      regex_scripts: [
        { scriptName: '禁用项', findRegex: 'a', replaceString: 'b', disabled: true },
        { scriptName: '渲染阶段', findRegex: 'c', replaceString: 'd', markdownOnly: true, placement: ['ai_output'] },
      ],
    }))
    const rules = readRegexRules()
    expect(rules[0].enabled).toBe(false)
    expect(rules[1].stage).toBe('markdown')
  })

  it('跳过 promptOnly 与纯 input 的 markdownOnly（无对应阶段）', () => {
    const r = importCardFrontendExtensions(makeCharacter({
      regex_scripts: [
        { scriptName: '仅提示词', findRegex: 'a', replaceString: 'b', promptOnly: true },
        { scriptName: 'input渲染', findRegex: 'c', replaceString: 'd', markdownOnly: true, placement: ['user_input'] },
      ],
    }))
    expect(r.regexCount).toBe(0)
    expect(r.skipped).toHaveLength(2)
    expect(readRegexRules()).toHaveLength(0)
  })

  it('导入官方 quick_replies：text 与 command 动作', () => {
    const r = importCardFrontendExtensions(makeCharacter({
      quick_replies: [
        { id: 'qr-1', label: '摸头', message: '*摸摸你的头*', messageType: 'text', hotkey: 1 },
        { id: 'qr-2', label: '生成立绘', message: '/gen', messageType: 'command', hotkey: 2 },
      ],
    }))
    expect(r.quickReplyCount).toBe(2)
    const store = readQuickReplyStore()
    const list = store.byCharacter['char-1']
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: 'qr-1', label: '摸头', content: '*摸摸你的头*', action: 'text', hotkey: 1 })
    expect(list[1]).toMatchObject({ id: 'qr-2', label: '生成立绘', content: '/gen', action: 'command' })
  })

  it('幂等：重复导入不重复添加', () => {
    const exts = {
      regex_scripts: [{ scriptName: '规则A', findRegex: 'a', replaceString: 'b' }],
      quick_replies: [{ id: 'qr-1', label: '摸头', message: '内容' }],
    }
    const c = makeCharacter(exts)
    const r1 = importCardFrontendExtensions(c)
    const r2 = importCardFrontendExtensions(c)
    expect(r1.regexCount).toBe(1)
    expect(r1.quickReplyCount).toBe(1)
    expect(r2.regexCount).toBe(0)
    expect(r2.quickReplyCount).toBe(0)
    expect(readRegexRules()).toHaveLength(1)
    expect(readQuickReplyStore().byCharacter['char-1']).toHaveLength(1)
  })

  it('多张卡的正则互不冲突（按 pattern+scope 幂等）', () => {
    importCardFrontendExtensions(makeCharacter({ regex_scripts: [{ scriptName: 'A', findRegex: 'x', replaceString: '1' }] }))
    const c2 = makeCharacter({ regex_scripts: [{ scriptName: 'B', findRegex: 'x', replaceString: '2' }] })
    c2.id = 'char-2'
    importCardFrontendExtensions(c2)
    expect(readRegexRules()).toHaveLength(1) // 相同 pattern+scope 视为已导入
  })

  it('损坏的既有存储不阻断导入', () => {
    mkdirSync(join(TEST_DATA_DIR, 'config', 'regex'), { recursive: true })
    writeFileSync(join(TEST_DATA_DIR, 'config', 'regex', 'rules.json'), '{{{ 损坏 JSON', 'utf-8')
    const r = importCardFrontendExtensions(makeCharacter({
      regex_scripts: [{ scriptName: 'A', findRegex: 'x', replaceString: '1' }],
    }))
    expect(r.regexCount).toBe(1)
    expect(readRegexRules()).toHaveLength(1)
  })
})
