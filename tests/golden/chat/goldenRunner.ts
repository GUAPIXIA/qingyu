/**
 * V12-01-2 Golden Runner 骨架
 *
 * 贯穿 0.12 迁移：旧引擎（0.11.28）产出 -> 快照锁定 -> 新引擎（Orchestrator + FakeModelPort）
 * 对同一 fixture 产出一致。
 *
 * 当前为骨架：遍历 fixtures/*.json 并做基础契约校验（id/input/contextSnapshot 必填）。
 * V12-02 后接入真实 ContextService/PostProcessor，V12-06 后接入 FakeModelPort 全链路。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface GoldenFixture {
  id: string
  description: string
  input: { content: string; images?: string[]; replyToId?: string }
  contextSnapshot: Record<string, unknown>
  modelResponses: Array<{ delta: string; usage?: unknown }>
  expected: { userMessage: { content: string }; assistantMessage: { content: string } }
}

export function listFixtures(dir = join(__dirname, 'fixtures')): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.json')) out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

export function loadFixture(path: string): GoldenFixture {
  const raw = readFileSync(path, 'utf-8')
  const data = JSON.parse(raw) as GoldenFixture
  if (!data.id || !data.input || !data.contextSnapshot) {
    throw new Error(`Fixture 契约缺失: ${path}`)
  }
  return data
}

/** 骨架校验：仅检查契约与 expected 非空，不跑引擎（引擎在 V12-06 接入） */
export function validateFixture(fixture: GoldenFixture): string[] {
  const errors: string[] = []
  if (!fixture.expected?.userMessage?.content && fixture.expected?.userMessage?.content !== '') {
    errors.push('expected.userMessage.content 缺失')
  }
  if (!fixture.expected?.assistantMessage?.content && fixture.expected?.assistantMessage?.content !== '') {
    errors.push('expected.assistantMessage.content 缺失')
  }
  return errors
}
