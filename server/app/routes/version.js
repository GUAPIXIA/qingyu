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
    // semver 格式校验（x.y.z，可选 -预发布 后缀）
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())) {
      return res.status(400).json({ error: '版本号格式无效，应为 x.y.z（如 1.2.3）' })
    }
    setConfig('latest_version', version.trim())
  }
  if (changelog !== undefined) {
    // N8 修复：长度限制 + 字符串类型（此前仅 String() 强转，可存近 1MB 任意文本）
    if (typeof changelog !== 'string' || changelog.length > 50000) {
      return res.status(400).json({ error: 'changelog 必须为字符串且不超过 50000 字符' })
    }
    setConfig('changelog', changelog)
  }
  if (downloadUrl !== undefined) {
    // N8 修复：协议白名单 + 长度限制（此前可注入任意域名做钓鱼/恶意下载引导）
    if (typeof downloadUrl !== 'string' || downloadUrl.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(downloadUrl)) {
      return res.status(400).json({ error: 'downloadUrl 必须是 http/https 链接且不超过 2048 字符' })
    }
    setConfig('download_url', downloadUrl)
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
