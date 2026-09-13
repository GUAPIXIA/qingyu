// @vitest-environment node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dialog, IpcMain } from 'electron'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-lorebook-adapter-ipc' },
}))

import { registerLorebookIPC } from '../lorebook'

const root = '/tmp/qingyu-lorebook-adapter-ipc'
const handlers = new Map<string, (...args: unknown[]) => unknown>()

function ipcMainMock(): IpcMain {
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
  } as unknown as IpcMain
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  handlers.clear()
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('lorebook:importJsonDetailed adapter integration', () => {
  it('返回检测/兼容报告并直接写入 canonical v2', async () => {
    const source = join(root, 'sillytavern-world-info.json')
    const exportedPath = join(root, 'exported-world-info.json')
    writeFileSync(source, JSON.stringify({
      name: 'ST 导入测试',
      futureBookOption: { keep: true },
      entries: {
        1: {
          uid: 1,
          key: ['王城'],
          content: '王城设定',
          position: 2,
          disable: false,
          extensions: { future_trigger: 'vNext' },
        },
      },
    }), 'utf8')
    const dialog = {
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [source] })),
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: exportedPath })),
    } as unknown as Dialog
    registerLorebookIPC(ipcMainMock(), dialog)

    const result = await handlers.get('lorebook:importJsonDetailed')!({}) as {
      lorebook: { id: string; name: string; entries: unknown[] }
      detection: { adapterId: string; confidence: number }
      report: { status: string; summary: { preserved: number; approximated: number } }
    }
    expect(result).toMatchObject({
      lorebook: { name: 'ST 导入测试' },
      detection: { adapterId: 'sillytavern.world-info', confidence: 100 },
      // AN 位置已由运行时精确渲染，导入报告不再标记为近似
      report: { status: 'preserved' },
    })
    expect(result.report.summary.preserved).toBeGreaterThan(0)
    expect(result.report.summary.approximated).toBe(0)

    const persisted = JSON.parse(readFileSync(
      join(root, 'data', 'lorebooks', `${result.lorebook.id}.json`),
      'utf8',
    ))
    expect(persisted).toMatchObject({
      schema: 'qingyu_lorebook',
      schemaVersion: 2,
      revision: 1,
      source: { adapterId: 'sillytavern.world-info' },
      entries: [{ insertion: { kind: 'prompt', anchor: 'authors_note_top' } }],
    })
    expect(JSON.stringify(persisted.foreign)).toContain('futureBookOption')
    expect(JSON.stringify(persisted.entries[0].foreign)).toContain('future_trigger')

    const exportResult = await handlers.get('lorebook:exportJson')!({}, result.lorebook.id) as {
      ok: boolean; adapterId: string
    }
    expect(exportResult).toEqual(expect.objectContaining({ ok: true, adapterId: 'sillytavern.world-info' }))
    const exported = JSON.parse(readFileSync(exportedPath, 'utf8'))
    expect(exported).toMatchObject({
      name: 'ST 导入测试',
      futureBookOption: { keep: true },
    })
    expect(Object.values(exported.entries)[0]).toMatchObject({ position: 2 })
    expect(JSON.stringify(exported)).toContain('future_trigger')
  })
})
