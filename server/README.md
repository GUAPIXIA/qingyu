# 轻语公告服务端（tavern-announce）

「轻语」的独立公告/版本服务端：Express + SQLite，用于公网部署，让客户端远程拉取公告与版本信息。与主应用（Electron 客户端）完全解耦，可单独部署。

当前版本 **1.0.4**，更新日志见 [CHANGELOG.md](CHANGELOG.md)。

## 快速开始

```bash
cp .env.example .env   # 配置 JWT_SECRET 与 ADMIN_PASSWORD（强密码：≥12 位含大小写与数字）
npm install            # 或 docker compose up -d（容器化部署）
npm start              # 默认监听 3000 端口
```

首次启动自动创建管理员账号 `admin`（密码取 `ADMIN_PASSWORD`），浏览器访问 `/admin` 维护公告。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 监听端口，默认 3000 |
| `JWT_SECRET` | 是 | JWT 签名密钥，至少 32 位随机串（`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`） |
| `ADMIN_PASSWORD` | 是 | 管理员初始密码，强密码门禁（≥12 位含大小写数字，拒绝 14 种常见弱密码） |
| `ALLOWED_ORIGINS` | 否 | CORS 白名单，逗号分隔，默认 `http://localhost:3000` |
| `TRUST_PROXY` | 否 | 反代部署时设为跳数（如 `1`），登录限流正确取客户端 IP |
| `DB_PATH` / `DB_DATA_DIR` | 否 | SQLite 路径重定向（测试/多实例场景） |

## API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/announcements` | 公开 | 已发布公告分页列表（置顶优先） |
| GET | `/api/announcements/:id` | 公开 | 公告详情 |
| GET | `/api/announcements/admin` | JWT | 全量列表（含草稿） |
| POST/PUT/DELETE | `/api/announcements...` | JWT | 公告增删改 |
| POST | `/api/auth/login` | 公开 | 登录，5 次失败锁定 15 分钟 |
| GET | `/api/version` | 公开 | 版本信息（version/changelog/downloadUrl） |
| PUT | `/api/version` | JWT | 更新版本信息 |
| GET | `/update/*` | 静态文件 | PC 更新清单与手动下载（latest.yml + 安装包 + blockmap） |
| GET | `/admin` | 页面 | 管理后台（浏览器维护公告） |

## 在线更新服务器源

客户端检查更新时会并行读取本服务的 `latest.yml` 与 GitHub Releases，并分别显示版本。自动下载默认走 GitHub，本服务用于国内手动下载。

发版后将以下文件放入 `app/data/updates/`（或设环境变量 `UPDATES_DIR` 指向自定义目录）：

```
updates/
├── latest.yml                      # electron-builder 生成，禁用缓存
├── QingYu-Setup-x.y.z.exe          # NSIS 安装包
└── QingYu-Setup-x.y.z.exe.blockmap # 增量更新差异文件
```

客户端固定使用官方 HTTPS 地址，不再向用户提供镜像源输入框。部署时应先上传安装包和 blockmap，最后替换 `latest.yml`。

## 测试

```bash
cd app && npm test
```

5 个测试文件 28 例（公告路由 / 认证路由 / 认证中间件 / HTML 消毒 / 版本接口），使用 `DB_PATH=:memory:` 隔离，不污染真实数据。

## 发版流程

发版流程细节见仓库 [`docs/规范/项目更新与上传规范.md`](../docs/规范/项目更新与上传规范.md) 与 [`docs/规范/项目推送与版本管理规范.md`](../docs/规范/项目推送与版本管理规范.md)。摘要：

1. 更新 `app/package.json` 的 `version`（当前见文件头）
2. `CHANGELOG.md` 顶部新增一节（格式：`## [x.y.z] - 日期`）
3. 提交并打 tag（**服务端使用 `server-v*` 前缀**，与桌面端 `v*` 区分）：

```bash
git add -A
git commit -m "chore(server): v<x.y.z> — <变更摘要>"
git tag server-v<x.y.z>
git push origin main server-v<x.y.z>
```
