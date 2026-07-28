import { useState, useEffect, useMemo } from 'react'
import { Heart, MapPin, Smile, BookOpen, Lock } from 'lucide-react'
import { useChatStore } from '../../store/useChatStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { getEffectiveLorebookIds } from '../../utils/lorebook'
import { logError } from '../../lib/logger'
import type { Character, Message, Lorebook } from '../../../shared/types'

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

export function StatusBar({ character, messages }: StatusBarProps) {
  const [statusItems, setStatusItems] = useState<StatusItem[]>([])
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])
  const activeLorebookIds = useChatStore(s => s.activeLorebookIds)
  const currentCharacter = useCharacterStore(s => s.currentCharacter)

  useEffect(() => {
    setStatusItems(parseStatusFromMessages(messages))
  }, [messages])

  // 加载世界书列表：角色切换 或 激活数量变化时重新加载
  useEffect(() => {
    window.api.lorebook.list().then(setLorebooks).catch((e) => logError('StatusBar:loadLorebooks', e))
  }, [character.id, activeLorebookIds.length])

  // 角色绑定的世界书 ID
  const boundLorebookIds = useMemo(() => {
    return getEffectiveLorebookIds(currentCharacter)
  }, [currentCharacter?.boundLorebookIds, currentCharacter?.lorebookId])

  // 解析激活的世界书名称
  const activeLorebookNames = useMemo(() => {
    return activeLorebookIds
      .map(id => {
        const lb = lorebooks.find(l => l.id === id)
        return lb ? { id, name: lb.name, isBound: boundLorebookIds.includes(id) } : null
      })
      .filter(Boolean) as { id: string; name: string; isBound: boolean }[]
  }, [activeLorebookIds, boundLorebookIds, lorebooks])

  if (statusItems.length === 0 && activeLorebookNames.length === 0) return null

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-tavern-border-soft bg-tavern-bg-soft overflow-x-auto">
      {/* 激活的世界书 — 直接可见，绑定世界书带锁图标 */}
      {activeLorebookNames.map(lb => (
        <div key={lb.id} className="flex items-center gap-1 text-xs whitespace-nowrap">
          {lb.isBound ? (
            <Lock className="w-3 h-3 text-tavern-accent" />
          ) : (
            <BookOpen className="w-3 h-3 text-tavern-text-muted" />
          )}
          <span className={lb.isBound ? 'text-tavern-accent font-medium' : 'text-tavern-text-muted'}>
            {lb.name}
          </span>
        </div>
      ))}
      {/* 状态项分隔符 */}
      {activeLorebookNames.length > 0 && statusItems.length > 0 && (
        <span className="w-px h-4 bg-tavern-border-soft" />
      )}
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
