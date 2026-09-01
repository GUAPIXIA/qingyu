import { Sliders } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Toggle, SectionCard } from '../../components/common/SettingsShared'
import type { Settings } from '../../../shared/types'

interface BehaviorSectionProps {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
}

/** 显示与行为 */
export function BehaviorSection(props: BehaviorSectionProps) {
  const { settings, updateSettings } = props
  return (
    <>
        <SectionCard title="显示与行为" icon={<Sliders className="w-4 h-4" />} storageKey="behavior">
          <div className="mt-3 space-y-4">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">流式输出</p>
                <p className="text-xs text-tavern-text-muted">逐字输出 AI 回复，提升响应体验</p>
              </div>
              <Toggle
                checked={settings.streamOutput}
                onChange={(v) => updateSettings({ streamOutput: v })}
              />
            </div>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">自动滚动</p>
                <p className="text-xs text-tavern-text-muted">流式输出时自动滚动到底部</p>
              </div>
              <Toggle
                checked={settings.autoScroll}
                onChange={(v) => updateSettings({ autoScroll: v })}
              />
            </div>

            <div className="flex items-center justify-between gap-4 py-1">
              <div>
                <p className="text-sm">新建对话默认开启长记忆</p>
                <p className="text-xs text-tavern-text-muted">
                  新建单聊和群聊时启用自动长记忆（每 10 条总结），已有会话不受影响
                </p>
              </div>
              <Toggle
                label="新建对话默认开启长记忆"
                checked={settings.defaultMemoryEnabled ?? false}
                onChange={(v) => updateSettings({ defaultMemoryEnabled: v })}
              />
            </div>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">内心想法默认展开</p>
                <p className="text-xs text-tavern-text-muted">消息中的心理描写区域是否默认展开显示</p>
              </div>
              <Toggle
                checked={settings.autoExpandThought ?? false}
                onChange={(v) => updateSettings({ autoExpandThought: v })}
              />
            </div>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">朗读内心想法</p>
                <p className="text-xs text-tavern-text-muted">TTS 朗读时是否朗读消息中的心理描写（关闭则只读对话和行动）</p>
              </div>
              <Toggle
                checked={settings.ttsReadThought ?? false}
                onChange={(v) => updateSettings({ ttsReadThought: v })}
              />
            </div>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">翻译目标语言</p>
                <p className="text-xs text-tavern-text-muted">消息翻译功能的目标语言</p>
              </div>
              <select
                value={settings.translationTargetLang || '中文'}
                onChange={(e) => updateSettings({ translationTargetLang: e.target.value })}
                className="input text-sm py-1 px-2 w-28"
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

            {/* B-05：封面毛玻璃模糊强度 */}
            <div>
              <label className="label">
                <span className="inline-flex items-center gap-1.5">
                  封面毛玻璃强度
                </span>
                <span className="text-xs text-tavern-text-muted ml-2">{settings.coverBlurStrength ?? 8}px</span>
              </label>
              <input
                type="range"
                min="0"
                max="30"
                step="1"
                value={settings.coverBlurStrength ?? 8}
                onChange={(e) => updateSettings({ coverBlurStrength: Number(e.target.value) })}
                className="w-full accent-tavern-accent mt-1"
              />
              <div className="flex gap-2 mt-1.5">
                {[0, 8, 16, 24].map(v => (
                  <button
                    key={v}
                    className={cn(
                      'px-2.5 py-0.5 text-xs rounded border transition-colors',
                      (settings.coverBlurStrength ?? 8) === v
                        ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                        : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                    )}
                    onClick={() => updateSettings({ coverBlurStrength: v })}
                  >
                    {v === 0 ? '关闭' : `${v}px`}
                  </button>
                ))}
              </div>
              <p className="text-xs text-tavern-text-muted mt-1">角色卡封面毛玻璃效果的模糊强度，0 = 禁用</p>
            </div>
          </div>
        </SectionCard>
    </>
  )
}
