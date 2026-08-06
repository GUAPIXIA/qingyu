/**
 * 公告 httpGet 安全加固单元测试
 * N3 修复：重定向目标重新 SSRF 校验、重定向次数上限、响应体大小上限。
 * 通过本地 HTTP server 模拟，isSafeUrl 由 mock 控制以便覆盖各分支。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// mock isSafeUrl：默认放行，测试按需改变行为
vi.mock('../../utils/pathGuard', () => ({
  isSafeUrl: vi.fn(() => true),
}))

import { httpGet } from '../announcement'
import { isSafeUrl } from '../../utils/pathGuard'

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

afterEach(() => {
  vi.mocked(isSafeUrl).mockReset()
  vi.mocked(isSafeUrl).mockReturnValue(true)
})

describe('httpGet', () => {
  it('正常 200 返回响应体', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    try {
      await expect(httpGet(`http://127.0.0.1:${s.port}/api`)).resolves.toBe('{"ok":true}')
    } finally {
      await s.close()
    }
  })

  it('入口 URL 不安全时直接拒绝', async () => {
    vi.mocked(isSafeUrl).mockReturnValue(false)
    await expect(httpGet('http://127.0.0.1:9999/')).rejects.toThrow('URL 不安全')
  })

  it('重定向目标不安全时拒绝（SSRF 校验）', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' })
      res.end()
    })
    try {
      // 初始 URL 放行，重定向目标被 isSafeUrl 拒绝
      vi.mocked(isSafeUrl).mockImplementation((url: string) => !url.includes('169.254.169.254'))
      await expect(httpGet(`http://127.0.0.1:${s.port}/`)).rejects.toThrow('重定向目标不安全')
    } finally {
      await s.close()
    }
  })

  it('重定向次数超过上限时拒绝', async () => {
    let count = 0
    const s = await startServer((_req, res) => {
      count += 1
      if (count <= 6) {
        res.writeHead(302, { Location: `http://127.0.0.1:${(s as unknown as { port: number }).port}/next` })
        res.end()
      } else {
        res.writeHead(200)
        res.end('done')
      }
    })
    try {
      await expect(httpGet(`http://127.0.0.1:${s.port}/`)).rejects.toThrow('重定向次数过多')
    } finally {
      await s.close()
    }
  })

  it('响应体超过 5MB 上限时拒绝', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200)
      res.write('x'.repeat(1024 * 1024)) // 1MB
      setTimeout(() => res.end('y'.repeat(5 * 1024 * 1024)), 20) // 再写 5MB
    })
    try {
      await expect(httpGet(`http://127.0.0.1:${s.port}/`)).rejects.toThrow('响应体过大')
    } finally {
      await s.close()
    }
  })

  it('跟随合法重定向并返回最终响应', async () => {
    const s = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: `http://127.0.0.1:${(s as unknown as { port: number }).port}/final` })
        res.end()
      } else {
        res.writeHead(200)
        res.end('final-body')
      }
    })
    try {
      await expect(httpGet(`http://127.0.0.1:${s.port}/start`)).resolves.toBe('final-body')
    } finally {
      await s.close()
    }
  })
})
