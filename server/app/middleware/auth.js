const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.error('[Auth] 致命错误: 未设置 JWT_SECRET 环境变量，服务拒绝启动')
  process.exit(1)
}
if (JWT_SECRET.length < 32) {
  console.error('[Auth] 致命错误: JWT_SECRET 长度不足（至少需要 32 个字符），服务拒绝启动')
  process.exit(1)
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供认证令牌' })
  }

  const token = authHeader.split(' ')[1]
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.admin = decoded
    next()
  } catch {
    return res.status(401).json({ error: '认证令牌无效或已过期' })
  }
}

module.exports = { authMiddleware, JWT_SECRET }
