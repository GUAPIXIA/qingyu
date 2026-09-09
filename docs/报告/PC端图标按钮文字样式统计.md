# PC 端图标按钮文字样式统计

> 统计日期：2026-08-27
> 范围：`src` 下 React 前端（PC 端）所有含图标的按钮（icon-only 按钮 + 图标+文字按钮）
> 技术栈：Tailwind CSS 原子类 + CSS 变量主题 + `lucide-react` 图标库（无统一的 Icon 组件，全部内联使用）

---

## 1. 样式体系基础

### 1.1 全局按钮基类（`src/index.css` `@layer components`）

| 类名 | 完整样式 | 按钮内文字样式 |
|---|---|---|
| `.btn` | `inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer select-none` | 继承：`text-sm` + `font-medium` |
| `.btn-primary` | `.btn` + 背景 `var(--color-accent)`、文字 `text-tavern-bg`；hover 背景 `--color-accent-hover` 并 `translateY(-1px)` | 浅色文字（与背景对比） |
| `.btn-secondary` | `.btn` + `bg-tavern-bg-card text-tavern-text border border-tavern-border`；hover `bg-tavern-bg-hover` | `text-tavern-text` |
| `.btn-ghost` | `.btn` + `text-tavern-text-soft`；hover `text-tavern-text` + `bg-tavern-bg-hover` | 默认 `text-sm text-tavern-text-soft`，hover `text-tavern-text` |
| `.btn-danger` | `.btn` + `bg-tavern-danger text-white`；hover `opacity-90` | 白色 |

> 说明：`.btn-*` 系列的文字大小固定为 `text-sm`（14px / 0.875rem），字体粗细 `font-medium`（500）。

### 1.2 主题/字号相关变量

- 字号档位（`html` 上切换）：`font-compact`(14px) / `font-comfortable`(16px) / `font-loose`(18px)，`*rem` 文字随基准缩放。
- 颜色令牌：`--tavern-text` / `--tavern-text-soft` / `--tavern-text-muted` / `--tavern-accent`（主题强调色）/ `--tavern-danger` / `--tavern-success` / `--tavern-warning` 等（深浅色主题自动切换）。
- 首页字体：站酷快乐体（ZCOOL KuaiLe），仅用于应用品牌/角色名称显示（`font-display`）。

---

## 2. 图标按钮样式归类

按使用位置归类。样式为按钮元素 className（对多态按钮给出完整模板）。

### 2.1 纯图标按钮（icon-only）通用模板

| 模板 | 样式 | 典型用途 |
|---|---|---|
| **标准模板**（`MessageActionBar` 的 `iconBtn` 常量） | `p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors` | 消息操作栏编辑/复制/重新生成/分支 |
| **顶栏模板** | `p-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors` | 新建会话(Plus 4×4)、添图/生图(5×5)、快捷设置 |
| **危险 hover** | `p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors` | 删除类（消息/会话/群聊） |
| **强调 hover** | `p-1.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors` | 引用回复、重新生图、AI 翻译字段 |
| **激活态** | `p-1.5 rounded text-tavern-accent bg-tavern-accent-soft` | 朗读中、显示翻译、快捷设置展开 |
| **微型行内** | `p-0.5 rounded text-tavern-text-muted hover:text-tavern-text`（危险则 `hover:text-tavern-danger`） | 会话列表重命名/删除（Edit2/Trash2 3×3） |
| **圆形悬浮** | `p-2 rounded-full bg-tavern-accent text-white hover:bg-tavern-accent-hover` / `bg-white/90 text-gray-700` | 角色卡"开始对话"/"更多操作" |

> 图标尺寸档位：消息操作 3.5×3.5 → 顶栏/列表 4×4 → 输入区主按钮 5×5。`aria-label`/`title` 即按钮的功能文字（不显示时作为无障碍/hover 提示）。

### 2.2 顶栏 / 导航类（图标+文字）

