const express = require('express')
const db = require('../db')
const { authMiddleware } = require('../middleware/auth')

const router = express.Router()

// 读取单个配置值
function getConfig(key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)
  return row ? row.value : null
}

// 写入配置值
function setConfig(key, value) {
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, value, now)
}

// 公开：获取最新版本信息
router.get('/', (_req, res) => {
  const version = getConfig('latest_version') || '0.0.0'
  const changelog = getConfig('changelog') || ''
  const downloadUrl = getConfig('download_url') || ''

  res.json({ version, changelog, downloadUrl })
})

// 管理员：更新版本配置
router.put('/', authMiddleware, (req, res) => {
  const { version, changelog, downloadUrl } = req.body

  if (version !== undefined) {
    setConfig('latest_version', String(version))
  }
  if (changelog !== undefined) {
    setConfig('changelog', String(changelog))
  }
  if (downloadUrl !== undefined) {
    setConfig('download_url', String(downloadUrl))
  }

  // 返回更新后的配置
  const updated = {
    version: getConfig('latest_version') || '0.0.0',
    changelog: getConfig('changelog') || '',
    downloadUrl: getConfig('download_url') || '',
  }
  res.json(updated)
})

module.exports = router
