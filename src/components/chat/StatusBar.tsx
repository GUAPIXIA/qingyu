import { useMemo } from 'react'
import { Heart, MapPin, Smile } from 'lucide-react'
import type { Message } from '../../../shared/types'

interface StatusBarProps {
  messages: Message[]
}

interface StatusItem {
  label: string
  value: string
  icon: typeof Heart
}

/**
 * 从 AI 回复中解析状态更新
 * 格式: [Status: key=value] 或 【状态: key=value】
 */
function parseStatusFromMessages(messages: Message[]): StatusItem[] {
  const statusMap = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    // 匹配 [Status: key=value] 或 【状态: key=value】
    // 拆分为两个正则：【状态:】格式用 [^】] 排除字符，使 value 可含 ]
    const regexBracket = /\[Status:\s*([^=]+?)\s*=\s*([^\]]+?)\s*\]/gi
    const regexCJK = /【状态:\s*([^=]+?)\s*=\s*([^】]+?)\s*】/gi
    let match
    while ((match = regexBracket.exec(msg.content)) !== null) {
      statusMap.set(match[1].trim(), match[2].trim())
    }
    while ((match = regexCJK.exec(msg.content)) !== null) {
      statusMap.set(match[1].trim(), match[2].trim())
    }
  }

  const iconMap: Record<string, typeof Heart> = {
    '好感': Heart,
    '好感度': Heart,
    '心情': Smile,
    '位置': MapPin,
    '地点': MapPin,
  }

  return Array.from(statusMap.entries()).map(([label, value]) => ({
    label,
    value,
    icon: iconMap[label] || Heart,
  }))
}

/**
 * 对话页顶部的状态条：只展示从 AI 回复里解析出的状态项。
 *
 * 勾选生效的世界书不在这里显示——世界书是「上下文配置」而不是对话内容，常驻展示
 * 会挤占正文首屏且与输入区快捷设置的勾选状态重复。需要确认当前勾选时看「对话快捷设置」
 * 的世界书分组即可。此前的世界书条也带来一次 `lorebook.list()` IPC 与全量列表解析，
 * 这里一并去掉。
 */
export function StatusBar({ messages }: StatusBarProps) {
  // P1 修复：useMemo 替代 useEffect+useState（省一次渲染周期，
  // 且仅在 messages 引用变化时重新解析状态）
  const statusItems = useMemo(() => parseStatusFromMessages(messages), [messages])

  if (statusItems.length === 0) return null

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-tavern-border-soft bg-tavern-bg-soft overflow-x-auto">
      {statusItems.map((item, i) => {
        const Icon = item.icon
        return (
          <div key={i} className="flex items-center gap-1.5 text-sm whitespace-nowrap">
            <Icon className="w-3.5 h-3.5 text-tavern-accent" />
            <span className="text-tavern-text-muted">{item.label}:</span>
            <span className="text-tavern-text-soft font-medium">{item.value}</span>
          </div>
        )
      })}
    </div>
  )
}