| 位置 | 按钮 | 图标 | 按钮样式 | 文字样式 |
|---|---|---|---|---|
| ChatHeader 角色选择 | 角色名+状态 | 头像/ChevronDown 4×4 | `flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover` | 角色名 `text-sm font-medium text-tavern-text`；状态 `text-xs text-tavern-text-muted` |
| ChatHeader 身份切换 | 身份名 | UserCircle 4×4 + ChevronDown 3×3 | `flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover text-sm` | `<span>` `max-w-[80px] truncate text-tavern-text-soft` |
| SessionSwitcher（单聊） | 会话标题 | Layers 3.5×3.5 + ChevronDown 3×3 | `flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover text-sm text-tavern-text-soft` | 标题 `truncate`，计数 `text-xs text-tavern-text-muted` |
| SessionSwitcher（群聊） | 会话标题 | ChevronDown 3×3 | `flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text` | `text-xs` |
| Sidebar 分组折叠 | 组名 核心/资源/服务/系统 | ChevronDown 3×3 | `group w-full h-7 flex items-center justify-between px-2.5 rounded-md text-[10px] font-medium tracking-[0.16em] text-tavern-text-muted/65 hover:text-tavern-text-muted hover:bg-tavern-bg-hover/50` | `text-[10px] font-medium tracking-[0.16em]` 淡色 |
| Sidebar 导航项 | 页面名（对话/角色卡…） | 图标 18×18 | NavLink `group relative flex items-center gap-2.5 h-10 px-2.5 rounded-xl text-sm`；激活 `bg-tavern-bg-card/80 text-tavern-text` / 默认 `text-tavern-text-soft hover:text-tavern-text` | `truncate`，激活 `font-medium` |
| Sidebar 收起/展开 | "收起" | PanelLeftClose/PanelLeft 4×4 | `w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover`（收起态仅图标） | `<span class="text-xs">收起</span>` |
| Sidebar 版本号 | `v0.x.y` | 无(红点为状态点) | `flex items-center gap-1 text-[10px] leading-none` | `text-[10px] text-tavern-text-muted hover:text-tavern-accent`，更新可用时 `text-tavern-accent` |

### 2.3 输入区按钮（图标+文字 / 纯图标）

| 位置 | 按钮 | 图标 | 按钮样式 | 文字样式 |
|---|---|---|---|---|
| ChatInput 发送 | 发送 | Send 5×5 | `p-2.5 rounded-lg` + 可用 `btn-primary` / 禁用 `bg-tavern-bg-card text-tavern-text-muted cursor-not-allowed` | — |
| ChatInput 停止 | 停止 | Square 5×5 (`fill=currentColor`) | `p-2.5 rounded-lg bg-tavern-danger text-white hover:opacity-90` | — |
| ChatInput 添图/生图 | 添加图片 / AI 生图 | ImagePlus / Wand2 5×5 | `p-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover` | — |
| ChatInput 续写/润色 | "续写"/"润色" | Sparkles / Loader2 3×3 | `px-2.5 py-1.5 rounded-lg text-xs border flex items-center gap-1`；默认 `border-tavern-border-soft bg-tavern-bg-card text-tavern-text-soft hover:text-tavern-accent hover:border-tavern-accent` | 文字直接继承 `text-xs` |
| ChatInput 回退原文 | "回退原文" | Undo2 3×3 | `flex items-center gap-1 px-2 py-1 rounded text-xs text-tavern-text-soft bg-tavern-bg-card border border-tavern-border-soft hover:border-tavern-accent hover:text-tavern-accent` | `text-xs` |
| ChatInput 快捷回复 | 快捷回复文案 | 无（热键文字） | `px-2.5 py-1 rounded-lg text-xs border border-tavern-border-soft bg-tavern-bg-card text-tavern-text-soft hover:text-tavern-accent hover:border-tavern-accent flex items-center gap-1` | 热键 `text-[10px] text-tavern-text-muted`；主文字 `truncate max-w-[10rem]` |
| GroupChatInput 发送/停止 | 发送/停止 | Send / Square 4×4 | `flex h-10 w-10 shrink-0 items-center justify-center rounded-xl`；发送 `bg-tavern-accent text-white hover:bg-tavern-accent/90`；禁用 `bg-tavern-bg-hover text-tavern-text-muted`；停止 `bg-tavern-danger/20 text-tavern-danger hover:bg-tavern-danger/30` | — |
| GroupChatInput 立即接话 | 成员名/"生成中" | Play 2.5×2.5 / LoaderCircle 3×3 | `group flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-full border px-1.5 pr-2 text-[11px] transition-all`；默认 `border-tavern-border-soft bg-tavern-bg text-tavern-text-soft hover:border-tavern-accent/35 hover:text-tavern-accent`；激活 `border-tavern-accent/40 bg-tavern-accent-soft text-tavern-accent` | 成员名 `truncate text-[11px]` |
| GroupChatInput 移除图片 | × | 无（文字×） | `absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-tavern-danger text-[8px] text-white` | `text-[8px] text-white` |
| MemoryPanel 立即总结 | "立即总结当前对话"/"回复完成后可总结" | Play 3.5×3.5 (`fill-current`) | `mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-tavern-accent px-3 py-2.5 text-xs font-medium text-white shadow-sm hover:brightness-105 disabled:opacity-45` | `text-xs font-medium text-white` |
| MemoryPanel 添加关键事实 | "添加" | Plus 3.5×3.5 | `inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-tavern-accent hover:bg-tavern-accent-soft` | `text-[11px] font-medium text-tavern-accent` |
| MemoryPanel 保存/保存中 | "保存"/"保存中" | Save 3×3 | `inline-flex items-center gap-1 rounded-md bg-tavern-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40` | `text-[11px] font-medium text-white` |
| MemoryPanel 取消 | "取消" | 无 | `rounded-md px-2 py-1 text-[11px] text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text` | `text-[11px]` |
| GroupMemberBar 成员按钮 | 成员名 | MessageSquare 3×3（当前发言） | `flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-all`；当前 `bg-tavern-accent-soft text-tavern-accent ring-2 ring-tavern-accent/50` / 默认 `bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg` | 文字 `text-xs`，当前 `font-medium` |

