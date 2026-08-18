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

// 公开：获取最新版本信息（PC 端 + 安卓端）
router.get('/', (_req, res) => {
  const version = getConfig('latest_version') || '0.0.0'
  const changelog = getConfig('changelog') || ''
  const downloadUrl = getConfig('download_url') || ''
  // 安卓端版本（伴侣端独立版本体系，管理后台可单独配置）
  const androidVersion = getConfig('android_latest_version')
  const androidChangelog = getConfig('android_changelog') || ''
  const androidDownloadUrl = getConfig('android_download_url') || ''

  res.json({ version, changelog, downloadUrl, androidVersion, androidChangelog, androidDownloadUrl })
})

// 管理员：更新版本配置（PC 端 + 安卓端）
router.put('/', authMiddleware, (req, res) => {
  const { version, changelog, downloadUrl, androidVersion, androidChangelog, androidDownloadUrl } = req.body || {}

  // M-36 修复：先校验全部字段，全部通过后才写入（原子更新）——
  // 此前逐字段『先写后校验下一个』，{version:合法, changelog:超长} 时 version 已落库才 400，配置不一致。
  const updates = new Map() // key -> value

  if (version !== undefined) {
    // semver 格式校验（x.y.z，可选 -预发布 后缀）
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())) {
      return res.status(400).json({ error: '版本号格式无效，应为 x.y.z（如 1.2.3）' })
    }
    updates.set('latest_version', version.trim())
  }
  if (changelog !== undefined) {
    // N8 修复：长度限制 + 字符串类型（此前仅 String() 强转，可存近 1MB 任意文本）
    if (typeof changelog !== 'string' || changelog.length > 50000) {
      return res.status(400).json({ error: 'changelog 必须为字符串且不超过 50000 字符' })
    }
    updates.set('changelog', changelog)
  }
  if (downloadUrl !== undefined) {
    // N8 修复：协议白名单 + 长度限制（此前可注入任意域名做钓鱼/恶意下载引导）
    if (typeof downloadUrl !== 'string' || downloadUrl.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(downloadUrl)) {
      return res.status(400).json({ error: 'downloadUrl 必须是 http/https 链接且不超过 2048 字符' })
    }
    updates.set('download_url', downloadUrl)
  }

  // ---- 安卓端（伴侣端）版本配置，与 PC 端字段同规则 ----
  if (androidVersion !== undefined) {
    if (typeof androidVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(androidVersion.trim())) {
      return res.status(400).json({ error: 'androidVersion 格式无效，应为 x.y.z（如 0.1.2）' })
    }
    updates.set('android_latest_version', androidVersion.trim())
  }
  if (androidChangelog !== undefined) {
    if (typeof androidChangelog !== 'string' || androidChangelog.length > 50000) {
      return res.status(400).json({ error: 'androidChangelog 必须为字符串且不超过 50000 字符' })
    }
    updates.set('android_changelog', androidChangelog)
  }
  if (androidDownloadUrl !== undefined) {
    if (typeof androidDownloadUrl !== 'string' || androidDownloadUrl.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(androidDownloadUrl)) {
      return res.status(400).json({ error: 'androidDownloadUrl 必须是 http/https 链接且不超过 2048 字符' })
    }
    updates.set('android_download_url', androidDownloadUrl)
  }

  // 全部校验通过，一次性写入（原子更新）
  for (const [key, value] of updates) {
    setConfig(key, value)
  }

  // 返回更新后的配置
  const updated = {
    version: getConfig('latest_version') || '0.0.0',
    changelog: getConfig('changelog') || '',
    downloadUrl: getConfig('download_url') || '',
    androidVersion: getConfig('android_latest_version'),
    androidChangelog: getConfig('android_changelog') || '',
    androidDownloadUrl: getConfig('android_download_url') || '',
  }
  res.json(updated)
})

module.exports = router
