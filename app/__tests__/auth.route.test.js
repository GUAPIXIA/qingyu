// @vitest-environment node
/**
 * 登录路由测试：失败响应中的 remaining 不允许为负
 * + CORS 来源解析（纯逻辑，无依赖，本地必跑）
 * express 缺失时路由集成测试自动跳过。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => next(),
  JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
}))

// server 依赖已纳入 pnpm workspace
const express = require('express')
let baseUrl = ''
let server = null

async function startServer() {
  const authRouter = require('../routes/auth')
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  server = app.listen(0)
  await new Promise((r) => server.on('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`
}

beforeAll(async () => {
  await startServer()
})

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r))
})

describe('登录失败响应', () => {
  it('用户不存在返回 401 且 remaining 不小于 0', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ghost', password: 'x' }),
    })
    expect(res.status).toBe(401)
    const data = await res.json()
    // LOGIN_MAX_ATTEMPTS=5，首次失败 remaining = 5 - 1 = 4
    expect(data.remaining).toBeGreaterThanOrEqual(0)
  })

  it('缺少用户名/密码返回 400', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'a' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('CORS 来源解析', () => {
  it('空/空白 ALLOWED_ORIGINS 回退默认来源（修复 [] || 默认值恒为 []）', () => {
    const { resolveAllowedOrigins } = require('../cors')
    expect(resolveAllowedOrigins('')).toEqual(['http://localhost:3000'])
    expect(resolveAllowedOrigins('  ')).toEqual(['http://localhost:3000'])
    expect(resolveAllowedOrigins(undefined)).toEqual(['http://localhost:3000'])
  })

  it('配置了来源时使用配置值并去除空白', () => {
    const { resolveAllowedOrigins } = require('../cors')
    expect(resolveAllowedOrigins(' https://a.com , http://b.com '))
      .toEqual(['https://a.com', 'http://b.com'])
  })
})