### 2.4 消息气泡操作（纯图标，hover 才显示）

位置：`MessageActionBar.tsx` / `GroupChatMessage.tsx` 内嵌操作栏（`opacity-0 group-hover:opacity-100`）。

| 功能（title） | 图标 | 图标尺寸 | 样式 |
|---|---|---|---|
| 编辑 | Edit2 | 3.5×3.5 | `iconBtn`（标准模板） |
| 复制 | Copy | 3.5×3.5 | `iconBtn` |
| 重新生成 | RotateCcw | 3.5×3.5 | `iconBtn` |
| 从此处分支 | GitBranch | 3.5×3.5 | `iconBtn` |
| 引用回复 | Reply | 3.5×3.5 | 强调 hover（`hover:text-tavern-accent`） |
| 重新生图 | RefreshCw / Loader2 | 3.5×3.5 | 强调 hover |
| 朗读（暂停/继续） | Volume2 / Pause / Play | 3.5×3.5 | 激活态 `text-tavern-accent bg-tavern-accent-soft` |
| 停止朗读 | VolumeX | 3.5×3.5 | 危险 hover |
| 翻译（切回原文） | Languages | 3.5×3.5 | 激活态 / 翻译中 `animate-pulse` |
| 删除 | Trash2 | 3.5×3.5 | 危险 hover |

> 群聊消息（GroupChatMessage）引用回复/翻译/编辑/重新生成/删除按钮与上表样式一致。

### 2.5 角色卡 / 角色详情 / 角色编辑（图标+文字 / 纯图标）

| 位置 | 按钮 | 图标 | 按钮样式 | 文字样式 |
|---|---|---|---|---|
| CharacterCard 封面 | 毛玻璃开关 | Eye / EyeOff 3.5×3.5 | `absolute top-2 right-2 p-1.5 rounded-full`；开 `bg-tavern-accent/80 text-white` / 关 `bg-black/40 text-white/60 hover:bg-black/60 hover:text-white` | — |
| CharacterCard | 开始对话 | MessageSquare 4×4 | `inline-flex items-center justify-center p-2 rounded-full bg-tavern-accent text-white hover:bg-tavern-accent-hover shadow-sm` | — |
| CharacterCard | 更多操作 | MoreHorizontal 4×4 | `p-2 rounded-full bg-white/90 text-gray-700 hover:bg-white shadow-sm` | — |
| CharacterCard 菜单项 | 编辑/导出/删除 | Edit3/Download/Trash2 3.5×3.5 | `w-full px-3 py-2 text-left hover:bg-tavern-bg-hover flex items-center gap-2`；删除项 `hover:bg-tavern-danger/10 text-tavern-danger` | 继承菜单 `text-sm` |
| CharacterDetail 顶栏 | 开始对话/编辑/关闭 | MessageSquare/Edit3 4×4、X 5×5 | 开始对话 `p-2 rounded-lg bg-tavern-accent text-white hover:bg-tavern-accent-hover`；编辑 `p-2 rounded-lg hover:bg-tavern-bg-hover text-tavern-text-soft hover:text-tavern-text`；关闭 `text-tavern-text-muted hover:text-tavern-text` | 右上角 `h2` 名称 `font-display font-bold text-lg` |
| CharacterDetail 底部 | 开始对话/编辑 | MessageSquare/Edit3 4×4 | `btn-primary flex-1` / `btn-secondary` + `flex items-center justify-center gap-2` | 继承 `.btn` `text-sm font-medium` |
| CharacterEditor footer | 取消 / AI 翻译 / 保存 | Languages/Loader2 4×4 | `btn-secondary` / `btn-primary`（+`gap-2`） | 继承 `.btn` |
| IdentitySection | 重新加载封面 | RefreshCw/Loader2 3×3 | `btn-mini mt-2 w-full flex items-center justify-center gap-1`（btn-mini 为自定义类，CSS 未定义时回退为内联样式类） | 文字随父级 `text-xs`（"重新加载封面"） |
| IdentitySection / AdvancedSection / Bindings | AI 翻译字段 | Languages/Loader2 3.5×3.5 | `p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft align-middle` | —（title="AI 翻译此字段"） |
| IdentitySection | 清除翻译 | X 3×3 | `p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger` | — |

