const express = require('express')
const db = require('../db')
const { authMiddleware } = require('../middleware/auth')

const router = express.Router()

// 获取公告列表（公开）
router.get('/', (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = parseInt(req.query.pageSize) || 20
  const offset = (page - 1) * pageSize

  const countRow = db.prepare('SELECT COUNT(*) as total FROM announcements WHERE published = 1').get()
  const items = db.prepare(`
    SELECT id, title, summary, content, pinned, published, created_at as createdAt, updated_at as updatedAt
    FROM announcements
    WHERE published = 1
    ORDER BY pinned DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset)

  res.json({ items, total: countRow.total, page, pageSize })
})

// 获取单条公告详情（公开）
router.get('/:id', (req, res) => {
  const item = db.prepare(`
    SELECT id, title, summary, content, pinned, published, created_at as createdAt, updated_at as updatedAt
    FROM announcements
    WHERE id = ? AND published = 1
  `).get(req.params.id)

  if (!item) {
    return res.status(404).json({ error: '公告不存在' })
  }
  res.json(item)
})

// 创建公告（需认证）
router.post('/', authMiddleware, (req, res) => {
  const { title, content, summary, pinned, published } = req.body
  if (!title || !content) {
    return res.status(400).json({ error: '标题和内容不能为空' })
  }

  const now = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO announcements (title, content, summary, pinned, published, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    content,
    summary || '',
    pinned ? 1 : 0,
    published !== false ? 1 : 0,
    now,
    now
  )

  const item = db.prepare('SELECT id, title, summary, content, pinned, published, created_at as createdAt, updated_at as updatedAt FROM announcements WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(item)
})

// 更新公告（需认证）
router.put('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT id FROM announcements WHERE id = ?').get(req.params.id)
  if (!existing) {
    return res.status(404).json({ error: '公告不存在' })
  }

  const { title, content, summary, pinned, published } = req.body
  const now = new Date().toISOString()

  db.prepare(`
    UPDATE announcements
    SET title = COALESCE(?, title),
        content = COALESCE(?, content),
        summary = COALESCE(?, summary),
        pinned = COALESCE(?, pinned),
        published = COALESCE(?, published),
        updated_at = ?
    WHERE id = ?
  `).run(
    title ?? null,
    content ?? null,
    summary ?? null,
    pinned !== undefined ? (pinned ? 1 : 0) : null,
    published !== undefined ? (published ? 1 : 0) : null,
    now,
    req.params.id
  )

  const item = db.prepare('SELECT id, title, summary, content, pinned, published, created_at as createdAt, updated_at as updatedAt FROM announcements WHERE id = ?').get(req.params.id)
  res.json(item)
})

// 删除公告（需认证）
router.delete('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT id FROM announcements WHERE id = ?').get(req.params.id)
  if (!existing) {
    return res.status(404).json({ error: '公告不存在' })
  }

  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

module.exports = router
