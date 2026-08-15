const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const db = require('../db')
const { JWT_SECRET } = require('../middleware/auth')

const router = express.Router()

// 简单的内存限流：每个 IP 每分钟最多 5 次登录尝试
const loginRateLimit = new Map()
const LOGIN_WINDOW_MS = 60 * 1000
const LOGIN_MAX_ATTEMPTS = 5
const LOCKOUT_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000

const ipLocks = new Map()

function getRateLimitInfo(ip) {
  const now = Date.now()
  // 清理过期记录
  for (const [k, v] of loginRateLimit) {
    if (now - v.windowStart > LOGIN_WINDOW_MS) loginRateLimit.delete(k)
  }
  for (const [k, v] of ipLocks) {
    if (now > v.until) ipLocks.delete(k)
  }

  const lock = ipLocks.get(ip)
  if (lock) return { blocked: true, remainingSeconds: Math.ceil((lock.until - now) / 1000) }

  const entry = loginRateLimit.get(ip)
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    return { blocked: false, remaining: LOGIN_MAX_ATTEMPTS }
  }
  return { blocked: false, remaining: Math.max(0, LOGIN_MAX_ATTEMPTS - entry.count) }
}

function recordAttempt(ip) {
  const now = Date.now()
  const entry = loginRateLimit.get(ip)
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginRateLimit.set(ip, { windowStart: now, count: 1 })
    return
  }
  entry.count++
  if (entry.count >= LOCKOUT_ATTEMPTS) {
    ipLocks.set(ip, { until: now + LOCKOUT_DURATION_MS })
    loginRateLimit.delete(ip)
  }
}

// 管理员登录
router.post('/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const rateInfo = getRateLimitInfo(ip)

  if (rateInfo.blocked) {
    return res.status(429).json({ error: `登录尝试次数过多，请等待 ${rateInfo.remainingSeconds} 秒后再试` })
  }

  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' })
  }
  // N20 修复：登录参数长度限制，避免超长输入造成 bcrypt 无谓开销
  if (typeof username !== 'string' || username.length > 64) {
    return res.status(400).json({ error: '用户名长度不能超过 64 字符' })
  }
  if (typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: '密码长度不能超过 128 字符' })
  }

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username)
  if (!admin) {
    recordAttempt(ip)
    return res.status(401).json({ error: '用户名或密码错误', remaining: Math.max(0, rateInfo.remaining - 1) })
  }

  try {
    const valid = await bcrypt.compare(password, admin.password_hash)
    if (!valid) {
      recordAttempt(ip)
      return res.status(401).json({ error: '用户名或密码错误', remaining: Math.max(0, rateInfo.remaining - 1) })
    }
  } catch {
    return res.status(500).json({ error: '服务器内部错误' })
  }

  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    JWT_SECRET,
    // N20 修复：绑定 issuer/audience，防止跨服务复用同一 JWT_SECRET 时凭据范围过大
    { expiresIn: '24h', issuer: 'qingyu-server', audience: 'qingyu-admin' }
  )

  res.json({ token, username: admin.username })
})

module.exports = router
