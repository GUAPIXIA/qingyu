/**
 * 阶段7.2：跨端语义分块共享 fixture 测试（方案 §6.2/§6.3）。
 *
 * shared/fixtures/roleplay-blocks.json 是 PC 与 Android 的同一份契约样本：
 * TS 与 Kotlin 分块器都必须对同一输入得到相同块数量与类型。
 * 修改规则时先更新本 fixture（由 TS 参考实现重新生成），再同步 Kotlin 与副本。
 */
import { describe, it, expect } from 'vitest'
import fixture from '../../../shared/fixtures/roleplay-blocks.json'
import { buildRoleplayBlocks, type RoleplayBlock } from '../roleplayBlocks'

interface FixtureCase { name: string; input: string; expected: RoleplayBlock[] }

const cases = (fixture as { cases: FixtureCase[] }).cases

describe('roleplay-blocks 共享 fixture（PC 侧）', () => {
  it('样本量满足跨端契约要求（≥30）', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s：TS 分块结果与 fixture 期望一致', (_name, c) => {
    expect(buildRoleplayBlocks(c.input)).toEqual(c.expected)
  })
})
