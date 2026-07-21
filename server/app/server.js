const express = require('express')
const cors = require('cors')
const path = require('path')

const announcementsRouter = require('./routes/announcements')
const authRouter = require('./routes/auth')

const app = express()
const PORT = process.env.PORT || 3000

// 中间件
app.use(cors())
app.use(express.json())

// API 路由
app.use('/api/announcements', announcementsRouter)
app.use('/api/auth', authRouter)

// 管理后台（/admin 路径）
app.use('/admin', express.static(path.join(__dirname, 'admin')))
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`[Server] 公告服务已启动: http://localhost:${PORT}`)
})
