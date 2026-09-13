import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-observation-test' },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { appendObservationToFile, resolveObservationsFilePath } from '../generationObservation'
import type { GenerationObservation } from '../../../shared/generationObservation'

function makeObservation(overrides: Partial<GenerationObservation> = {}): GenerationObservation {
  return {
    ts: Date.now(),
    requestId: 'req-1',
    source: 'single',
    model: 'deepseek-v4',
    requestedMaxTokens: 4096,
    stream: true,
    finishReason: 'stop',
    outcome: 'completed',
    bodyVisibleChars: 120,
    completionTokens: 800,
    reasoningTokens: 'unknown',
    durationMs: 3000,
    attempts: 1,
    diagnostics: {
      completeSentence: true,
      balancedQuotes: true,
      balancedAsterisks: true,
      closedThought: true,
    },
    ...overrides,
  }
}

describe('generationObservation 落盘', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qingyu-obs-'))
    filePath = join(dir, 'generation-observations.jsonl')
  })

  it('追加 JSONL（每行一条）', () => {
    appendObservationToFile(filePath, makeObservation({ requestId: 'a' }))
    appendObservationToFile(filePath, makeObservation({ requestId: 'b' }))
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const second = JSON.parse(lines[1]) as GenerationObservation
    expect(second.requestId).toBe('b')
  })

  it('超过阈值轮转为 .old（最多保留一代）', () => {
    appendObservationToFile(filePath, makeObservation({ requestId: 'old' }))
    // 手动膨胀文件超过 5MB 阈值
    writeFileSync(filePath, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf-8')
    appendObservationToFile(filePath, makeObservation({ requestId: 'new' }))
    expect(existsSync(`${filePath}.old`)).toBe(true)
    expect(statSync(filePath).size).toBeLessThan(5 * 1024 * 1024)
    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain('"new"')
    expect(content).not.toContain('"old"')
    rmSync(dir, { recursive: true, force: true })
  })

  it('解析默认路径（userData/data/diagnostics）', () => {
    expect(resolveObservationsFilePath().replace(/\\/g, '/')).toContain('/data/diagnostics/generation-observations.jsonl')
  })
})
