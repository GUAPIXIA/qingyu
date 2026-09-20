import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

const SETTINGS_SECTION_STATE_KEY = 'settings-section-open-state-v1'

type SectionOpenState = Record<string, boolean>

function readSectionOpenState(): SectionOpenState {
  try {
    const raw = localStorage.getItem(SETTINGS_SECTION_STATE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as SectionOpenState
  } catch {
    return {}
  }
}

function writeSectionOpenState(storageKey: string, open: boolean): void {
  try {
    const state = readSectionOpenState()
    localStorage.setItem(SETTINGS_SECTION_STATE_KEY, JSON.stringify({ ...state, [storageKey]: open }))
  } catch {
    // localStorage 不可用时仍保留当前会话内的折叠交互。
  }
}

/** 折叠卡片 */
export function SectionCard({
  title,
  icon,
  defaultOpen = true,
  storageKey,
  children,
}: {
  title: string
  icon: React.ReactNode
  defaultOpen?: boolean
  /** 稳定的设置分区标识；提供后会在本机保留展开/折叠状态。 */
  storageKey?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(() => {
    if (!storageKey) return defaultOpen
    const persisted = readSectionOpenState()[storageKey]
    return typeof persisted === 'boolean' ? persisted : defaultOpen
  })

  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current
      if (storageKey) writeSectionOpenState(storageKey, next)
      return next
    })
  }

  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggleOpen}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-tavern-bg-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-tavern-accent">{icon}</span>
          <h2 className="font-display text-base font-semibold">{title}</h2>
        </div>
        <ChevronDown
          className={cn('w-4 h-4 text-tavern-text-muted transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && <div className="px-4 pb-4 pt-1 border-t border-tavern-border-soft">{children}</div>}
    </section>
  )
}

/** 开关 */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'toggle-track relative inline-flex h-5 w-9 items-center rounded-full',
        checked ? 'bg-tavern-accent' : 'bg-tavern-bg-hover'
      )}
    >
      <span
        className={cn(
          'toggle-thumb inline-block h-4 w-4 transform rounded-full bg-white shadow',
          checked ? 'translate-x-4' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

/** 选项按钮组 */
export function OptionGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; render?: () => React.ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-3 py-1.5 rounded-md text-sm border transition-colors',
            value === opt.value
              ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
              : 'border-tavern-border bg-tavern-bg hover:bg-tavern-bg-hover text-tavern-text-soft'
          )}
        >
          {opt.render ? opt.render() : opt.label}
        </button>
      ))}
    </div>
  )
}
