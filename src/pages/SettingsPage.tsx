import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore } from '../store/useSettingsStore'
import { THEME_COLORS, BUILTIN_FONTS, getDefaultSettings } from '../utils/defaults'
import { cn } from '../lib/utils'
import { SectionCard, Toggle, OptionGroup } from '../components/common/SettingsShared'
import type { Settings, CustomFont } from '../../shared/types'
import {
  Settings as SettingsIcon,
  Palette,
  Database,
  Sliders,
  Loader2,
  Check,
  Sun,
  Moon,
  Monitor,
  Download,
  Upload,
  AlignJustify,
  Maximize2,
  Plug,
  ExternalLink,
  Globe,
  Type,
  Upload as UploadIcon,
  Trash2,
  StickyNote,
  Brain,
  UserRound,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'

export function SettingsPage() {
  const { settings, updateSettings } = useSettingsStore()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([])
  const [fontUploading, setFontUploading] = useState(false)
  const [fontError, setFontError] = useState<string | null>(null)
  /** 语义触发：测试连接状态 */
  const [embedTestBusy, setEmbedTestBusy] = useState(false)
  const [embedTestResult, setEmbedTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  // 加载自定义字体列表
  const loadCustomFonts = useCallback(async () => {
    try {
      const fonts = await window.api.font.listFonts()
      setCustomFonts(fonts)
    } catch {
      // 忽略
    }
  }, [])

  useEffect(() => {
    loadCustomFonts()
  }, [loadCustomFonts])

  /** 上传字体文件 */
  const handleUploadFont = async () => {
    setFontError(null)
    setFontUploading(true)
    try {
      const filePath = await window.api.font.selectFont()
      if (!filePath) {
        setFontUploading(false)
        return
      }
      const fontInfo = await window.api.font.saveFont(filePath)
      // 自动应用新字体
      updateSettings({ fontFamily: fontInfo.name, customFontId: fontInfo.id })
      await loadCustomFonts()
    } catch (e) {
      setFontError(e instanceof Error ? e.message : '字体上传失败')
    } finally {
      setFontUploading(false)
    }
  }

  /** 删除自定义字体 */
  const handleDeleteFont = async (id: string) => {
    setFontError(null)
    try {
      await window.api.font.deleteFont(id)
      // 如果正在使用该字体，回退系统默认
      if (settings.customFontId === id) {
        updateSettings({ fontFamily: 'system', customFontId: null })
      }
      await loadCustomFonts()
    } catch (e) {
      setFontError(e instanceof Error ? e.message : '字体删除失败')
    }
  }

  /** 应用自定义字体 */
  const handleApplyCustomFont = (font: CustomFont) => {
    updateSettings({ fontFamily: font.name, customFontId: font.id })
  }

  /** 测试嵌入服务连接 */
  const handleEmbedTest = async () => {
    const st = settings.semanticTrigger
    if (!st) return
    setEmbedTestBusy(true)
    setEmbedTestResult(null)
    try {
      const result = await window.api.embedding.test({
        provider: st.provider,
        baseUrl: st.baseUrl,
        model: st.model,
        apiKey: st.apiKey ?? '',
      })
      setEmbedTestResult(result.ok
        ? { ok: true, text: `连接成功，向量维度 ${result.dim}` }
        : { ok: false, text: result.error || '连接失败' })
    } catch (e) {
      setEmbedTestResult({ ok: false, text: (e as Error).message })
    } finally {
      setEmbedTestBusy(false)
    }
  }

  /** 导出备份 */
  const handleExport = async () => {
    setBusy('export')
    try {
      await window.api.settings.exportBackup()
    } finally {
      setBusy(null)
    }
  }

  /** 导入备份 */
  const handleImport = async () => {
    setBusy('import')
    setImportMsg(null)
    try {
      await window.api.settings.importBackup()
      setImportMsg({ ok: true, text: '导入成功，正在刷新...' })
      // 重新加载设置以反映导入的数据
      await useSettingsStore.getState().loadSettings()
    } catch (err) {
      setImportMsg({
        ok: false,
        text: err instanceof Error ? err.message : '导入失败',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-tavern-accent" />
          <h1 className="font-display text-lg font-bold">设置</h1>
        </div>
      </header>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* API 设置入口 */}
        <SectionCard title="API 设置" icon={<Plug className="w-4 h-4" />} defaultOpen={false}>
          <div className="mt-3">
            <p className="text-sm text-tavern-text-muted mb-3">
              管理对话 API 连接、TTS 语音合成、文本生图和识图模型配置
            </p>
            <button
              onClick={() => navigate('/api')}
              className="btn-secondary inline-flex items-center gap-1.5 text-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              打开 API 设置
            </button>
          </div>
        </SectionCard>

        {/* B. 外观设置 */}
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

        {/* D. 显示与行为 */}
        <SectionCard title="显示与行为" icon={<Sliders className="w-4 h-4" />}>
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

        {/* 作者注释 */}
        <SectionCard title="作者注释" icon={<StickyNote className="w-4 h-4" />}>
          <div className="mt-3 space-y-4">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">启用作者注释</p>
                <p className="text-xs text-tavern-text-muted">在上下文中注入浮动注释（Author's Note），持续引导对话方向</p>
              </div>
              <Toggle
                checked={settings.authorNote?.enabled ?? false}
                onChange={(v) => updateSettings({
                  authorNote: {
                    ...(settings.authorNote ?? { enabled: false, text: '', position: 'middle', depth: 1 }),
                    enabled: v,
                  },
                })}
              />
            </div>
            {settings.authorNote?.enabled && (
              <>
                <div>
                  <label className="label">注释内容</label>
                  <textarea
                    className="input min-h-[80px] w-full"
                    placeholder="例：主角正在寻找失踪的妹妹，请记住这个目标并推动剧情发展…"
                    value={settings.authorNote.text ?? ''}
                    onChange={(e) => updateSettings({
                      authorNote: { ...settings.authorNote!, text: e.target.value },
                    })}
                  />
                  <p className="text-xs text-tavern-text-muted mt-1">支持 {'{{char}}'} / {'{{user}}'} 变量替换</p>
                </div>
                <div>
                  <label className="label">注入位置</label>
                  <select
                    className="select"
                    value={settings.authorNote.position}
                    onChange={(e) => updateSettings({
                      authorNote: {
                        ...settings.authorNote!,
                        position: e.target.value as 'top' | 'middle' | 'bottom',
                      },
                    })}
                  >
                    <option value="top">系统提示之后</option>
                    <option value="middle">历史消息中（按深度）</option>
                    <option value="bottom">历史消息末尾</option>
                  </select>
                </div>
                {settings.authorNote.position === 'middle' && (
                  <div>
                    <label className="label">注入深度（0 = 最新消息前）</label>
                    <input
                      type="number"
                      min={0}
                      className="input"
                      value={settings.authorNote.depth ?? 1}
                      onChange={(e) => updateSettings({
                        authorNote: {
                          ...settings.authorNote!,
                          depth: Math.max(0, Number(e.target.value) || 0),
                        },
                      })}
                    />
                    <p className="text-xs text-tavern-text-muted mt-1">0 = 最新消息之前（对话末尾上方），1 = 倒数第二条消息之前，依此类推</p>
                  </div>
                )}
              </>
            )}
          </div>
        </SectionCard>

        {/* 用户人设注入 */}
        <SectionCard title="用户人设注入" icon={<UserRound className="w-4 h-4" />}>
          <div className="mt-3 space-y-4">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">注入用户人设</p>
                <p className="text-xs text-tavern-text-muted">将用户名/描述/性格注入模型上下文（关闭后仅保留 {'{{user}}'} 变量替换）</p>
              </div>
              <Toggle
                checked={settings.personaInjection?.enabled ?? true}
                onChange={(v) => updateSettings({
                  personaInjection: {
                    ...(settings.personaInjection ?? { position: 'system', includeDescription: true, includePersona: true }),
                    enabled: v,
                  },
                })}
              />
            </div>

            {(settings.personaInjection?.enabled ?? true) && (
              <>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm">注入位置</p>
                    <p className="text-xs text-tavern-text-muted">system = 拼入系统提示词（默认）；separate = 独立系统消息</p>
                  </div>
                  <select
                    className="input text-sm py-1 px-2 w-36"
                    value={settings.personaInjection?.position ?? 'system'}
                    onChange={(e) => updateSettings({
                      personaInjection: {
                        ...(settings.personaInjection ?? { enabled: true, includeDescription: true, includePersona: true }),
                        position: e.target.value as 'system' | 'separate',
                      },
                    })}
                  >
                    <option value="system">系统提示内</option>
                    <option value="separate">独立系统消息</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-[var(--color-accent)]"
                      checked={settings.personaInjection?.includeDescription ?? true}
                      onChange={(e) => updateSettings({
                        personaInjection: {
                          ...(settings.personaInjection ?? { enabled: true, position: 'system', includePersona: true }),
                          includeDescription: e.target.checked,
                        },
                      })}
                    />
                    <span className="text-sm">注入用户描述</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-[var(--color-accent)]"
                      checked={settings.personaInjection?.includePersona ?? true}
                      onChange={(e) => updateSettings({
                        personaInjection: {
                          ...(settings.personaInjection ?? { enabled: true, position: 'system', includeDescription: true }),
                          includePersona: e.target.checked,
                        },
                      })}
                    />
                    <span className="text-sm">注入用户性格</span>
                  </label>
                </div>
              </>
            )}
          </div>
        </SectionCard>

        {/* 语义触发（向量 RAG） */}
        <SectionCard title="语义触发" icon={<Brain className="w-4 h-4" />}>
          <div className="mt-3 space-y-4">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">启用语义触发</p>
                <p className="text-xs text-tavern-text-muted">
                  世界书条目按语义相似度触发（如“猫娘”可触发含“猫咪”的条目）。需先为世界书生成向量索引
                </p>
              </div>
              <Toggle
                checked={settings.semanticTrigger?.enabled ?? false}
                onChange={(v) => updateSettings({
                  semanticTrigger: {
                    ...(settings.semanticTrigger ?? { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', apiKey: '', threshold: 0.3, maxResults: 3 }),
                    enabled: v,
                  },
                })}
              />
            </div>

            {settings.semanticTrigger?.enabled && (
              <>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm">嵌入服务</p>
                    <p className="text-xs text-tavern-text-muted">本地推荐 Ollama（免费），也可用 OpenAI 兼容 embeddings 服务</p>
                  </div>
                  <select
                    className="input text-sm py-1 px-2 w-32"
                    value={settings.semanticTrigger.provider}
                    onChange={(e) => updateSettings({
                      semanticTrigger: {
                        ...settings.semanticTrigger!,
                        provider: e.target.value as 'openai' | 'ollama',
                      },
                    })}
                  >
                    <option value="ollama">Ollama（本地）</option>
                    <option value="openai">OpenAI 兼容</option>
                  </select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="label">Base URL</label>
                    <input
                      type="text"
                      className="input text-sm"
                      placeholder={settings.semanticTrigger.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'}
                      value={settings.semanticTrigger.baseUrl}
                      onChange={(e) => updateSettings({
                        semanticTrigger: { ...settings.semanticTrigger!, baseUrl: e.target.value.trim() },
                      })}
                    />
                  </div>
                  <div>
                    <label className="label">模型</label>
                    <input
                      type="text"
                      className="input text-sm"
                      placeholder={settings.semanticTrigger.provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small'}
                      value={settings.semanticTrigger.model}
                      onChange={(e) => updateSettings({
                        semanticTrigger: { ...settings.semanticTrigger!, model: e.target.value.trim() },
                      })}
                    />
                  </div>
                </div>

                {settings.semanticTrigger.provider === 'openai' && (
                  <div>
                    <label className="label">API Key</label>
                    <input
                      type="password"
                      className="input text-sm"
                      placeholder="sk-..."
                      value={settings.semanticTrigger.apiKey ?? ''}
                      onChange={(e) => updateSettings({
                        semanticTrigger: { ...settings.semanticTrigger!, apiKey: e.target.value.trim() },
                      })}
                    />
                  </div>
                )}

                <div>
                  <label className="label">
                    相似度阈值：{((settings.semanticTrigger.threshold ?? 0.3) * 100).toFixed(0)}%
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={Math.round((settings.semanticTrigger.threshold ?? 0.3) * 100)}
                    onChange={(e) => updateSettings({
                      semanticTrigger: {
                        ...settings.semanticTrigger!,
                        threshold: Number(e.target.value) / 100,
                      },
                    })}
                    className="w-full accent-tavern-accent mt-1"
                  />
                  <div className="flex gap-2 mt-1.5">
                    {[20, 30, 40, 50].map(v => (
                      <button
                        key={v}
                        className={cn(
                          'px-2.5 py-0.5 text-xs rounded border transition-colors',
                          Math.round((settings.semanticTrigger.threshold ?? 0.3) * 100) === v
                            ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                            : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                        )}
                        onClick={() => updateSettings({
                          semanticTrigger: { ...settings.semanticTrigger!, threshold: v / 100 },
                        })}
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-tavern-text-muted mt-1">阈值越高越严格，误触发越少但可能漏触发</p>
                </div>

                <div>
                  <label className="label">每次最多注入条目数：{settings.semanticTrigger.maxResults ?? 3}</label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={settings.semanticTrigger.maxResults ?? 3}
                    onChange={(e) => updateSettings({
                      semanticTrigger: { ...settings.semanticTrigger!, maxResults: Number(e.target.value) },
                    })}
                    className="w-full accent-tavern-accent mt-1"
                  />
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <button
                    className="btn-secondary text-xs"
                    disabled={embedTestBusy}
                    onClick={handleEmbedTest}
                  >
                    {embedTestBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Plug className="w-3.5 h-3.5" />
                    )}
                    测试连接
                  </button>
                  {embedTestResult && (
                    <span className={cn(
                      'text-xs flex items-center gap-1',
                      embedTestResult.ok ? 'text-tavern-accent' : 'text-tavern-danger'
                    )}>
                      {embedTestResult.ok
                        ? <CheckCircle2 className="w-3.5 h-3.5" />
                        : <AlertCircle className="w-3.5 h-3.5" />}
                      {embedTestResult.text}
                    </span>
                  )}
                </div>

                <p className="text-xs text-tavern-text-muted pt-1">
                  配置完成后，到「世界书」页面为世界书点击「生成语义索引」，并把条目匹配模式设为「语义」或「关键词 + 语义」。
                </p>
              </>
            )}
          </div>
        </SectionCard>

        {/* 网络 */}
        <SectionCard title="网络" icon={<Globe className="w-4 h-4" />}>
          <div className="mt-3 space-y-3">
            <div>
              <p className="text-sm mb-1.5">封面下载代理</p>
              <p className="text-xs text-tavern-text-muted mb-2">
                导入角色卡时通过代理服务器下载封面图片，留空则直连。格式如 http://127.0.0.1:7890
              </p>
              <input
                type="text"
                className="input text-sm w-full max-w-sm"
                value={settings.coverProxyUrl ?? ''}
                onChange={(e) => {
                  const val = e.target.value.trim()
                  updateSettings({ coverProxyUrl: val || undefined })
                }}
                placeholder="http://127.0.0.1:7890"
              />
            </div>
          </div>
        </SectionCard>

        {/* E. 数据管理 */}
        <SectionCard title="数据管理" icon={<Database className="w-4 h-4" />}>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={handleExport} disabled={busy !== null} className="btn-secondary">
              {busy === 'export' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              导出备份
            </button>
            <button onClick={handleImport} disabled={busy !== null} className="btn-secondary">
              {busy === 'import' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              导入备份
            </button>
            <button
              onClick={() => {
                if (confirm('确定要重置所有设置为默认值吗？此操作不会影响角色、会话等数据。')) {
                  const defaults = getDefaultSettings()
                  // 保留用户的 connectionProfiles 和 API 密钥
                  defaults.connectionProfiles = settings.connectionProfiles
                  defaults.activeProfileId = settings.activeProfileId
                  updateSettings(defaults)
                }
              }}
              disabled={busy !== null}
              className="btn-secondary text-tavern-danger hover:text-tavern-danger"
            >
              重置设置
            </button>
          </div>
          {importMsg && (
            <p
              className={cn(
                'mt-2 text-xs',
                importMsg.ok ? 'text-tavern-success' : 'text-tavern-danger'
              )}
            >
              {importMsg.text}
            </p>
          )}
          <p className="mt-2 text-xs text-tavern-text-muted">
            备份包含所有角色、会话、世界书、预设和设置，不包含 API 密钥。
          </p>
        </SectionCard>
      </div>
    </div>
  )
}
