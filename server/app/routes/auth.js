const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const db = require('../db')
const { JWT_SECRET } = require('../middleware/auth')

const router = express.Router()

// 管理员登录
router.post('/login', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' })
  }

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username)
  if (!admin) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const valid = bcrypt.compareSync(password, admin.password_hash)
  if (!valid) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    JWT_SECRET,
    { expiresIn: '24h' }
  )

  res.json({ token, username: admin.username })
})

module.exports = router
