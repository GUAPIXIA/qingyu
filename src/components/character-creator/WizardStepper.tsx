import { Sparkles, Image as ImageIcon, CheckCircle2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { CreatorStep } from '../../store/useCharacterCreatorStore'

const STEPS: { label: string; icon: typeof Sparkles }[] = [
  { label: '概念设定', icon: Sparkles },
  { label: '封面制作', icon: ImageIcon },
  { label: '预览保存', icon: CheckCircle2 },
]

interface WizardStepperProps {
  current: CreatorStep
  /** 已完成步骤可点击回退 */
  onStepClick: (step: CreatorStep) => void
}

export function WizardStepper({ current, onStepClick }: WizardStepperProps) {
  return (
    <div className="flex items-center gap-1 sm:gap-2">
      {STEPS.map((s, i) => {
        const Icon = s.icon
        const isCurrent = i === current
        const isDone = i < current
        const clickable = isDone || isCurrent
        return (
          <div key={s.label} className="flex items-center gap-1 sm:gap-2">
            {i > 0 && (
              <div
                className={cn(
                  'h-0.5 w-4 sm:w-10 rounded-full transition-colors',
                  i <= current ? 'bg-tavern-accent' : 'bg-tavern-border',
                )}
              />
            )}
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onStepClick(i as CreatorStep)}
              className={cn(
                'flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-full text-xs font-medium transition-all',
                isCurrent && 'bg-tavern-accent text-white shadow-sm shadow-tavern-accent/40',
                isDone && 'text-tavern-accent hover:bg-tavern-accent-soft cursor-pointer',
                !isDone && !isCurrent && 'text-tavern-text-muted bg-tavern-bg-soft',
              )}
              title={isDone ? `回到「${s.label}」` : s.label}
            >
              <Icon className={cn('w-3.5 h-3.5', isDone && !isCurrent && 'fill-current')} />
              <span className="hidden md:inline">{s.label}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
