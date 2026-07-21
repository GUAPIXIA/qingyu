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
  `)

  // 首次启动自动创建默认管理员
  const adminExists = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin')
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10)
    db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)').run(
      'admin',
      hash,
      new Date().toISOString()
    )
    console.log('[DB] 已创建默认管理员账号: admin / admin123')
  }
}

initDatabase()
console.log('[DB] 数据库初始化完成:', DB_PATH)

module.exports = db
