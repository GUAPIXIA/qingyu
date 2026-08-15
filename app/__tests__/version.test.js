// @vitest-environment node
/**
 * 版本路由测试：semver 格式校验
 * mock authMiddleware 绕过认证；express 缺失时套件自动跳过。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'

vi.hoisted(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32) })

import jwt from 'jsonwebtoken'

// N20 兼容：middleware 校验 issuer/audience（qingyu-server/qingyu-admin）
// 注：测试内 CJS require() 链不走 vite 模块图，vi.mock 对路由无效，需真实签发 token
const authToken = jwt.sign({ id: 1, username: 'admin' }, process.env.JWT_SECRET, { issuer: 'qingyu-server', audience: 'qingyu-admin' })

// server 依赖已纳入 pnpm workspace
const express = require('express')
let baseUrl = ''
let server = null

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
  await startServer()
})

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r))
})

describe('版本更新 semver 校验', () => {
  it('合法版本号（x.y.z）接受', async () => {
    const res = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ version: '1.2.3' }),
    })
    expect(res.status).toBe(200)
  })

  it('带预发布后缀的版本号接受（1.2.3-beta.1）', async () => {
    const res = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ version: '1.2.3-beta.1' }),
    })
    expect(res.status).toBe(200)
  })

  it('非法版本号返回 400', async () => {
    for (const bad of ['abc', '1.2', '1.2.3.4', 'v1.2.3', '1.x.3', '']) {
      const res = await fetch(baseUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ version: bad }),
      })
      expect(res.status, `version=${bad}`).toBe(400)
    }
  })
})

describe('公开版本信息', () => {
  it('GET 返回版本配置', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(200)
    const data = await res.json()
    // 与同文件内 PUT 写入共享内存库，断言结构而非固定值
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(typeof data.changelog).toBe('string')
    expect(typeof data.downloadUrl).toBe('string')
  })
})
