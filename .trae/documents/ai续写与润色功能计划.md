# AI 续写 & 润色功能

## 概述

重构 ChatInput 中的"AI 续写"和"润色"快捷按钮，改为真正的 AI 辅助功能：
- **AI 续写**：调用 AI 基于对话上下文，以用户角度续写或生成文本。有输入时从已有内容续写，无输入时从零生成。结果填入输入框，不自动发送
- **润色**：调用 AI 对用户已输入内容进行润色修改，润色后显示回退按钮，发送消息后回退按钮消失

## 当前状态分析

### 现有实现（ChatInput.tsx line 58-96）
- `quickCommands` 数组定义了两个按钮，但行为只是把固定 prompt 文本填入 textarea
- 按钮仅在 `text.length === 0` 时显示（line 83）
- 用户需要手动发送填好的文本

### AI 调用链路
- `window.api.ai.chat(params)` → IPC `ai:chat` → `electron/services/ai.ts` 适配器 → HTTP 流式请求
- 流式结果通过 `window.api.ai.onChunk(callback)` 逐字推送，完成后 `onDone` 触发
- Context 构建在 `useChatStore.buildContext()`（line 536），包含角色设定、世界书、记忆、最近消息

### 涉及文件
- `src/components/chat/ChatInput.tsx` — 主要修改目标
- `src/store/useChatStore.ts` — 可能需要新增辅助方法
- `electron/services/ai.ts` — 已有 `ai:chat` IPC，无需修改
- `electron/preload.ts` — 已有 AI API 暴露，无需修改

---

## 变更方案

### 1. ChatInput.tsx — 核心改动

#### 1.1 新增状态
```ts
const [isAiProcessing, setIsAiProcessing] = useState(false)  // AI 正在处理中
const [originalText, setOriginalText] = useState<string | null>(null)  // 润色前的原始文本，非 null 时显示回退按钮
```

#### 1.2 修改 quickCommands 定义
- 移除旧的 prompt 文本填充逻辑
- 改为按钮触发对应的 AI 处理函数

```ts
const quickCommands = [
  { 
    label: 'AI 续写', 
    action: 'continue',
    icon: <Sparkles className="w-3 h-3" />,
  },
  { 
    label: '润色', 
    action: 'polish',
    icon: <Sparkles className="w-3 h-3" />,
  },
]
```

#### 1.3 显示条件
- **AI 续写**：始终显示（`!isStreaming && !isAiProcessing`），无论输入框是否有内容
- **润色**：仅在输入框有文本时显示（`!isStreaming && text.trim().length > 0 && !isAiProcessing`）

#### 1.4 AI 续写函数（ChatInput 内部实现）

```
handleAiContinue():
  1. 获取当前输入 text（可能为空）
  2. 获取最近消息作为上下文（从 useChatStore.getState().messages）
  3. 区分两种情况：
     - 有输入：System Prompt 要求续写已有内容
     - 无输入：System Prompt 要求基于上下文从零生成一条用户消息
  4. 构建 messages 数组：
     - system: prompt + 角色/场景信息
     - 最近 N 条历史消息
     - user: 当前输入（为空时则用"请根据上下文生成我应该说的话"）
  5. 调用 window.api.ai.chat()（非流式，maxTokens ~200）
  6. 结果处理：
     - 有输入时：追加到 textarea 末尾
     - 无输入时：直接填入 textarea
```

#### 1.5 润色函数（ChatInput 内部实现）

```
handleAiPolish():
  1. 保存 originalText = text
  2. 构建 System Prompt：
     "你是一个文字润色助手。请润色以下文本，修正语法、改善表达、
      使其更加流畅自然，但保持原意和语气不变。只输出润色后的文本，
      不要添加任何解释或额外内容。"
  3. 调用 window.api.ai.chat() 直接传入用户文本
  4. 将返回结果替换 textarea 内容
  5. 设置 isAiProcessing = false
```

#### 1.6 回退按钮
- 当 `originalText !== null` 时，在输入框上方或旁边显示回退按钮
- 点击回退：`setText(originalText); setOriginalText(null)`
- 发送消息时（handleSend 中）：`setOriginalText(null)`

#### 1.7 按钮 UI 变更
- 原来显示在输入框上方 (`flex gap-2 mb-2`)
- 改为显示在输入框右侧区域（发送按钮旁边），更符合"输入辅助工具"的定位
- 按钮使用小图标 + 文字标签样式

---

### 2. 功能细节决策

| 项目 | AI 续写 | 润色 |
|------|---------|------|
| **需要用户输入** | 否（可为空） | 是 |
| **显示条件** | 始终（非流式） | 有文本时 |
| **需要上下文** | 是（最近消息） | 否（仅当前文本） |
| **流式输出** | 否（一次性返回） | 否（一次性返回） |
| **maxTokens** | ~200 | ~500 |
| **结果处理** | 有输入→追加；空→填入 | 替换输入框内容 |
| **回退支持** | 否 | 是（originalText） |
| **发送时清除** | - | 清 originalText |

---

## 实施步骤

1. **修改 ChatInput.tsx**
   - 新增 `isAiProcessing`, `originalText` 状态
   - 新增 `handleAiContinue()` 和 `handleAiPolish()` 函数
   - 修改 quickCommands 显示条件（需有文本）
   - 修改 quickCommands 按钮行为（调用新函数）
   - 新增回退按钮 UI
   - 在 `handleSend` 中清除 `originalText`

2. **无需修改其他文件**
   - AI 调用直接使用已有的 `window.api.ai.chat()`
   - 上下文从 `useChatStore.getState()` 获取

## 验证

1. 输入一段文本 → 点击"润色" → AI 返回润色后文本替换输入框 → 显示回退按钮 → 点击回退恢复原文 → 消失
2. 输入一段文本 → 点击"润色" → 润色后点击发送 → 回退按钮消失 → 消息发送
3. 输入不完整文本 → 点击"AI 续写" → AI 续写结果追加到输入框 → 用户可继续编辑 → 手动发送
4. 输入框为空（有对话历史） → 点击"AI 续写" → AI 基于上下文从零生成并填入输入框
5. 输入框为空（无对话历史） → 点击"AI 续写" → AI 生成一条起始消息填入输入框
6. AI 处理中时 → 按钮显示 loading 状态，不可重复点击
