# 🍶 轻语 QingYu

> 轻量级 AI 角色扮演桌面客户端 — 基于 SillyTavern 理念，专注本地化、开箱即用体验。

<p align="center">
  <img src="https://img.shields.io/badge/version-0.8.1-blue?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/electron-32.x-47848f?style=flat-square" alt="electron">
  <img src="https://img.shields.io/badge/react-18.x-61dafb?style=flat-square" alt="react">
  <img src="https://img.shields.io/badge/typescript-5.x-3178c6?style=flat-square" alt="typescript">
  <img src="https://img.shields.io/badge/vite-6.x-646cff?style=flat-square" alt="vite">
  <img src="https://img.shields.io/badge/tailwind-3.x-06b6d4?style=flat-square" alt="tailwind">
  <img src="https://img.shields.io/badge/platform-Windows-blueviolet?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license">
</p>

---

## ✨ 功能特性

### 🤖 AI 对话
- **多后端支持** — OpenAI 兼容接口 / Anthropic Claude / Google Gemini / Ollama，支持自定义 Base URL
- **流式输出** — 逐字实时显示 AI 回复，可随时中断
- **对话分支** — 从任意消息创建新分支，自由探索不同故事走向
- **长记忆** — AI 自动总结对话历史，基于 Token 预算智能注入上下文
- **对话翻译** — 消息级中英互译，Markdown 格式无损保留
- **心理描写** — `<thought>` 标签折叠展示，与角色对话内容明确区分
- **Swipe 切换** — 支持多候选回复，左右滑动切换满意的回复

### 👥 群聊系统
- **三种协作模式**：@点名（mention）、轮询（polling）、自由发言（free）
- **多角色实时对话**，成员可动态增减
- **独立会话管理**，群聊与单聊互不干扰

### 🎭 角色管理
- **完整兼容** SillyTavern Character Card V1 / V2 / V3（PNG + JSON）
- **批量导入** — 多文件一次性导入，自动提取内嵌世界书
- **无损翻译** — AI 一键翻译角色卡（英 → 中），译文存独立字段，原文不丢失
- **角色封面** — 支持自定义封面图，可设为聊天页半透明背景

### 🖼️ 图片生成
- **SD WebUI / ComfyUI / OpenAI DALL-E** 多引擎支持
- 对话中 `/imagine` 命令生图，自动提取提示词
- 中文提示词自动翻译为英文，提升出图质量
- 多尺寸 / 多质量预设，灵活切换

### 📚 世界书（Lorebook）
- **关键词动态触发** — 检测到关键词时自动注入角色背景设定
- **条目管理** — 选择性启用、权重排序、递归扫描深度控制
- 支持常量 / 向量索引 / LLM 三种匹配模式

### 🎛️ 预设系统
- **对话预设** — 可切换的 System Prompt 模板，配合角色使用
- **正则替换** — 批量输入/输出规则，支持前后处理管线
- 内置多种常用预设，开箱即用

### 📢 在线公告（v0.8.1+）
- 侧栏「公告」入口，拉取服务器在线公告
- 支持 **Markdown 富文本**渲染（表格、代码块、图片等）
- **离线缓存** — 网络不可达时自动使用本地缓存
- 配套 **Docker 一键部署** 的服务端 + Web 管理后台

### 🎨 主题与外观
- 深色 / 浅色 / 跟随系统 **三模式切换**
- **9 种主题色**：琥珀金、翡翠绿、深海蓝、玫瑰粉、紫色、青色、橙色、粉红、灰色
- 气泡圆角三档可调（圆润 / 标准 / 锐利）
- 字体大小四档 + 自定义

### 🔊 更多
- **TTS 语音合成** — Edge TTS / Fish Audio / OpenAI TTS，每条消息独立播报
- **MCP 工具集成** — 支持 Model Context Protocol，扩展 AI 能力
- **斜杠命令** — `/help`、`/imagine`、`/continue` 等 16+ 内置命令
- **Token 用量统计** — 按模型/角色/日期多维度统计，费用自动估算
- **用户人设（Persona）** — 支持多用户身份切换

