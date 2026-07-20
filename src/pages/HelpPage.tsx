import { useState } from 'react'
import { cn } from '../lib/utils'
import {
  Settings,
  Users,
  MessageSquare,
  Keyboard,
  HelpCircle,
  BookOpen,
  Info,
  ChevronDown,
  Zap,
  FileUp,
  Brain,
  Palette,
  Layers,
  Download,
  GitBranch,
  Languages,
  ScrollText,
} from 'lucide-react'

const steps = [
  {
    icon: Settings,
    title: '配置 AI 连接',
    desc: '进入设置页面，选择 AI 提供商（OpenAI 兼容 / Claude / Gemini / Ollama），填写 API Key 与 Base URL，选择模型后保存。支持 DeepSeek、Kimi、智创聚合等兼容接口。',
  },
  {
    icon: FileUp,
    title: '导入或创建角色',
    desc: '支持 PNG / JSON 格式的 SillyTavern 角色卡批量导入。也可以手动创建角色，填写描述、性格、首条消息等设定。导入时自动提取内嵌世界书。',
  },
  {
    icon: Palette,
    title: '编辑角色信息',
    desc: '支持 AI 一键翻译角色卡（英 → 中），可拖拽调整文本框高度。支持自定义角色封面、标签、对话示例、场景设定等高级选项。',
  },
  {
    icon: MessageSquare,
    title: '开始对话',
    desc: '从角色管理页点击角色进入对话。支持单角色多会话、会话切换、对话分支。Enter 发送，Shift+Enter 换行。',
  },
]

const shortcuts: { key: string; desc: string }[] = [
  { key: 'Enter', desc: '发送消息' },
  { key: 'Shift + Enter', desc: '换行' },
  { key: 'Esc', desc: '关闭弹窗 / 停止生成' },
]

const features = [
  {
    icon: Layers,
    title: '多会话支持',
    desc: '同一角色可创建多个对话会话，支持切换、重命名、删除。每个会话独立保存消息记录。',
  },
  {
    icon: GitBranch,
    title: '对话分支',
    desc: '从任意消息创建新会话分支，保留该消息之前的历史。适合探索不同的对话发展方向。',
  },
  {
    icon: Brain,
    title: '长记忆功能',
    desc: '可开启长期记忆，手动或自动（每 N 条消息）由 AI 总结对话历史，并自动注入到新对话的上下文中。',
  },
  {
    icon: Languages,
    title: 'AI 翻译',
    desc: '角色卡编辑器内置 AI 翻译按钮，一键将英文角色卡翻译为中文，逐字段翻译并显示进度。',
  },
  {
    icon: ScrollText,
    title: '心理描写展示',
    desc: 'AI 回复中的 <thought> 标签内容会以独立的折叠区块展示，与角色对话内容明确区分，支持展开/收起。',
  },
  {
    icon: Palette,
    title: '主题切换',
    desc: '支持深色/浅色/跟随系统三种主题模式，以及琥珀金、翡翠绿、深海蓝、玫瑰粉四种主题色。',
  },
]

const faqs: { q: string; a: string }[] = [
  {
    q: '如何配置 API？',
    a: '进入"设置"页面，选择 AI 提供商（OpenAI 兼容 / Claude / Gemini / Ollama），填写对应的 API Key 与 Base URL（如需自定义），选择模型后保存即可。支持 DeepSeek、Kimi、智创聚合等兼容 OpenAI 接口的服务。',
  },
  {
    q: '如何导入角色卡？',
    a: '在"角色管理"页面点击 PNG 或 JSON 按钮导入单个文件，或使用"批量导入"一次性导入多个文件。支持 V1/V2/V3 角色卡格式。',
  },
  {
    q: '支持哪些 AI 模型？',
    a: '支持 OpenAI（GPT 系列）、Anthropic Claude、Google Gemini 以及本地 Ollama 模型。任何兼容 OpenAI Chat Completions 接口的服务均可通过自定义 Base URL 接入。',
  },
  {
    q: '数据存储在哪里？',
    a: '所有角色、对话、设置、世界书、预设均保存在本地 Electron 用户数据目录中（AppData/Roaming/light-tavern/）。数据完全本地化，不会被上传到任何服务器。API Key 使用系统级别加密存储。',
  },
  {
    q: '如何备份和迁移数据？',
    a: '在设置 → 数据管理中可导出/导入完整备份（含角色、对话、设置、世界书、预设）。也可以单独导出角色卡为 PNG/JSON 格式进行分享。',
  },
  {
    q: '角色卡版本兼容情况如何？',
    a: '完全兼容 SillyTavern Character Card V1、V2、V3 格式。导入时自动提取内嵌世界书（character_book）、处理备用问候语（alternate_greetings）等字段。',
  },
  {
    q: '什么是世界书（Lorebook）？',
    a: '世界书是动态注入的角色设定增强系统。根据对话内容中出现的关键词，自动将对应的世界书条目注入到 AI 的上下文中，让 AI 在不同情境下获取更准确的背景知识。',
  },
  {
    q: '对话记忆是如何工作的？',
    a: '开启长记忆后，系统会定期（手动或自动）调用 AI 对对话历史进行总结，生成的摘要会作为"对话历史摘要"注入到后续对话的 system prompt 中，帮助 AI 在长对话中保持一致性。',
  },
]

