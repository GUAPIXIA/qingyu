import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TEST_ROOT = '/tmp/qingyu-postproc-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { DIRS, writeJson } from '../../services/storage'
import { postProcessOutput } from '../postProcessor'
import type { RegexRule } from '../../../shared/types'

function rule(p: Partial<RegexRule>): RegexRule {
  return { id: 'r1', name: 't', pattern: p.pattern ?? '', replacement: p.replacement ?? '', flags: p.flags, enabled: p.enabled ?? true, scope: p.scope ?? 'output', stage: p.stage ?? 'text', stopStrings: p.stopStrings } as RegexRule
}

beforeEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

describe('PostProcessor', () => {
  it('output 规则生效', () => {
    const r = rule({ pattern: 'foo', replacement: 'bar', scope: 'output', stage: 'text' })
    const { text } = postProcessOutput('foo baz', [r])
    expect(text).toBe('bar baz')
  })

  it('stopStrings 截断', () => {
    const r = rule({ pattern: '', replacement: '', scope: 'output', stage: 'text', stopStrings: ['STOP'] })
    const { text, truncated } = postProcessOutput('a STOP b', [r])
    expect(text.trim()).toBe('a')
    expect(truncated).toBe(true)
  })

  it('正则后才截断', () => {
    const r1 = rule({ pattern: 'foo', replacement: 'STOP', scope: 'output', stage: 'text', stopStrings: ['STOP'] })
    const { text } = postProcessOutput('foo bar', [r1])
    expect(text).toBe('')
  })
})
