// @vitest-environment node
/**
 * 版本路由测试：semver 格式校验
 * mock authMiddleware 绕过认证；express 缺失时套件自动跳过。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'

// mock 认证中间件：直接放行（相对路径模块，无需 alias）
vi.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => next(),
  JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
}))

let expressAvailable = false
let express = null
let baseUrl = ''
let server = null

try {
  express = require('express')
  expressAvailable = true
} catch { /* 本地未安装 server 依赖 */ }

async function startServer() {
  const versionRouter = require('../routes/version')
  const app = express()
  app.use(express.json())
  app.use('/api/version', versionRouter)
  server = app.listen(0)
  await new Promise((r) => server.on('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}/api/version`
}

beforeAll(async () => {
  if (expressAvailable) await startServer()
})

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r))
})

describe.skipIf(!expressAvailable)('版本更新 semver 校验', () => {
  it('合法版本号（x.y.z）接受', async () => {
    const res = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.2.3' }),
    })
    expect(res.status).toBe(200)
  })

  it('带预发布后缀的版本号接受（1.2.3-beta.1）', async () => {
    const res = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.2.3-beta.1' }),
    })
    expect(res.status).toBe(200)
  })

  it('非法版本号返回 400', async () => {
    for (const bad of ['abc', '1.2', '1.2.3.4', 'v1.2.3', '1.x.3', '']) {
      const res = await fetch(baseUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: bad }),
      })
      expect(res.status, `version=${bad}`).toBe(400)
    }
  })
})

describe.skipIf(!expressAvailable)('公开版本信息', () => {
  it('GET 返回版本配置', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.version).toBe('1.0.0')
  })
})
