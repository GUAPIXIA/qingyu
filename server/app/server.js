const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const path = require('path')

const announcementsRouter = require('./routes/announcements')
const authRouter = require('./routes/auth')
const versionRouter = require('./routes/version')

const app = express()
const PORT = process.env.PORT || 3000

// 安全中间件（关闭 CSP，管理后台依赖内联脚本）
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}))
app.use(express.json({ limit: '1mb' }))

// API 路由
app.use('/api/announcements', announcementsRouter)
app.use('/api/auth', authRouter)
app.use('/api/version', versionRouter)

// 管理后台（/admin 路径）— 禁用缓存，避免浏览器 304 复用旧 CSP 头
app.use('/admin', express.static(path.join(__dirname, 'admin'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.set('Pragma', 'no-cache')
  }
}))
app.get('/admin', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.sendFile(path.join(__dirname, 'admin', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`[Server] 公告服务已启动: http://localhost:${PORT}`)
})
