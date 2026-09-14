import type { ReactNode } from 'react'
import {
  Brain,
  Image as ImageIcon,
  Languages,
  MessageSquareText,
  Sliders,
  Workflow,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { Toggle, SectionCard } from '../../components/common/SettingsShared'
import type { NarrativeMode, Settings } from '../../../shared/types'
import { NARRATIVE_MODE_OPTIONS, resolveNarrativeMode } from '../../../shared/narrativeMode'

interface BehaviorSectionProps {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
}

interface BehaviorGroupProps {
  icon: ReactNode
  title: string
  description: string
  children: ReactNode
}

function BehaviorGroup({ icon, title, description, children }: BehaviorGroupProps) {
  return (
    <section className="overflow-hidden rounded-2xl border border-tavern-border-soft bg-tavern-bg-soft/35">
      <div className="flex items-start gap-3 border-b border-tavern-border-soft bg-tavern-bg-card/45 px-4 py-3.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-tavern-accent/15 bg-tavern-accent-soft text-tavern-accent">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-tavern-text">{title}</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-tavern-text-muted">{description}</p>
        </div>
      </div>
      <div className="divide-y divide-tavern-border-soft px-4">{children}</div>
    </section>
  )
}

function ToggleSetting({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-5 py-3.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-tavern-text">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-tavern-text-muted">{description}</p>
      </div>
      <Toggle label={label} checked={checked} onChange={onChange} />
    </div>
  )
}

/** 显示与行为 */
export function BehaviorSection({ settings, updateSettings }: BehaviorSectionProps) {
  const narrativeMode = resolveNarrativeMode(settings.defaultNarrativeMode)
  const pipeline = settings.generationPipeline ?? 'unified'
  const blurStrength = settings.coverBlurStrength ?? 8

  return (
    <SectionCard title="显示与行为" icon={<Sliders className="h-4 w-4" />} storageKey="behavior">
      <div className="mt-3 grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <BehaviorGroup
          icon={<MessageSquareText className="h-4 w-4" />}
          title="对话体验"
          description="控制回复呈现、阅读跟随和新会话的记忆习惯"
        >
          <ToggleSetting
            label="流式输出"
            description="生成时逐步显示回复，减少等待感"
            checked={settings.streamOutput}
            onChange={(streamOutput) => updateSettings({ streamOutput })}
          />
          <ToggleSetting
            label="自动滚动"
            description="回复生成期间自动跟随到最新内容"
            checked={settings.autoScroll}
            onChange={(autoScroll) => updateSettings({ autoScroll })}
          />
          <ToggleSetting
            label="新建对话默认开启长记忆"
            description="新建单聊和群聊时每 10 条自动总结；已有会话不受影响"
            checked={settings.defaultMemoryEnabled ?? false}
            onChange={(defaultMemoryEnabled) => updateSettings({ defaultMemoryEnabled })}
          />
        </BehaviorGroup>

        <BehaviorGroup
          icon={<Brain className="h-4 w-4" />}
          title="角色表达"
          description="设置新会话的叙事视角、内心想法和翻译方式"
        >
          <div className="py-3.5">
            <div className="mb-2.5">
              <p className="text-sm font-medium text-tavern-text">新对话默认叙事模式</p>
              <p className="mt-0.5 text-xs text-tavern-text-muted">只影响之后创建的单聊</p>
            </div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="新对话默认叙事模式">
              {NARRATIVE_MODE_OPTIONS.map((option) => {
                const selected = narrativeMode === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-label={option.label}
                    aria-checked={selected}
                    onClick={() => updateSettings({ defaultNarrativeMode: option.value as NarrativeMode })}
                    className={cn(
                      'min-h-[76px] rounded-xl border px-3 py-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/50',
                      selected
                        ? 'border-tavern-accent/60 bg-tavern-accent-soft text-tavern-accent shadow-sm'
                        : 'border-tavern-border-soft bg-tavern-bg-card/45 text-tavern-text-soft hover:-translate-y-0.5 hover:border-tavern-border hover:bg-tavern-bg-hover/60',
                    )}
                  >
                    <span className="block text-xs font-semibold">{option.shortLabel}</span>
                    <span className="mt-1 block text-[10px] leading-relaxed text-tavern-text-muted">{option.description}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <ToggleSetting
            label="内心想法默认展开"
            description="自动展开角色第一人称内心独白区域"
            checked={settings.autoExpandThought ?? false}
            onChange={(autoExpandThought) => updateSettings({ autoExpandThought })}
          />
          <ToggleSetting
            label="朗读内心想法"
            description="开启后，TTS 会连同角色内心独白一起朗读"
            checked={settings.ttsReadThought ?? false}
            onChange={(ttsReadThought) => updateSettings({ ttsReadThought })}
          />
          <div className="flex items-center justify-between gap-5 py-3.5">
            <div className="min-w-0">
              <p className="inline-flex items-center gap-1.5 text-sm font-medium text-tavern-text">
                <Languages className="h-3.5 w-3.5 text-tavern-text-muted" />
                翻译目标语言
              </p>
              <p className="mt-0.5 text-xs text-tavern-text-muted">消息翻译功能默认使用的语言</p>
            </div>
            <select
              aria-label="翻译目标语言"
              value={settings.translationTargetLang || '中文'}
              onChange={(event) => updateSettings({ translationTargetLang: event.target.value })}
              className="input w-28 shrink-0 px-2 py-1.5 text-sm"
            >
              <option value="中文">中文</option>
              <option value="English">English</option>
              <option value="日本語">日本語</option>
              <option value="한국어">한국어</option>
              <option value="Français">Français</option>
              <option value="Deutsch">Deutsch</option>
              <option value="Español">Español</option>
              <option value="Русский">Русский</option>
            </select>
          </div>
        </BehaviorGroup>

        <BehaviorGroup
          icon={<Workflow className="h-4 w-4" />}
          title="生成兼容"
          description="G2 后默认新版管线；旧版仅保留一版读兼容，设置页不再提供切换"
        >
          <div className="py-3.5">
            {pipeline === 'legacy' ? (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-tavern-text">
                当前数据仍标记为旧版管线。请点下方切回新版；旧选项已从界面隐藏（W11）。
                <button
                  type="button"
                  className="mt-2 rounded-lg bg-tavern-accent/90 px-3 py-1.5 text-xs font-semibold text-white"
                  onClick={() => updateSettings({ generationPipeline: 'unified' })}
                >
                  切回新版管线
                </button>
              </div>
            ) : (
              <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-card/45 p-3 text-xs text-tavern-text-muted">
                已使用新版管线（动态预算、语义分块与稳定收尾）。旧版回退能力在本版本仍保留在数据层，但不再出现在界面。
              </div>
            )}
          </div>
        </BehaviorGroup>

        <BehaviorGroup
          icon={<ImageIcon className="h-4 w-4" />}
          title="封面效果"
          description="调整角色卡封面背景的景深和柔化程度"
        >
          <div className="py-3.5">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="cover-blur-strength" className="text-sm font-medium text-tavern-text">毛玻璃强度</label>
              <span className="rounded-md border border-tavern-border-soft bg-tavern-bg-card px-2 py-0.5 font-mono text-xs tabular-nums text-tavern-text-soft">
                {blurStrength}px
              </span>
            </div>
            <input
              id="cover-blur-strength"
              type="range"
              min="0"
              max="30"
              step="1"
              value={blurStrength}
              onChange={(event) => updateSettings({ coverBlurStrength: Number(event.target.value) })}
              className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-tavern-bg-hover accent-tavern-accent"
            />
            <div className="mt-3 grid grid-cols-4 gap-2">
              {[0, 8, 16, 24].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`封面毛玻璃 ${value === 0 ? '关闭' : `${value}px`}`}
                  onClick={() => updateSettings({ coverBlurStrength: value })}
                  className={cn(
                    'rounded-lg border px-2 py-1 text-xs transition-colors',
                    blurStrength === value
                      ? 'border-tavern-accent/60 bg-tavern-accent-soft text-tavern-accent'
                      : 'border-tavern-border-soft bg-tavern-bg-card/45 text-tavern-text-muted hover:border-tavern-border hover:text-tavern-text',
                  )}
                >
                  {value === 0 ? '关闭' : `${value}px`}
                </button>
              ))}
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-tavern-text-muted">设为 0 时完全关闭封面模糊效果。</p>
          </div>
        </BehaviorGroup>
      </div>
    </SectionCard>
  )
}
