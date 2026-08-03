import { Loader2, Check, Sun, Moon, Monitor, Type, Upload as UploadIcon, Trash2, Maximize2, AlignJustify, Palette } from 'lucide-react'
import { SectionCard, OptionGroup } from '../../components/common/SettingsShared'
import { THEME_COLORS, BUILTIN_FONTS } from '../../utils/defaults'
import { cn } from '../../lib/utils'
import type { Settings, CustomFont } from '../../../shared/types'

interface AppearanceSectionProps {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
  customFonts: CustomFont[]
  fontUploading: boolean
  fontError: string | null
  handleUploadFont: () => void
  handleApplyCustomFont: (font: CustomFont) => void
  handleDeleteFont: (id: string) => void
}

/** 外观设置(字体 / 主题 / 气泡样式 / 消息宽度间距 + 预览) */
export function AppearanceSection(props: AppearanceSectionProps) {
  const { settings, updateSettings, customFonts, fontUploading, fontError, handleUploadFont, handleApplyCustomFont, handleDeleteFont } = props
  return (
        <SectionCard title="外观设置" icon={<Palette className="w-4 h-4" />}>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* 左列 */}
            <div className="space-y-5">
              {/* 对话字体 */}
              <div>
                <label className="label">
                  <span className="inline-flex items-center gap-1.5">
                    <Type className="w-3.5 h-3.5" />对话字体
                  </span>
                </label>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {BUILTIN_FONTS.map(font => {
                    const active = (settings.fontFamily ?? 'system') === font.value && !settings.customFontId
                    return (
                      <button
                        key={font.value}
                        onClick={() => updateSettings({ fontFamily: font.value, customFontId: null })}
                        className={cn(
                          'px-3 py-2 rounded-lg text-sm border transition-all text-left',
                          active
                            ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                            : 'border-tavern-border bg-tavern-bg hover:bg-tavern-bg-hover text-tavern-text-soft'
                        )}
                        style={{ fontFamily: font.family }}
                      >
                        <div className="font-medium">{font.label}</div>
                        <div className="text-xs opacity-70 mt-0.5">{font.preview}</div>
                      </button>
                    )
                  })}
                </div>

                {/* 自定义字体区 */}
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleUploadFont}
                      disabled={fontUploading}
                      className="btn-secondary text-xs py-1.5"
                    >
                      {fontUploading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <UploadIcon className="w-3.5 h-3.5" />
                      )}
                      上传字体（TTF/OTF）
                    </button>
                    <span className="text-xs text-tavern-text-muted">最大 10MB</span>
                  </div>

                  {fontError && (
                    <p className="text-xs text-tavern-danger">{fontError}</p>
                  )}

                  {customFonts.length > 0 && (
                    <div className="space-y-1.5">
                      {customFonts.map(font => {
                        const active = settings.customFontId === font.id
                        return (
                          <div
                            key={font.id}
                            className={cn(
                              'flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-colors',
                              active
                                ? 'border-tavern-accent bg-tavern-accent-soft'
                                : 'border-tavern-border-soft bg-tavern-bg hover:bg-tavern-bg-hover'
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-tavern-text truncate">
                                {font.name}
                              </div>
                              <div className="text-[10px] text-tavern-text-muted">
                                {font.format.toUpperCase()} · {(font.size / 1024).toFixed(0)}KB
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {!active && (
                                <button
                                  onClick={() => handleApplyCustomFont(font)}
                                  className="px-2 py-0.5 text-[10px] rounded bg-tavern-accent-soft text-tavern-accent hover:bg-tavern-accent/20 transition-colors"
                                >
                                  应用
                                </button>
                              )}
                              {active && (
                                <span className="text-[10px] text-tavern-accent flex items-center gap-0.5">
                                  <Check className="w-3 h-3" />使用中
                                </span>
                              )}
                              <button
                                onClick={() => handleDeleteFont(font.id)}
                                className="p-1 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors"
                                title="删除字体"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* 主题模式 */}
              <div>
                <label className="label">主题模式</label>
                <OptionGroup<Settings['theme']>
                  value={settings.theme}
                  onChange={(v) => updateSettings({ theme: v })}
                  options={[
                    { value: 'dark', label: '深色', render: () => <span className="inline-flex items-center gap-1"><Moon className="w-3.5 h-3.5" />深色</span> },
                    { value: 'light', label: '浅色', render: () => <span className="inline-flex items-center gap-1"><Sun className="w-3.5 h-3.5" />浅色</span> },
                    { value: 'system', label: '跟随系统', render: () => <span className="inline-flex items-center gap-1"><Monitor className="w-3.5 h-3.5" />跟随</span> },
                  ]}
                />
              </div>

              {/* 主题色 - 色块按钮 */}
              <div>
                <label className="label">主题色</label>
                <div className="flex flex-wrap gap-2.5">
                  {(Object.keys(THEME_COLORS) as Array<keyof typeof THEME_COLORS>).map((key) => {
                    const c = THEME_COLORS[key]
                    const active = settings.themeColor === key
                    return (
                      <button
                        key={key}
                        onClick={() => updateSettings({ themeColor: key })}
                        className={cn(
                          'relative w-10 h-10 rounded-xl border-2 transition-all duration-200 flex items-center justify-center',
                          active
                            ? 'border-white/80 scale-110 shadow-lg shadow-black/30'
                            : 'border-transparent hover:scale-105 hover:border-white/30'
                        )}
                        style={{ backgroundColor: c.color }}
                        title={c.name}
                      >
                        {active && <Check className="w-4 h-4 text-white drop-shadow" />}
                      </button>
                    )
                  })}
                </div>
                <p className="text-xs text-tavern-text-muted mt-1.5">
                  {THEME_COLORS[settings.themeColor].name}
                </p>
              </div>

              {/* 字体大小 */}
              <div>
                <label className="label">字体大小</label>
                <OptionGroup<Settings['fontSize']>
                  value={settings.fontSize}
                  onChange={(v) => updateSettings({ fontSize: v })}
                  options={[
                    { value: 'compact', label: '小' },
                    { value: 'comfortable', label: '中' },
                    { value: 'loose', label: '大' },
                    { value: 'custom', label: '自定义' },
                  ]}
                />
              </div>

              {/* 自定义字号滑块 */}
              {settings.fontSize === 'custom' && (
                <div className="flex items-center gap-3 px-1">
                  <span className="text-xs text-tavern-text-muted w-6 text-right">
                    {settings.fontSizeCustom || 16}
                  </span>
                  <input
                    type="range"
                    min="10"
                    max="26"
                    step="1"
                    value={settings.fontSizeCustom || 16}
                    onChange={(e) => updateSettings({ fontSizeCustom: Number(e.target.value) })}
                    className="flex-1 h-1.5 rounded-full appearance-none bg-tavern-bg-hover cursor-pointer accent-tavern-accent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-tavern-accent"
                  />
                  <span className="text-xs text-tavern-text-muted">26</span>
                </div>
              )}
            </div>

            {/* 右列 */}
            <div className="space-y-5">
              {/* 气泡样式 */}
              <div>
                <label className="label">气泡样式</label>
                <OptionGroup<Settings['bubbleStyle']>
                  value={settings.bubbleStyle}
                  onChange={(v) => updateSettings({ bubbleStyle: v })}
                  options={[
                    { value: 'round', label: '圆润' },
                    { value: 'standard', label: '标准' },
                    { value: 'sharp', label: '直角' },
                  ]}
                />
              </div>

              {/* 消息宽度 */}
              <div>
                <label className="label">
                  <span className="inline-flex items-center gap-1.5">
                    <Maximize2 className="w-3.5 h-3.5" />消息宽度
                  </span>
                  <span className="text-xs text-tavern-text-muted ml-2">{settings.messageWidth ?? 768}px</span>
                </label>
                <input
                  type="range"
                  min="400"
                  max="1200"
                  step="8"
                  value={settings.messageWidth ?? 768}
                  onChange={(e) => updateSettings({ messageWidth: Number(e.target.value) })}
                  className="w-full accent-tavern-accent mt-1"
                />
                <div className="flex gap-2 mt-1.5">
                  {[480, 768, 1024].map(v => (
                    <button
                      key={v}
                      className={cn(
                        'px-2.5 py-0.5 text-xs rounded border transition-colors',
                        (settings.messageWidth ?? 768) === v
                          ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                          : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                      )}
                      onClick={() => updateSettings({ messageWidth: v })}
                    >
                      {v === 480 ? '紧凑' : v === 768 ? '标准' : '宽屏'} {v}px
                    </button>
                  ))}
                </div>
              </div>

              {/* 消息间距 */}
              <div>
                <label className="label">
                  <span className="inline-flex items-center gap-1.5">
                    <AlignJustify className="w-3.5 h-3.5" />消息间距
                  </span>
                  <span className="text-xs text-tavern-text-muted ml-2">{settings.messageSpacing}px</span>
                </label>
                <input
                  type="range"
                  min="4"
                  max="60"
                  step="2"
                  value={settings.messageSpacing}
                  onChange={(e) => updateSettings({ messageSpacing: Number(e.target.value) })}
                  className="w-full accent-tavern-accent mt-1"
                />
                <div className="flex gap-2 mt-1.5">
                  {[8, 20, 36].map(v => (
                    <button
                      key={v}
                      className={cn(
                        'px-2.5 py-0.5 text-xs rounded border transition-colors',
                        settings.messageSpacing === v
                          ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                          : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                      )}
                      onClick={() => updateSettings({ messageSpacing: v })}
                    >
                      {v === 8 ? '紧凑' : v === 20 ? '标准' : '宽松'} {v}px
                    </button>
                  ))}
                </div>
              </div>

              {/* 预览示意图：模拟真实对话窗格，实时反映圆角/宽度/间距 */}
              <div className="rounded-lg border border-tavern-border-soft bg-tavern-bg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-tavern-bg-hover border-b border-tavern-border-soft">
                  <p className="text-xs text-tavern-text-muted font-medium">气泡预览</p>
                  <span className="text-[10px] text-tavern-text-muted/70">
                    宽度 {(settings.messageWidth ?? 768)}px · 间距 {settings.messageSpacing}px
                  </span>
                </div>
                <div className="p-3 bg-[var(--color-bg)]/40">
                  {/* 消息宽度：按 400-1200 范围映射为容器百分比，滑杆变化直观可见 */}
                  {(() => {
                    const w = Math.min(Math.max(settings.messageWidth ?? 768, 400), 1200)
                    const pct = Math.max(55, Math.min(100, Math.round((w / 1200) * 100)))
                    const spacing = settings.messageSpacing ?? 20
                    const bubbleStyle = settings.bubbleStyle ?? 'standard'
                    const bubbleRadius = bubbleStyle === 'round' ? 'rounded-2xl'
                      : bubbleStyle === 'sharp' ? 'rounded-sm'
                      : 'rounded-lg'
                    const aiBubble = cn(
                      'msg-bubble px-4 py-2 text-sm shadow-sm',
                      bubbleRadius,
                      'bg-tavern-bg-card border border-tavern-border rounded-bl-sm text-slate-900 dark:text-slate-100'
                    )
                    const userBubble = cn(
                      'msg-bubble px-4 py-2 text-sm shadow-md',
                      bubbleRadius,
                      'bg-gradient-to-bl from-amber-100 to-orange-50 border border-amber-200/60 rounded-br-sm text-amber-950 dark:from-amber-900/70 dark:to-orange-900/70 dark:border-amber-700/60 dark:text-amber-50'
                    )
                    return (
                      <div className="space-y-0">
                        <div className="mx-auto flex" style={{ maxWidth: `${pct}%`, marginBottom: `${spacing}px` }}>
                          <div className={aiBubble}>
                            她抬起头，轻声笑了笑。<br />
                            「你真的这样想吗？」
                          </div>
                        </div>
                        <div className="mx-auto flex flex-row-reverse" style={{ maxWidth: `${pct}%`, marginBottom: `${spacing}px` }}>
                          <div className={userBubble}>
                            是的，我确定。我们明天就出发。
                          </div>
                        </div>
                        <div className="mx-auto flex" style={{ maxWidth: `${pct}%`, marginBottom: 0 }}>
                          <div className={aiBubble}>
                            那好，我先去准备行李。
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>
            </div>
          </div>
        </SectionCard>


  )
}
