// @vitest-environment node
/**
 * UEX-P1-28：世界书语义索引进度 + 取消 + 防重入
 * （embedding:indexLorebook / embedding:indexCancel / embedding:indexProgress）：
 * - 逐条目进度上报 { current, total, entryName? }（safeSend → embedding:indexProgress）
 * - 取消在条目边界停止，已完成条目向量保留不回滚（旧索引条目也不被覆盖）
 * - 取消幂等（重复点击 / 无进行中批次 / 非目标书均安全）
 * - 双层防重入：主进程拒绝并发批次（UI 侧另有入口禁用），批次结束后立即放开
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, WebContents } from 'electron'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-embedding-index-progress' },
}))

const DIMS = 8

/** 受控嵌入调用：每条目一次，resolve 由测试逐个放行（模拟慢嵌入 / 取消时机） */
interface EmbedCall {
  texts: string[]
  promise: Promise<number[][]>
  resolve: (vectors: number[][]) => void
}
const embedCalls: EmbedCall[] = []
/** true 时嵌入立即返回固定向量（不需要逐条放行的用例） */
let autoResolveEmbed = false

vi.mock('../localModels', () => ({
  getLocalModelManager: () => ({
    embed: (texts: string[]) => {
      let resolveFn!: (vectors: number[][]) => void
      const promise = new Promise<number[][]>((resolve) => { resolveFn = resolve })
      embedCalls.push({ texts, promise, resolve: resolveFn })
      if (autoResolveEmbed) resolveFn(texts.map(() => new Array(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))))
      return promise
    },
    test: () => Promise.resolve({ ok: true, dimensions: DIMS, error: undefined }),
    activeManifest: () => ({ id: 'bge-small-zh', version: '1.2.3', maxTokens: 512 }),
  }),
}))

import { registerEmbeddingIPC } from '../embedding'
import { DIRS } from '../../services/storage'
import { getVectorIndex, saveVectorIndex, removeVectorIndex } from '../../services/vectorStore'

const root = '/tmp/qingyu-embedding-index-progress'
const handlers = new Map<string, (...args: unknown[]) => unknown>()

function ipcMainMock(): IpcMain {
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  } as unknown as IpcMain
}

/** fake webContents：捕获进度事件（safeSend 走 isDestroyed/send） */
function fakeSender() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const sender = {
    isDestroyed: () => false,
    send: vi.fn((channel: string, payload: unknown) => { sent.push({ channel, payload }) }),
  } as unknown as WebContents
  return { event: { sender }, sent }
}

/** canonical v2 世界书（通过真实 readLorebookView 读取） */
function writeLorebook(id: string, entryIds: string[]): void {
  writeFileSync(join(DIRS.lorebooks(), `${id}.json`), JSON.stringify({
    schema: 'qingyu_lorebook',
    schemaVersion: 2,
    id,
    revision: 1,
    name: id,
    description: '',
    enabled: true,
    defaults: { scanDepth: 4, recursiveScanning: true },
    entries: entryIds.map((entryId) => ({
      id: entryId,
      enabled: true,
      content: `${entryId} 的设定正文`,
      activation: {
        mode: 'conditional',
        budgetTier: 'standard',
        primaryKeys: [entryId],
        secondaryKeys: [],
        aliases: [],
        keyLogic: 'any',
        caseSensitive: false,
        wholeWords: true,
        regex: { enabled: false, flags: 'i' },
        retrieval: 'hybrid',
      },
      insertion: { kind: 'prompt', anchor: 'before_character' },
      scheduling: {
        order: 100,
        probability: 100,
        scanDepth: 4,
        recursion: { exclude: false, prevent: false, minDepth: 0 },
        groups: [],
        groupScoring: false,
        ignoreBudget: false,
      },
    })),
    createdAt: 1,
    updatedAt: 1,
  }), 'utf8')
}

