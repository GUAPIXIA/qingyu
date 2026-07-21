const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'tavern-announce-secret-key-2024'

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
