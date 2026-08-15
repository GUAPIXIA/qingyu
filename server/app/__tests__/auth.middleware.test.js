// @vitest-environment node
/**
 * Server 认证中间件测试：JWT 算法锁定、未授权响应
 * jsonwebtoken 由测试 stub（server/app/node_modules）提供，测试通过 vi.spyOn 控制 verify 行为。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

// 避免 JWT_SECRET 缺失导致 process.exit
vi.hoisted(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32) })

import jwt from 'jsonwebtoken'
import { authMiddleware } from '../middleware/auth'

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(data) { this.body = data; return this },
  }
}

function mockNext() {
  return vi.fn()
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('authMiddleware', () => {
  it('缺少 Authorization 头返回 401', () => {
    const res = mockRes()
    authMiddleware({ headers: {} }, res, mockNext())
    expect(res.statusCode).toBe(401)
  })

  it('非 Bearer 前缀返回 401', () => {
    const res = mockRes()
    authMiddleware({ headers: { authorization: 'Basic xxx' } }, res, mockNext())
    expect(res.statusCode).toBe(401)
  })

  it('verify 锁定 HS256 算法（防算法混淆攻击）', () => {
    const verifySpy = vi.spyOn(jwt, 'verify').mockReturnValue({ id: 1, username: 'admin' })
    const next = mockNext()
    authMiddleware({ headers: { authorization: 'Bearer token-abc' } }, mockRes(), next)
    // 关键断言：必须显式指定 algorithms: ['HS256']，并绑定 issuer/audience（N20）
    expect(verifySpy).toHaveBeenCalledWith('token-abc', process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'qingyu-server',
      audience: 'qingyu-admin',
    })
    expect(next).toHaveBeenCalled()
  })

  it('verify 抛错（无效/过期 token）返回 401', () => {
    vi.spyOn(jwt, 'verify').mockImplementation(() => { throw new Error('jwt expired') })
    const res = mockRes()
    const next = mockNext()
    authMiddleware({ headers: { authorization: 'Bearer bad-token' } }, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})
