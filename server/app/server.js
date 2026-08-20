const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const path = require('path')

require('dotenv').config()

const announcementsRouter = require('./routes/announcements')
const authRouter = require('./routes/auth')
const versionRouter = require('./routes/version')
const { resolveAllowedOrigins } = require('./cors')

const app = express()
const PORT = process.env.PORT || 3000

// N9 修复：登录限流依赖 req.ip。部署在反代(Nginx/Traefik 等)之后时，
// 必须设置 TRUST_PROXY 让 Express 信任 X-Forwarded-For，否则所有客户端
// 共享反代 IP 的限流桶(5 次失败即全站锁定 15 分钟)。
// 默认不开启（保持"直连部署"行为，避免伪造 X-Forwarded-For 绕过限流）。
if (process.env.TRUST_PROXY) {
  const hops = Number.parseInt(process.env.TRUST_PROXY, 10)
  app.set('trust proxy', Number.isFinite(hops) && hops >= 1 ? hops : true)
}

// 安全中间件（关闭 CSP，管理后台依赖内联脚本）
app.use(helmet({ contentSecurityPolicy: false }))
// 修复：空数组是 truthy，[] || 默认值恒为 [] 导致跨域全拒；按长度判断（逻辑见 cors.js）
app.use(cors({
  origin: resolveAllowedOrigins(process.env.ALLOWED_ORIGINS),
  credentials: true,
}))
app.use(express.json({ limit: '1mb' }))

// API 路由
app.use('/api/announcements', announcementsRouter)
app.use('/api/auth', authRouter)
app.use('/api/version', versionRouter)

// 管理后台（/admin 路径）— 禁用缓存，避免浏览器 304 复用旧 CSP 头
// 顺序注意：/admin（无斜杠）必须排在 express.static 之前，否则静态目录会先发
// 301 重定向到绝对路径 /admin/，破坏 /qingyu 前缀挂载（nginx 转发场景跳丢前缀）。
app.get('/admin', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.sendFile(path.join(__dirname, 'admin', 'index.html'))
})
app.use('/admin', express.static(path.join(__dirname, 'admin'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.set('Pragma', 'no-cache')
  }
}))

const server = app.listen(PORT, () => {
  console.log(`[Server] 公告服务已启动: http://localhost:${PORT}`)
})

// 404 与全局错误处理（修复：此前无兜底，路由未命中返回默认 HTML，异常错误无 JSON 响应）
app.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' })
})
app.use((err, _req, res, _next) => {
  console.error('[Server] 未捕获错误:', err)
  // N17 修复：按错误状态码分级响应（如 body-parser 坏 JSON 会置 err.status=400）
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500
  if (status === 500) {
    res.status(500).json({ error: '服务器内部错误' })
  } else {
    res.status(status).json({ error: err.message || '请求错误' })
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] 端口 ${PORT} 已被占用，服务启动失败`)
  } else {
    console.error('[Server] 启动错误:', err)
  }
  process.exit(1)
})
