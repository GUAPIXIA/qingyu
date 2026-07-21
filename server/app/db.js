const Database = require('better-sqlite3')
const path = require('path')
const bcrypt = require('bcryptjs')

const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = path.join(DATA_DIR, 'tavern.db')

const fs = require('fs')
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const db = new Database(DB_PATH)

// 启用 WAL 模式提升并发性能
db.pragma('journal_mode = WAL')

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT DEFAULT '',
      pinned INTEGER DEFAULT 0,
      published INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  // P-9 修复：添加复合索引加速公告列表查询
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ann_pub_pin_created
    ON announcements(published, pinned DESC, created_at DESC);
  `)

  // 初始化默认版本配置
  const now = new Date().toISOString()
  const defaults = {
    latest_version: '0.8.4',
    changelog: '',
    download_url: 'https://github.com/GUAPIXIA/qingyu/releases',
  }
  const insertConfig = db.prepare(
    'INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)'
  )
  for (const [key, value] of Object.entries(defaults)) {
    insertConfig.run(key, value, now)
  }

  // 首次启动自动创建管理员（凭据从环境变量读取）
  const adminExists = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin')
  if (!adminExists) {
    const adminPassword = process.env.ADMIN_PASSWORD
    if (!adminPassword) {
      console.error('[DB] 致命错误: 未设置 ADMIN_PASSWORD 环境变量，服务拒绝启动')
      process.exit(1)
    }
    if (adminPassword.length < 8) {
      console.error('[DB] 致命错误: ADMIN_PASSWORD 长度不足（至少需要 8 个字符），服务拒绝启动')
      process.exit(1)
    }
    const hash = bcrypt.hashSync(adminPassword, 10)
    db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)').run(
      'admin',
      hash,
      new Date().toISOString()
    )
    console.log('[DB] 已创建默认管理员账号 admin')
  }
}

initDatabase()
console.log('[DB] 数据库初始化完成:', DB_PATH)

module.exports = db
