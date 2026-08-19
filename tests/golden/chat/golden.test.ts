import { describe, it, expect } from 'vitest'
import { listFixtures, loadFixture, validateFixture } from './goldenRunner'

describe('V12-01 Golden Fixtures 骨架', () => {
  it('fixtures 可加载且契约完整', () => {
    const files = listFixtures()
    expect(files.length).toBeGreaterThanOrEqual(3)
    for (const file of files) {
      const fixture = loadFixture(file)
      const errors = validateFixture(fixture)
      expect(errors, `${file}: ${errors.join(', ')}`).toEqual([])
    }
  })

  it('input/output/stop 三组预期与 0.11.28 旧引擎一致（快照锚点）', async () => {
    const files = listFixtures()
    const byId = new Map(files.map((p) => [loadFixture(p).id, loadFixture(p)]))
    expect(byId.get('input-regex-01')?.expected.userMessage.content).toBe('你好 世界')
    expect(byId.get('output-regex-01')?.expected.assistantMessage.content).toBe('你好呀')
    expect(byId.get('stop-strings-01')?.expected.assistantMessage.content).toBe('前半')
  })
})