export function HelpPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(0)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">帮助</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-4xl mx-auto space-y-4">
          {/* 新手引导 */}
          <section className="card p-5">
            <h2 className="font-medium flex items-center gap-2 mb-4">
              <BookOpen className="w-4 h-4 text-tavern-accent" />
              快速上手
            </h2>
            <div className="space-y-0">
              {steps.map((step, idx) => {
                const Icon = step.icon
                return (
                  <div key={idx} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="w-8 h-8 rounded-full bg-tavern-accent-soft text-tavern-accent flex items-center justify-center font-bold text-sm shrink-0">
                        {idx + 1}
                      </div>
                      {idx < steps.length - 1 && (
                        <div className="w-px flex-1 bg-tavern-border-soft my-1" />
                      )}
                    </div>
                    <div className="flex gap-3 pb-4">
                      <div className="w-9 h-9 rounded-lg bg-tavern-bg-hover flex items-center justify-center shrink-0">
                        <Icon className="w-5 h-5 text-tavern-accent" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-tavern-text">{step.title}</div>
                        <p className="text-sm text-tavern-text-muted mt-0.5 leading-relaxed">
                          {step.desc}
                        </p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 核心功能 */}
          <section className="card p-5">
            <h2 className="font-medium flex items-center gap-2 mb-4">
              <Zap className="w-4 h-4 text-tavern-accent" />
              核心功能
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {features.map((f, idx) => {
                const Icon = f.icon
                return (
                  <div key={idx} className="p-3 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-4 h-4 text-tavern-accent" />
                      <span className="text-sm font-medium text-tavern-text">{f.title}</span>
                    </div>
                    <p className="text-xs text-tavern-text-muted leading-relaxed">{f.desc}</p>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 快捷键参考 */}
          <section className="card p-5">
            <h2 className="font-medium flex items-center gap-2 mb-3">
              <Keyboard className="w-4 h-4 text-tavern-accent" />
              快捷键
            </h2>
            <div className="flex flex-wrap gap-3">
              {shortcuts.map((s, idx) => (
                <div key={idx} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-tavern-bg-soft">
                  <kbd className="px-2 py-0.5 rounded bg-tavern-bg-hover text-tavern-accent text-xs font-mono">
                    {s.key}
                  </kbd>
                  <span className="text-xs text-tavern-text-soft">{s.desc}</span>
                </div>
              ))}
            </div>
          </section>

          {/* 常见问题 */}
          <section className="card p-5">
            <h2 className="font-medium flex items-center gap-2 mb-4">
              <HelpCircle className="w-4 h-4 text-tavern-accent" />
              常见问题
            </h2>
            <div className="space-y-2">
              {faqs.map((f, idx) => {
                const isOpen = openFaq === idx
                return (
                  <div
                    key={idx}
                    className="rounded-lg border border-tavern-border-soft overflow-hidden"
                  >
                    <button
                      onClick={() => setOpenFaq(isOpen ? null : idx)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-tavern-bg-hover transition-colors"
                    >
                      <span className="text-sm font-medium text-tavern-text">{f.q}</span>
                      <ChevronDown
                        className={cn(
                          'w-4 h-4 text-tavern-text-muted transition-transform shrink-0',
                          isOpen && 'rotate-180'
                        )}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-3 pb-3 text-sm text-tavern-text-muted leading-relaxed">
                        {f.a}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          {/* 关于 */}
          <section className="card p-5">
            <h2 className="font-medium flex items-center gap-2 mb-4">
              <Info className="w-4 h-4 text-tavern-accent" />
              关于
            </h2>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-xl bg-tavern-accent-soft flex items-center justify-center text-tavern-accent">
                <Zap className="w-6 h-6" />
              </div>
              <div>
                <div className="font-display text-lg font-bold">轻 Tavern</div>
                <div className="text-xs text-tavern-text-muted">版本 v0.1.0</div>
              </div>
            </div>
            <p className="text-sm text-tavern-text-soft leading-relaxed mb-3">
              基于 SillyTavern 理念的 AI 角色扮演桌面客户端，专注于本地化、轻量级、开箱即用的角色扮演体验。
              支持多种 AI 后端、角色卡导入与管理、多会话、长记忆、世界书等丰富功能。
            </p>
            <div className="flex flex-wrap gap-4 text-xs text-tavern-text-muted">
              <span>技术栈：Electron + React + TypeScript + Tailwind CSS</span>
              <span>角色卡格式：V1 / V2 / V3 兼容</span>
              <span>数据存储：纯本地，无云端上传</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