### 🔒 数据安全
- **纯本地存储** — 所有数据在本地 AppData，无云端上传
- **一键备份** — 完整导出/导入（角色、对话、设置、世界书、预设）
- **API Key 加密** — 系统级安全加密存储

---

## 🚀 快速开始

### 桌面端（Windows）

```bash
# 安装依赖
pnpm install

# 开发模式（Electron + Vite HMR）
pnpm electron:dev

# 生产构建（NSIS 安装包）
pnpm electron:build
```

### 在线公告服务端（可选）

如果你有自己的服务器，可以部署公告系统：

```bash
# 1. 将 server/ 目录上传至服务器
scp -r server/ root@你的服务器IP:/opt/tavern-announce/

# 2. SSH 登录，Docker Compose 一键启动
cd /opt/tavern-announce
docker compose up -d --build

# 3. Nginx 反代配置示例
#   location /api/ -> http://127.0.0.1:3000
#   location /admin/ -> http://127.0.0.1:3000

# 4. 访问 http://你的域名/admin/ 进入管理后台
#    默认账号见服务端启动日志
```

桌面端公告服务器 URL 可在 `electron/ipc/announcement.ts` 中修改默认值。

---

## 🛠️ 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Electron 32 |
| 前端 | React 18 + TypeScript 5 |
| 构建工具 | Vite 6 + esbuild |
| UI 框架 | Tailwind CSS 3（CSS 变量主题系统） |
| 状态管理 | Zustand 5 |
| 路由 | react-router-dom 7（HashRouter） |
| Markdown | react-markdown + remark-gfm + rehype-raw + rehype-highlight |
| 虚拟滚动 | react-virtuoso |
| 图标 | lucide-react |
| 打包 | electron-builder（NSIS） |
| 服务端 | Express + better-sqlite3 + JWT + Docker |

---

## 📁 项目结构

```
轻语/
├── src/                        # 前端 React 代码
│   ├── main.tsx                # React 入口
│   ├── App.tsx                 # 根组件（路由 + 主题初始化）
│   ├── index.css               # 全局样式（CSS 变量 + Tailwind）
│   ├── components/
│   │   ├── api/                # API 配置组件
│   │   ├── character/          # 角色编辑、角色卡片
│   │   ├── chat/               # 聊天输入、消息气泡、群聊 UI
│   │   ├── common/             # 通用组件（Modal、EmptyState）
│   │   └── layout/             # MainLayout、Sidebar
│   ├── pages/                  # 14 个路由页面
│   │   ├── ChatPage.tsx        # 单角色对话
│   │   ├── GroupChatPage.tsx   # 群聊
│   │   ├── CharactersPage.tsx  # 角色卡管理
│   │   ├── AnnouncementsPage.tsx  # 在线公告
│   │   └── ...
│   ├── store/                  # Zustand 状态管理（6 个 Store）
│   ├── commands/               # 斜杠命令系统
│   └── utils/                  # 工具函数
├── electron/                   # Electron 主进程
│   ├── main.ts                 # 主进程入口
│   ├── preload.ts              # 预加载脚本（contextBridge）
│   ├── ipc/                    # 14 个 IPC 处理器模块
│   ├── services/               # 后端服务（AI、存储、生图等）
│   └── mcp/                    # MCP 协议实现
├── shared/                     # 前后端共享
│   ├── types.ts                # 全部 TypeScript 类型定义
│   └── ipc-api.ts              # IPC 接口契约
└── server/                     # 在线公告服务端（可独立部署）
    ├── Dockerfile
    ├── docker-compose.yml
    └── app/                    # Express + SQLite 后端
```

---

## ⌨️ 快捷键

| 按键 | 功能 |
|------|------|
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `Esc` | 关闭弹窗 / 停止生成 |

---

## 📝 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)

---

## 📄 开源协议

[MIT License](LICENSE)
