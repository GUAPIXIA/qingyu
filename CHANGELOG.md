# 更新日志

## [1.0.2] - 2026-08-15

### 多端版本管理（安卓端可独立配置最新版本）

- `/api/version` 新增安卓端字段：`androidVersion` / `androidChangelog` / `androidDownloadUrl`（与 PC 端同规则校验：semver / 长度 / http(s) 白名单）
- 管理后台「版本管理」面板拆分为 PC 端 + 安卓端两组，安卓端版本号/APK 下载地址/更新日志可直接在页面配置
- `app_config` 默认值补充 android 字段（`INSERT OR IGNORE`，存量库自动补齐）
- 测试新增 4 例（安卓字段写入/读取/非法版本/非法 URL），全量 32 通过

---

## [1.0.1] - 2026-08-15

### 部署修复：Docker 构建兼容（Node 22）

- **Dockerfile 镜像升级 node:18-slim → node:22-slim**：better-sqlite3@12.11.1 要求 Node 20+，18 下无预构建且镜像无编译链（缺 Python）导致 `docker compose build` 失败；22 为当前 LTS，预构建齐备
- **Dockerfile 增加 `.npmrc` COPY**：构建时使用 npmmirror registry 与 better-sqlite3 预构建镜像源（国内服务器构建不再依赖 GitHub 下载）
- **部署上线 47.92.7.207**（cjbtj.xyz）：代码含 0.11.14~0.11.18 全部安全加固（SSRF 防护 / sanitize 消毒 / CORS 空数组修复 / 404 与错误分级 JSON / TRUST_PROXY）；数据保留（公告/管理员），管理后台登录不受影响；部署前备份 `data.bak-20260815-141210`

---

## [1.0.0] - 2026-08-15

### 初始版本：轻语公告服务端（tavern-announce）

从主仓库（酒馆）移出独立管理，Express 公告/版本服务端，支持 Docker 部署。功能沉淀自 0.11.14~0.11.18 各版本的安全加固与测试工作。

### 公告服务（`/api/announcements`）

- **公开接口**：分页列表（`page` / `pageSize`，上限 100000 防 SQLite int64 溢出）、单条详情；仅返回 `published = 1` 的公告，置顶优先 + 创建时间倒序
- **公开列表不含 content 全文**：详情按需获取，客户端离线降级提示
- **管理接口**（需 JWT）：CRUD 全量（含草稿管理），标题限长 200 / 内容限长 100000，`PUT null` 视为未提供（`COALESCE` 保留原值）

### 认证与安全

- **登录**（`POST /api/auth/login`）：bcryptjs 密码哈希校验 + JWT 签发（绑定 `issuer` / `audience`），登录限流（5 次失败锁定 15 分钟，`TRUST_PROXY` 反代场景正确取客户端 IP）
- **强密码门禁**：管理员创建时拒绝 14 种常见弱密码（含示例占位符），命中即拒绝启动；`ADMIN_PASSWORD` 缺失或 <8 位同样拒绝启动
- **HTML 消毒**（`sanitize.js`）：白名单标签 + 黑名单属性/协议，公告接口全量接入，防 XSS
- **安全中间件**：helmet（CSP 关闭以兼容管理后台内联脚本）、CORS 白名单（`ALLOWED_ORIGINS`）、JSON body 1MB 上限、404/错误分级 JSON 响应（坏 JSON 返回 400）
- 用户名 ≤64 / 密码 ≤128 参数长度限制

### 版本信息（`/api/version`）

- `GET`（公开）：version / changelog / downloadUrl；`PUT`（管理员）更新配置（changelog ≤50000，downloadUrl 必须 http/https）

### 管理后台

- `/admin` 静态页：浏览器维护公告与版本信息，禁用缓存避免 304 复用旧 CSP 头

### 存储

- SQLite（better-sqlite3 v12）：`announcements` / `admins` / `app_config` 三张表；`DB_PATH` / `DB_DATA_DIR` 环境变量可重定向（测试用 `:memory:` 隔离）

### 部署

- `Dockerfile`（node:18-slim）+ `docker-compose.yml`（env_file + volume 持久化 data），`docker compose up -d` 一键启动
- `.env` 配置：PORT / JWT_SECRET / ADMIN_PASSWORD / ALLOWED_ORIGINS / TRUST_PROXY

### 工程

- 测试 5 文件 28 例全量通过：announcements / auth 路由 / auth 中间件 / sanitize / version（JWT 真实签发含 issuer/audience，`DB_PATH=:memory:` 隔离）
- 依赖独立安装（npm，better-sqlite3 预构建走 npmmirror 镜像，`better_sqlite3_binary_host`）
- 版本管理：`package.json` version 为权威来源，发版同步更新 CHANGELOG 并打 tag
