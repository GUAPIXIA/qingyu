/**
 * 在线更新服务纯逻辑测试：
 * - semverGt 版本比较（主干数值 / 预发布后缀规则）
 * - 镜像源配置读写与协议白名单校验
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DIR = mkdtempSync(join(tmpdir(), 'qingyu-updater-test-'))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => TEST_DIR },
}))

// 延迟导入：需在 vi.mock 之后
const { semverGt, setMirrorConfig, getMirrorConfig } = await import('../updater')

afterEach(() => {
  // 恢复默认配置
  setMirrorConfig({ mirrorUrl: '' })
})

describe('semverGt', () => {
  it('主干版本按数值逐段比较', () => {
    expect(semverGt('0.14.0', '0.13.9')).toBe(true)
    expect(semverGt('1.0.0', '0.99.99')).toBe(true)
    expect(semverGt('0.14.0', '0.14.0')).toBe(false)
    expect(semverGt('0.9.10', '0.10.0')).toBe(false)
  })

  it('预发布后缀低于正式版', () => {
    expect(semverGt('0.14.0-beta.1', '0.14.0')).toBe(false)
    expect(semverGt('0.14.0', '0.14.0-rc.1')).toBe(true)
  })

  it('预发布之间按字符串比较', () => {
    expect(semverGt('0.14.0-beta.2', '0.14.0-beta.1')).toBe(true)
  })
})

describe('mirror config', () => {
  it('默认镜像为空（仅走 GitHub）', () => {
    expect(getMirrorConfig().mirrorUrl).toBe('')
  })

  it('合法 http/https 地址可保存并读回', () => {
    setMirrorConfig({ mirrorUrl: 'https://example.com/qingyu/update/' })
    expect(getMirrorConfig().mirrorUrl).toBe('https://example.com/qingyu/update/')
  })

  it('拒绝非 http/https 协议（防 file:/ftp: 等注入）', () => {
    for (const bad of ['file:///C:/evil', 'ftp://x.com', 'javascript:alert(1)', 'not-a-url']) {
      expect(() => setMirrorConfig({ mirrorUrl: bad })).toThrow(/http\/https/)
    }
    // 配置未被污染
    expect(getMirrorConfig().mirrorUrl).toBe('')
  })

  it('空白串等价于未启用', () => {
    setMirrorConfig({ mirrorUrl: '   ' })
    expect(getMirrorConfig().mirrorUrl).toBe('')
  })
})
