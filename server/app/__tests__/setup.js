/**
 * server 测试环境准备（server 路由测试落地）
 * 1. 内存数据库:避免测试写入真实 server/app/data/tavern.db
 * 2. 强密码 + JWT_SECRET:避免 db.js 首次启动(admins 表为空)时 process.exit
 * 3. 注意:本文件须在测试文件 import server 模块前执行(vitest setupFiles 保证)
 */
process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TestStrongPass123!'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
