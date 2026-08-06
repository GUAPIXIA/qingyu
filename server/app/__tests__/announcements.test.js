// @vitest-environment node
/**
 * 公告路由测试：分页参数限制、字段长度限制、404 兜底
 * better-sqlite3 由测试 stub（server/app/node_modules）提供；express 仅在 Docker/CI 环境安装，
 * 本地缺失时整个套件自动跳过（skipIf）。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'

vi.hoisted(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32) })

import jwt from 'jsonwebtoken'

// N20 兼容：middleware 校验 issuer/audience（qingyu-server/qingyu-admin）
const authToken = jwt.sign({ id: 1, username: 'admin' }, process.env.JWT_SECRET, { issuer: 'qingyu-server', audience: 'qingyu-admin' })

// server 依赖已纳入 pnpm workspace（express 由 server/app/package.json 声明）
const express = require('express')
let baseUrl = ''
let server = null

async function startServer() {
  const announcementsRouter = require('../routes/announcements')
  const app = express()
  app.use(express.json())
  app.use('/api/announcements', announcementsRouter)
  // 404 兜底（与 server.js 行为一致）
  app.use((_req, res) => res.status(404).json({ error: '接口不存在' }))
  server = app.listen(0)
  await new Promise((r) => server.on('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}/api/announcements`
}

beforeAll(async () => {
  await startServer()
})

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r))
})

describe('公告分页参数', () => {
  it('pageSize 超限时被限制到 100', async () => {
    const res = await fetch(`${baseUrl}?pageSize=999999`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.pageSize).toBe(100)
  })

  it('pageSize 非法（非数字）时回退默认 20', async () => {
    const res = await fetch(`${baseUrl}?pageSize=abc`)
    const data = await res.json()
    expect(data.pageSize).toBe(20)
  })

  it('page 小于 1 时回退为 1', async () => {
    const res = await fetch(`${baseUrl}?page=-5`)
    const data = await res.json()
    expect(data.page).toBe(1)
  })
})

describe('公告创建校验', () => {
  it('缺少标题或内容返回 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ content: '只有内容' }),
    })
    expect(res.status).toBe(400)
  })

  it('标题超长（>200 字符）返回 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ title: 'x'.repeat(201), content: '内容' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('404 兜底', () => {
  it('未知路径返回 JSON 404', async () => {
    // 双层路径不匹配 GET /:id 单段路由，落入 404 中间件
    const res = await fetch(`${baseUrl}/no-such/x/y`)
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('接口不存在')
  })
})
