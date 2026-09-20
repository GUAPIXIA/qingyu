/**
 * PC 独立缺陷回归证据（阶段 5 S5-01 发现，按方案 §0 单独立项）。
 *
 * 缺陷：`electron/services/charCard.ts` 的 1x1 透明 PNG 导出基底常量声明
 * `IDAT` 长度为 11，实际数据 13 字节，因此按块遍历在 `IEND` 之前脱轨。
 * 触发路径：头像不是 PNG（JPG/WebP data URL）或没有头像的角色卡导出为 PNG。
 *
 * 影响面：`chara` 段被插在脱轨位置之后，`readPngTextChunks` 找不到它，
 * `importCharacterFromPng` 抛「该 PNG 文件不包含角色卡数据」——
 * 即 **PC 自己导出的 PNG 角色卡，PC 自己也导不回去**，跨端往返更不可能成立
 * （阶段 5 方案 §3「P0 格式跨端往返无语义损失」在这条路径上是断的）。
 *
 * 本文件是修复前会红、修复后为常绿的证据：
 * - 第 1 组用例钉住「基底 PNG 必须能被按块走到 IEND」；
 * - 第 2 组用真实导出/导入函数走一遍此前会断的往返；
 * - 第 3 组证明旧常量确实是坏的（把缺陷本身也钉住，避免有人改回去而测试仍绿）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readPngTextChunks, writePngTextChunk, detectMimeType } from '../charCardPng'
import { exportCharacterToPng, importCharacterFromPng } from '../charCard'
import type { Character } from '../../../shared/types'

const FIXED_BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
/** 修复前 PC 代码里的那一段（IDAT 长度字段被写成 0x0b） */
const BROKEN_BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 按规范走块：返回到达 IEND 时是否恰好用尽字节。 */
function chunkTypes(buffer: Buffer): { types: string[]; desynced: boolean } {
  const types: string[] = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) return { types, desynced: true }
    types.push(type)
    offset += 8 + length + 4
  }
  return { types, desynced: offset !== buffer.length }
}

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'c-png-base',
    name: '基底回归卡',
    avatar: '',
    description: 'd',
    personality: 'p',
    scenario: 's',
    firstMessage: 'hello',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 1,
    updatedAt: 1,
    alternateGreetings: [],
    ...overrides,
  } as Character
}

describe('角色卡 PNG 导出基底结构合法性', () => {
  it('修好的 1x1 透明 PNG 能按块走到 IEND 且字节恰好用尽', () => {
    const buffer = Buffer.from(FIXED_BLANK_PNG_BASE64, 'base64')
    expect(detectMimeType(buffer)).toBe('image/png')
    const { types, desynced } = chunkTypes(buffer)
    expect(desynced, `块遍历脱轨：${types.join(',')}`).toBe(false)
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND'])
  })

  it('旧的常量确实是坏的（钉住缺陷本身，防止改回去还全绿）', () => {
    const { types, desynced } = chunkTypes(Buffer.from(BROKEN_BLANK_PNG_BASE64, 'base64'))
    expect(desynced).toBe(true)
    expect(types).toEqual(['IHDR', 'IDAT'])
  })

  it('在修好的基底上写 chara 段后仍能被读回', () => {
    const base = Buffer.from(FIXED_BLANK_PNG_BASE64, 'base64')
    const embedded = writePngTextChunk(base, 'chara', 'eyJuYW1lIjoi5Z+OIn0=')
    expect(readPngTextChunks(embedded)['chara']).toBe('eyJuYW1lIjoi5Z+OIn0=')
    expect(chunkTypes(embedded).desynced).toBe(false)
  })
})

describe('无 PNG 头像的角色卡：导出 PNG → 再导入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qingyu-charcard-'))

  it.each([
    { label: '没有头像', avatar: '' },
    { label: 'JPG 头像', avatar: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
    { label: 'WebP 头像', avatar: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAA' },
  ])('$label 时导出的 PNG 必须能被重新导入', async ({ avatar }) => {
    const savePath = join(dir, `${avatar.replace(/\W/g, '_') || 'none'}.png`)
    try {
      exportCharacterToPng(makeCharacter({ avatar }), savePath)
      const imported = await importCharacterFromPng(savePath)
      expect(imported.name).toBe('基底回归卡')
      expect(imported.firstMessage).toBe('hello')
      // 头像是那段 1x1 透明的 data URL，而不是空
      expect(imported.avatar.startsWith('data:image/png;base64,')).toBe(true)
    } finally {
      rmSync(savePath, { force: true })
    }
  })

  it('真实导出的字节里 chara 段可被解析出 spec 字段', async () => {
    const savePath = join(dir, 'inspect.png')
    try {
      exportCharacterToPng(makeCharacter({ avatar: '' }), savePath)
      const chunks = readPngTextChunks(readFileSync(savePath))
      const parsed = JSON.parse(Buffer.from(chunks['chara'], 'base64').toString('utf-8')) as {
        spec: string
        spec_version: string
        data: { name: string }
      }
      expect(parsed.spec).toBe('chara_card_v2')
      expect(parsed.spec_version).toBe('2.0')
      expect(parsed.data.name).toBe('基底回归卡')
    } finally {
      rmSync(savePath, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