### 2.6 页面工具栏 / 列表行按钮

| 页面 | 按钮 | 图标 | 按钮样式 | 文字样式 |
|---|---|---|---|---|
| CharactersPage | 制作角色卡 | Wand2 4×4 | `btn-primary` | 继承 `.btn` |
| CharactersPage | PNG / JSON / 批量导入 | FileUp/Upload/FileStack 4×4 | `btn-secondary` | 继承 `.btn` |
| CharactersPage | 视图切换 网格/列表 | Grid3X3/List 4×4 | 图标组 `bg-tavern-bg-hover rounded-lg p-0.5` 内：`p-1.5 rounded`，激活 `bg-tavern-bg-card shadow-sm text-tavern-accent` / 默认 `text-tavern-text-muted hover:text-tavern-text` | — |
| CharactersPage | 卡片大小 小/中/大 | 无（文字） | 同视图切换组：`px-2.5 py-1 rounded text-xs font-medium` | `text-xs font-medium`，激活 `text-tavern-accent` |
| LorebookPage | 编辑/翻译/删除条目 | Pencil/Languages/Trash2 4×4、Loader2 3.5×3.5 | `btn-ghost p-1.5`；删除 `btn-ghost p-1.5 text-tavern-danger`；已有翻译 `text-tavern-accent` | — |
| LorebookPage | 展开/收起条目 | ChevronUp/Down 3×3 | `text-xs text-tavern-text-muted hover:text-tavern-text flex items-center gap-0.5` | — |
| PresetsPage | 复制为新预设/导出 JSON/删除 | Copy/Download/Trash2 | `btn-ghost p-1.5` 系列 | — |
| PersonasPage | 导入/导出 | Upload/Download 4×4 | `btn-ghost text-sm`（`flex items-center gap-2`） | 文字 `text-sm text-tavern-text-soft` |
| PersonasPage | 新建身份 | Plus | `btn-primary` | 继承 `.btn` |
| McpPage | 停止/启动/编辑/删除 | Square/Play/Pencil/Trash2 4×4、Loader2 | 停止 `p-1.5 rounded-lg text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10`；启动 `hover:text-tavern-success hover:bg-tavern-success/10`；编辑 `hover:text-tavern-accent hover:bg-tavern-accent/10`；删除同停止 | — |
| AnnouncementsPage | 刷新公告 | RefreshCw | `p-1.5 rounded-lg hover:bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-tavern-accent` | — |
| GroupChatPage | 新建群聊 / 收起列表 | Plus / PanelLeftClose 4×4 | `btn-ghost p-1 rounded-lg hover:bg-tavern-accent-soft hover:text-tavern-accent`（新建）/ `hover:bg-tavern-bg-hover text-tavern-text-muted` | — |
| GroupChatPage 列表行 | 删除群聊 | Trash2 3.5×3.5 | `p-1 rounded hover:bg-tavern-danger/20 text-tavern-text-muted hover:text-tavern-danger` | 行标题 `text-sm font-medium`，副行 `text-[10px] text-tavern-text-muted` |

### 2.7 通用组件（Modal / Dropdown / 菜单 / Tooltip）