const LOCAL_MODEL = 'bge-small-zh@1.2.3'
const LOCAL_SPACE = { provider: 'local' as const, model: LOCAL_MODEL, modelId: 'bge-small-zh', modelVersion: '1.2.3' }
const CONFIG = { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' }
const VEC = () => new Array(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(DIRS.lorebooks(), { recursive: true })
  // 清理 vectorStore 模块级内存缓存（先覆盖写再删除，与 embeddingSemanticSearch 用例一致）
  saveVectorIndex('lb1', LOCAL_MODEL, {}, LOCAL_SPACE)
  removeVectorIndex('lb1')
  handlers.clear()
  embedCalls.length = 0
  autoResolveEmbed = false
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('UEX-P1-28：语义索引进度 + 取消', () => {
  it('逐条目上报进度 { current, total, entryName? } 到 embedding:indexProgress', async () => {
    autoResolveEmbed = true
    writeLorebook('lb1', ['e1', 'e2', 'e3'])
    registerEmbeddingIPC(ipcMainMock())
    const { event, sent } = fakeSender()

    const result = await handlers.get('embedding:indexLorebook')!(event, 'lb1', CONFIG) as { ok: boolean; canceled?: boolean; indexed: number; total: number }

    expect(result).toMatchObject({ ok: true, canceled: false, indexed: 3, total: 3 })
    const progress = sent.filter((m) => m.channel === 'embedding:indexProgress').map((m) => m.payload as { lorebookId: string; current: number; total: number; entryName?: string })
    expect(progress.map((p) => p.current)).toEqual([1, 2, 3])
    expect(progress.every((p) => p.lorebookId === 'lb1' && p.total === 3)).toBe(true)
    expect(progress.every((p) => typeof p.entryName === 'string' && p.entryName.length > 0)).toBe(true)
  })

  it('取消在条目边界停止：已完成条目保留不回滚，旧索引条目不被覆盖', async () => {
    writeLorebook('lb1', ['e1', 'e2', 'e3'])
    // 旧索引已有条目（全量重建）——取消后必须原样保留
    saveVectorIndex('lb1', LOCAL_MODEL, { 'old-entry': new Array(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0)) }, LOCAL_SPACE)
    registerEmbeddingIPC(ipcMainMock())
    const { event } = fakeSender()

    const run = handlers.get('embedding:indexLorebook')!(event, 'lb1', CONFIG) as Promise<{ ok: boolean; canceled?: boolean; indexed: number; total: number }>
    await vi.waitFor(() => expect(embedCalls).toHaveLength(1))
    embedCalls[0].resolve([new Array(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))])
    await vi.waitFor(() => expect(embedCalls).toHaveLength(2))
    // 第 2 个条目嵌入在途时取消（本地嵌入不可中断：该条目允许完成后，在下一条目边界停止）
    await handlers.get('embedding:indexCancel')!(null, 'lb1')
    embedCalls[1].resolve([new Array(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))])

    const result = await run
    expect(result).toMatchObject({ ok: true, canceled: true, indexed: 2, total: 3 })
    expect(embedCalls).toHaveLength(2)
    const index = getVectorIndex('lb1', LOCAL_SPACE)
    // 已完成 e1/e2 保留 + 旧条目不回滚；未处理 e3 不出现
    expect(Object.keys(index?.entries ?? {}).sort()).toEqual(['e1', 'e2', 'old-entry'])
  })

  it('取消幂等：重复取消 / 无进行中批次均安全返回', async () => {
    registerEmbeddingIPC(ipcMainMock())
    const cancel = handlers.get('embedding:indexCancel')!
    // 无进行中批次：两次都安全
    expect(await cancel(null)).toEqual({ ok: true })
    expect(await cancel(null, 'lb1')).toEqual({ ok: true })

    writeLorebook('lb1', ['e1', 'e2'])
    registerEmbeddingIPC(ipcMainMock())
    const run = handlers.get('embedding:indexLorebook')!(fakeSender().event, 'lb1', CONFIG) as Promise<{ ok: boolean; canceled?: boolean }>
    await vi.waitFor(() => expect(embedCalls).toHaveLength(1))
    // 进行中重复取消 + 非目标书取消均安全（幂等；非目标书不触发取消）
    await cancel(null, 'lb1')
    await cancel(null, 'lb1')
    expect(await cancel(null, 'other-book')).toEqual({ ok: true })
    embedCalls[0].resolve([new Array(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))])
    const result = await run
    expect(result.canceled).toBe(true)
    // 批次已结束：再取消仍是幂等 no-op
    expect(await cancel(null, 'lb1')).toEqual({ ok: true })
  })

  it('非目标书的取消请求不打断当前批次（lorebookId 边界检查）', async () => {
    writeLorebook('lb1', ['e1', 'e2'])
    registerEmbeddingIPC(ipcMainMock())
    const run = handlers.get('embedding:indexLorebook')!(fakeSender().event, 'lb1', CONFIG) as Promise<{ ok: boolean; canceled?: boolean; indexed: number }>
    await vi.waitFor(() => expect(embedCalls).toHaveLength(1))
    await handlers.get('embedding:indexCancel')!(null, 'other-book')
    embedCalls[0].resolve([VEC()])
    await vi.waitFor(() => expect(embedCalls).toHaveLength(2))
    embedCalls[1].resolve([VEC()])
    const result = await run
    expect(result.canceled).toBe(false)
    expect(result.indexed).toBe(2)
  })

  it('防重入：批次进行中再次触发被拒绝，批次结束后立即放开', async () => {
    writeLorebook('lb1', ['e1'])
    registerEmbeddingIPC(ipcMainMock())
    const index = handlers.get('embedding:indexLorebook')!

    const first = index(fakeSender().event, 'lb1', CONFIG) as Promise<{ ok: boolean; error?: string }>
    await vi.waitFor(() => expect(embedCalls).toHaveLength(1))
    // 双层防重入的主进程兜底：并发批次直接拒绝
    const rejected = await index(fakeSender().event, 'lb1', CONFIG) as { ok: boolean; error?: string }
    expect(rejected).toMatchObject({ ok: false, error: '已有索引任务进行中' })

    embedCalls[0].resolve([new Array(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))])
    await expect(first).resolves.toMatchObject({ ok: true })

    // 批次结束（含取消/异常）即释放锁：立即重新发起成功
    autoResolveEmbed = true
    const again = await index(fakeSender().event, 'lb1', CONFIG) as { ok: boolean }
    expect(again).toMatchObject({ ok: true })
  })
})
