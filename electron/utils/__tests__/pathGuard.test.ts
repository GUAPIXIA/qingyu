/**
 * pathGuard SSRF 防护单元测试
 * 重点覆盖 IPv6 方括号绕过修复（[::1] / [fe80::1] / [fd00::1]）
 */
import { describe, expect, it } from 'vitest'
import { isSafeUrl, safeId, safePath, sanitizeApiKey } from '../pathGuard'

describe('isSafeUrl', () => {
  it('允许公网 http/https', () => {
    expect(isSafeUrl('https://example.com/image.png')).toBe(true)
    expect(isSafeUrl('http://example.com:8080/path')).toBe(true)
  })

  it('拒绝非 http/https 协议', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeUrl('ftp://example.com')).toBe(false)
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
  })

  it('拒绝 localhost / 回环 IPv4', () => {
    expect(isSafeUrl('http://localhost:3000')).toBe(false)
    expect(isSafeUrl('http://127.0.0.1')).toBe(false)
    expect(isSafeUrl('http://0.0.0.0')).toBe(false)
  })

  it('拒绝回环 IPv6（含方括号绕过修复）', () => {
    // 修复前：WHATWG URL 的 hostname 对 IPv6 保留方括号，=== '::1' 不匹配导致绕过
    expect(isSafeUrl('http://[::1]:8080/')).toBe(false)
    expect(isSafeUrl('http://[::1]/')).toBe(false)
  })

  it('拒绝 IPv6 链路本地/唯一本地/组播地址（含方括号）', () => {
    expect(isSafeUrl('http://[fe80::1]/')).toBe(false)
    expect(isSafeUrl('http://[fd00::1234]/')).toBe(false)
    expect(isSafeUrl('http://[fc00::1]/')).toBe(false)
    expect(isSafeUrl('http://[ff02::1]/')).toBe(false)
  })

  it('拒绝 IPv4-mapped IPv6 地址（SSRF 变体绕过）', () => {
    // 修复前：::ffff:127.0.0.1 等 IPv4 映射地址不匹配任何黑名单规则，可直达本机
    expect(isSafeUrl('http://[::ffff:127.0.0.1]/')).toBe(false)
    expect(isSafeUrl('http://[::ffff:169.254.169.254]/latest/meta-data')).toBe(false)
    expect(isSafeUrl('http://[::ffff:10.0.0.1]/')).toBe(false)
    expect(isSafeUrl('http://[::ffff:192.168.1.1]/')).toBe(false)
    // 映射到公网地址仍应放行
    expect(isSafeUrl('http://[::ffff:8.8.8.8]/')).toBe(true)
  })

  it('拒绝私有 IPv4 段', () => {
    expect(isSafeUrl('http://10.0.0.1')).toBe(false)
    expect(isSafeUrl('http://172.16.0.1')).toBe(false)
    expect(isSafeUrl('http://172.31.255.255')).toBe(false)
    expect(isSafeUrl('http://192.168.1.1')).toBe(false)
  })

  it('拒绝云元数据端点', () => {
    expect(isSafeUrl('http://169.254.169.254/latest/meta-data')).toBe(false)
  })

  it('非法 URL 返回 false 不抛错', () => {
    expect(isSafeUrl('not a url')).toBe(false)
    expect(isSafeUrl('')).toBe(false)
    expect(isSafeUrl('http://')).toBe(false)
  })
})

describe('safeId', () => {
  it('接受安全字符', () => {
    expect(safeId('abc-123_XYZ')).toBe('abc-123_XYZ')
  })

  it('拒绝路径穿越字符与超长', () => {
    expect(() => safeId('../etc')).toThrow()
    expect(() => safeId('a/b')).toThrow()
    expect(() => safeId('x'.repeat(300))).toThrow()
    expect(() => safeId('')).toThrow()
  })
})

describe('safePath', () => {
  it('拒绝路径穿越', () => {
    expect(() => safePath('/base', '..', 'secret')).toThrow()
    expect(() => safePath('/base', '/abs')).toThrow()
    expect(() => safePath('/base', '..\\win')).toThrow()
  })

  it('允许正常子路径', () => {
    expect(safePath('/base', 'a', 'b.json')).toContain('a')
  })
})

describe('sanitizeApiKey', () => {
  it('脱敏 sk- 开头的 API Key', () => {
    expect(sanitizeApiKey('error with sk-abcdefghijklmnopqrstuvwxyz123456 in message'))
      .toContain('sk-***')
  })

  it('脱敏 query 参数中的 key', () => {
    expect(sanitizeApiKey('https://x.com?a=1&key=secret12345&b=2')).toContain('key=***')
  })

  it('脱敏 Authorization Bearer', () => {
    expect(sanitizeApiKey('Authorization: Bearer abcdefghijk123456789')).toContain('Bearer ***')
  })

  it('脱敏 JSON 形式的 api_key', () => {
    expect(sanitizeApiKey('{"api_key": "sk-secretvalue1234567890"}')).toContain('***')
  })
})