| 组件 | 按钮 | 图标 | 按钮样式 | 文字样式 |
|---|---|---|---|---|
| Modal 关闭 | 关闭 | X 4×4 | `p-1.5 rounded-lg text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text`（MemoryPanel 同款） | — |
| Dropdown 面板项 | 菜单项文字 | 各 lucide 图标 4×4 | `w-full flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover text-left` | 继承 `text-sm text-tavern-text`，选中项 `bg-tavern-accent-soft` |
| CommandPalette 命令项 | 命令文字+描述 | 各 lucide 图标 4×4 | `w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors`；选中 `bg-tavern-bg-hover text-tavern-text` / 默认 `text-tavern-text-muted hover:text-tavern-text` | 主文字 `flex-1 truncate`；描述 `text-xs text-tavern-text-muted`；快捷键 kbd `text-[10px] bg-tavern-bg-hover text-tavern-text-muted border border-tavern-border-soft` |
| ConfirmDialog | 确认/取消 | 无（title 为弹窗标题） | `btn-danger`（danger）/ `btn-primary` | 继承 `.btn` |
| Tooltip | —（悬停提示） | — | 提示层 `absolute z-50 px-2 py-1 text-xs text-white bg-tavern-bg-card border border-tavern-border rounded-lg shadow-lg` | `text-xs text-white` |
| SectionCard 折叠头 | 标题文字 | 自定义 icon + ChevronDown 4×4 | `w-full flex items-center justify-between px-4 py-3 hover:bg-tavern-bg-hover` | 标题 `h2 class="font-display text-base font-semibold"`，图标外层 `text-tavern-accent` |

---

## 3. 文字样式令牌速查

### 3.1 字号（最常出现）

| 令牌 | 值 | 用途 |
|---|---|---|
| `text-[8px]` | 8px | 图片移除角标 × |
| `text-[10px]` | 10px | 辅助说明、热键、分组标签、版本号、状态标签 |
| `text-[11px]` | 11px | MemoryPanel 小按钮、成员胶囊 |
| `text-xs` | 12px | 按钮文字首选（`text-[11px]` 的常用替代）、次级信息 |
| `text-sm` | 14px | `.btn` 系列、导航、下拉项、输入区主按钮 |
| `text-base` / `text-lg` | 16/18px | 标题（`.font-display` 品牌字） |

### 3.2 颜色（按钮文字 / 图标）

| 键 | 含义 | 使用场景 |
|---|---|---|
| `text-tavern-text` | 主文字 | 激活导航、行内文字、hover 目标 |
| `text-tavern-text-soft` | 次文字 | 按钮默认文字（btn-ghost、续写/润色等） |
| `text-tavern-text-muted` | 弱化文字 | 图标默认色、辅助信息、分割提示 |
| `text-tavern-accent` | 主题强调色 | hover 强调、激活态、链接色、快捷键提示 |
| `text-tavern-danger` | 危险色 | 删除类 hover、错误提示 |
| `text-tavern-success` | 成功色 | MCP 启动 hover、连接状态 |
| `text-white` | 白色 | primary/danger 实底按钮、Tooltip |
| `text-gray-700` | 灰色 | CharacterCard 更多操作（白底圆形） |

### 3.3 hover 变换规律

- 图标按钮统一加 `transition-colors`（颜色过渡），部分 `transition-all`。
- 文字类 hover：`text-tavern-text-muted → text-tavern-text`（中性）、`hover:text-tavern-accent`（强调）、`hover:text-tavern-danger`（危险）。
- 实底按钮 hover：`bg-tavern-accent → bg-tavern-accent-hover`，部分 `translateY(-1px)`（`.btn-primary`）或 `opacity-90`（`.btn-danger`）。
- 激活态统一用 `bg-tavern-accent-soft` + `text-tavern-accent` 表达"已选中/进行中"。

---

## 4. 关键结论

1. **无独立 Icon 组件与独立文字样式组件**：图标全部内联 `lucide-react`，按钮文字通常直接写在 `<button>` 内（无 `<span>` 包裹时继承按钮字号），样式全靠 Tailwind 原子类叠加。
2. **样式高度统一，可归纳为 8 类**：标准图标按钮（iconBtn）、顶栏图标按钮、危险/强调 hover 变体、激活态、`.btn/.btn-primary/.btn-secondary/.btn-ghost/.btn-danger` 五件套（文字统一 `text-sm font-medium`）、文字微按钮（`text-xs`~`text-[11px]`）、胶囊按钮（`rounded-full`）、圆形悬浮按钮。
3. **图标尺寸 3 档**：操作 3.5×3.5、常规列表/顶栏 4×4、输入区主按钮/大图标 5×5（群聊输入区为 40×40 方形按钮内 4×4 图标）。
4. **文字梯队**：主操作 `text-sm font-medium`（white/tavern-bg）→ 次级操作 `text-sm text-tavern-text-soft` → 微型操作 `text-xs`~`text-[11px]` → 辅助文字 `text-[10px] text-tavern-text-muted`。
5. **提示文字**：纯图标按钮一律用 `title`/`aria-label` 提供功能文字；自研 `Tooltip` 组件提示样式为 `text-xs text-white`，基于 `group-hover` 显示。
