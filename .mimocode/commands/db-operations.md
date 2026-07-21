---
description: 数据库操作助手。执行 MySQL 查询、导入导出数据、管理数据库结构。支持常见数据库管理和开发任务。
---

# 数据库操作助手

## 使用方式

```
/db-operations <操作描述>
```

支持的操作：查询、建表、导入、导出、备份、恢复等。

## 常见操作

### 1. 查询数据

```sql
-- 基础查询
SELECT * FROM table_name WHERE condition;

-- 分页查询
SELECT * FROM table_name LIMIT 10 OFFSET 0;

-- 聚合查询
SELECT COUNT(*), category FROM table_name GROUP BY category;

-- 联表查询
SELECT a.*, b.name 
FROM table_a a 
LEFT JOIN table_b b ON a.b_id = b.id;
```

### 2. 表结构管理

```sql
-- 查看表结构
DESCRIBE table_name;
SHOW CREATE TABLE table_name;

-- 创建表
CREATE TABLE table_name (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 修改表
ALTER TABLE table_name ADD COLUMN new_col VARCHAR(50);
ALTER TABLE table_name MODIFY COLUMN col_name VARCHAR(200);
ALTER TABLE table_name DROP COLUMN col_name;
```

### 3. 数据导入导出

**导出数据库:**
```bash
# 导出整个数据库
mysqldump -u root -p database_name > backup.sql

# 导出特定表
mysqldump -u root -p database_name table_name > table_backup.sql

# 导出数据 (仅数据)
mysqldump -u root -p --no-create-info database_name > data_only.sql
```

**导入数据库:**
```bash
# 导入 SQL 文件
mysql -u root -p database_name < backup.sql

# 在 MySQL 命令行中导入
mysql> source /path/to/backup.sql;
```

### 4. 用户和权限

```sql
-- 创建用户
CREATE USER 'username'@'localhost' IDENTIFIED BY 'password';

-- 授权
GRANT ALL PRIVILEGES ON database_name.* TO 'username'@'localhost';
GRANT SELECT, INSERT ON database_name.table_name TO 'username'@'localhost';

-- 刷新权限
FLUSH PRIVILEGES;

-- 查看权限
SHOW GRANTS FOR 'username'@'localhost';
```

### 5. 性能优化

```sql
-- 查看执行计划
EXPLAIN SELECT * FROM table_name WHERE condition;

-- 查看索引
SHOW INDEX FROM table_name;

-- 创建索引
CREATE INDEX idx_name ON table_name (column_name);
CREATE UNIQUE INDEX idx_unique ON table_name (column_name);

-- 分析表
ANALYZE TABLE table_name;
```

## 连接方式

### 命令行连接
```bash
# 本地连接
mysql -u root -p

# 指定主机和端口
mysql -h localhost -P 3306 -u root -p

# 指定数据库
mysql -u root -p database_name
```

### 常用 MySQL 命令
```sql
-- 查看数据库
SHOW DATABASES;

-- 切换数据库
USE database_name;

-- 查看表
SHOW TABLES;

-- 查看状态
SHOW STATUS;

-- 查看进程
SHOW PROCESSLIST;
```

## 问题排查

### 连接失败
```
ERROR 2003 (HY000): Can't connect to MySQL server
→ 检查 MySQL 服务是否启动
→ 检查端口是否正确 (默认 3306)
→ 检查防火墙设置
→ 检查用户权限
```

### 权限不足
```
ERROR 1045 (28000): Access denied
→ 检查用户名和密码
→ 检查用户权限: SHOW GRANTS;
→ 检查 host 配置
```

### 表不存在
```
ERROR 1146 (42S02): Table doesn't exist
→ 检查表名拼写
→ 检查当前数据库: SELECT DATABASE();
→ 检查表是否被删除
```

## 最佳实践

1. **备份优先** - 执行删除/修改操作前先备份
2. **使用事务** - 复杂操作使用 `START TRANSACTION` 和 `COMMIT`
3. **索引优化** - 为常用查询字段创建索引
4. **参数化查询** - 防止 SQL 注入
5. **定期维护** - 定期优化表和更新统计信息
