import { Globe2, RotateCcw } from 'lucide-react'
import type { Settings } from '../../../shared/types'
import { DEFAULT_OMNISCIENT_NARRATIVE_RULES } from '../../../shared/narrativeMode'
import { cn } from '../../lib/utils'
import { SectionCard } from '../../components/common/SettingsShared'

interface Props {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
}

const MAX_RULE_LENGTH = 6000

/** 编辑全局共享的模式 2 行为规则；身份页是用户角色与叙事控制权的统一入口。 */
export function GlobalNarrativeRulesSection({ settings, updateSettings }: Props) {
  const customRules = settings.omniscientNarrativeRules
  const value = typeof customRules === 'string' ? customRules : DEFAULT_OMNISCIENT_NARRATIVE_RULES
  const isDefault = typeof customRules !== 'string' || !customRules.trim()

  return (
    <SectionCard title="全局叙事规则" icon={<Globe2 className="h-4 w-4" />} storageKey="omniscient-narrative-rules">
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="max-w-xl">
            <p className="text-sm text-tavern-text">定义 AI 在全局叙事模式下的控制范围与世界推进方式。</p>
            <p className="mt-1 text-xs leading-relaxed text-tavern-text-muted">
              第三人称旁白视角是固定边界；此处规则用于补充叙事偏好。可使用 <code className="text-tavern-accent">{'{{user}}'}</code> 表示当前身份，
              <code className="text-tavern-accent">{'{{char}}'}</code> 表示当前角色。
            </p>
          </div>
          <span className={cn(
            'rounded-full border px-2 py-1 text-[10px] font-medium',
            isDefault
              ? 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-muted'
              : 'border-tavern-accent/25 bg-tavern-accent-soft text-tavern-accent',
          )}>
            {isDefault ? '内置规则' : '自定义规则'}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-tavern-border-soft bg-tavern-bg/60 transition-colors focus-within:border-tavern-accent/60 focus-within:ring-2 focus-within:ring-tavern-accent/10">
          <textarea
            aria-label="全局叙事规则"
            value={value}
            maxLength={MAX_RULE_LENGTH}
            rows={10}
            spellCheck={false}
            onChange={(event) => updateSettings({ omniscientNarrativeRules: event.target.value })}
            className="block w-full resize-y bg-transparent px-3.5 py-3 font-mono text-xs leading-relaxed text-tavern-text outline-none placeholder:text-tavern-text-muted"
            placeholder="输入全局叙事规则；留空时使用内置规则"
          />
          <div className="flex items-center justify-between border-t border-tavern-border-soft px-3 py-2">
            <span className="text-[10px] text-tavern-text-muted">{value.length} / {MAX_RULE_LENGTH}</span>
            <button
              type="button"
              disabled={isDefault}
              onClick={() => updateSettings({ omniscientNarrativeRules: undefined })}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-tavern-text-muted transition-colors hover:bg-tavern-bg-hover hover:text-tavern-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              恢复默认规则
            </button>
          </div>
        </div>

        <p className="text-[10px] leading-relaxed text-tavern-text-muted">
          修改会自动保存，并从下一次全局叙事回复开始生效；已有消息不会被改写。
        </p>
      </div>
    </SectionCard>
  )
}
