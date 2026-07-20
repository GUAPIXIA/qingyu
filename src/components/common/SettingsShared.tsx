import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/** 折叠卡片 */
export function SectionCard({
  title,
  icon,
  defaultOpen = true,
  children,
}: {
  title: string
  icon: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
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
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
        checked ? 'bg-tavern-accent' : 'bg-tavern-bg-hover'
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
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
