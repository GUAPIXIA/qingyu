import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore } from '../store/useSettingsStore'
import { THEME_COLORS } from '../utils/defaults'
import { cn } from '../lib/utils'
import { SectionCard, Toggle, OptionGroup } from '../components/common/SettingsShared'
import type { Settings } from '../../shared/types'
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
  Plug,
  ExternalLink,
} from 'lucide-react'

export function SettingsPage() {
  const { settings, updateSettings } = useSettingsStore()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)

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

              {/* 消息间距 */}
              <div>
                <label className="label">
                  <span className="inline-flex items-center gap-1.5">
                    <AlignJustify className="w-3.5 h-3.5" />消息间距
                  </span>
                </label>
                <OptionGroup<Settings['messageSpacing']>
                  value={settings.messageSpacing}
                  onChange={(v) => updateSettings({ messageSpacing: v })}
                  options={[
                    { value: 'compact', label: '紧凑' },
                    { value: 'normal', label: '标准' },
                    { value: 'loose', label: '宽松' },
                  ]}
                />
              </div>

              {/* 预览示意图 */}
              <div className="rounded-lg border border-tavern-border-soft bg-tavern-bg p-3 space-y-1">
                <p className="text-xs text-tavern-text-muted mb-2 font-medium">气泡预览</p>
                <div className={cn(
                  'rounded-lg px-3 py-2 text-xs',
                  settings.bubbleStyle === 'round' && 'rounded-2xl',
                  settings.bubbleStyle === 'standard' && 'rounded-lg',
                  settings.bubbleStyle === 'sharp' && 'rounded-sm',
                  'bg-tavern-user/10 border border-tavern-user/20 ml-4'
                )}>
                  用户消息预览
                </div>
                <div className={cn(
                  'rounded-lg px-3 py-2 text-xs',
                  settings.bubbleStyle === 'round' && 'rounded-2xl',
                  settings.bubbleStyle === 'standard' && 'rounded-lg',
                  settings.bubbleStyle === 'sharp' && 'rounded-sm',
                  'bg-tavern-bg-card border border-tavern-border-soft mr-4'
                )}>
                  AI 回复预览
                </div>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* D. 显示与行为 */}
        <SectionCard title="显示与行为" icon={<Sliders className="w-4 h-4" />}>
          <div className="mt-3 space-y-4">
            <div>
              <label className="label">当前模型</label>
              <input
                type="text"
                className="input"
                value={settings.activeModel}
                onChange={(e) => updateSettings({ activeModel: e.target.value })}
                placeholder="当前使用的对话模型"
              />
              <p className="text-xs text-tavern-text-muted mt-1">切换 provider 时自动更新为对应默认模型</p>
            </div>

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
