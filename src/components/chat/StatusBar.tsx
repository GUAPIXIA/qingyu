import { useState, useEffect } from 'react'
import { Heart, MapPin, Smile } from 'lucide-react'
import type { Character, Message } from '../../../shared/types'

interface StatusBarProps {
  character: Character
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
    const regex = /(?:\[Status:|【状态:)\s*([^=]+?)\s*=\s*([^\]]+?)\s*(?:\]|】)/gi
    let match
    while ((match = regex.exec(msg.content)) !== null) {
      const key = match[1].trim()
      const value = match[2].trim()
      statusMap.set(key, value)
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

export function StatusBar({ character, messages }: StatusBarProps) {
  const [statusItems, setStatusItems] = useState<StatusItem[]>([])

  useEffect(() => {
    setStatusItems(parseStatusFromMessages(messages))
  }, [messages])

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
