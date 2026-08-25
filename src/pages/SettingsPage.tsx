import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore } from '../store/useSettingsStore'
import { getDefaultSettings } from '../utils/defaults'
import { cn } from '../lib/utils'
import { AppearanceSection } from './settings/AppearanceSection'
import { BehaviorSection } from './settings/BehaviorSection'
import { SemanticSection } from './settings/SemanticSection'
import { PhoneConnectionSection } from './settings/PhoneConnectionSection'
import { UpdaterSection } from './settings/UpdaterSection'
import { SectionCard } from '../components/common/SettingsShared'
import type { CustomFont } from '../../shared/types'
import {
  Settings as SettingsIcon,
  Database,
  Loader2,
  Download,
  Upload,
  Plug,
  ExternalLink,
  Globe,
  Palette,
  Sliders,
  Smartphone,
  Brain,
  Check,
} from 'lucide-react'

export function SettingsPage() {
  const { settings, updateSettings } = useSettingsStore()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([])
  const [activeSection, setActiveSection] = useState<string>('api')
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
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

  // S2-D：监听设置变化显示保存状态（防抖 300ms）
  useEffect(() => {
    // 首次 loaded 时不显示 saving
    if (!useSettingsStore.getState().loaded) return
    setSaveStatus('saving')
    const t = setTimeout(() => setSaveStatus('saved'), 500)
    return () => clearTimeout(t)
  }, [settings])

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

  /** 测试嵌入服务连接（若关联档案则实时解析其最新地址/密钥） */
  const handleEmbedTest = async () => {
    const st = settings.semanticTrigger
    if (!st) return
    // 若关联了档案，实时取档案最新值，避免档案改动后语义配置滞后
    let effective = st
    if (st.profileId) {
      const p = settings.connectionProfiles.find((x) => x.id === st.profileId)
      if (p) effective = { ...st, provider: p.provider === 'ollama' ? 'ollama' : 'openai', baseUrl: p.baseUrl, apiKey: p.apiKey ?? '' }
    }
    setEmbedTestBusy(true)
    setEmbedTestResult(null)
    try {
      const result = await window.api.embedding.test({
        provider: effective.provider,
        baseUrl: effective.baseUrl,
        model: effective.model,
        apiKey: effective.apiKey ?? '',
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

  /** 导出备份 - S1 Backup V2：zip + manifest，带计数与大小 */
  const handleExport = async () => {
    setBusy('export')
    setImportMsg(null)
    try {
      const result = await window.api.settings.exportBackup() as { status: string; path?: string; version?: number; counts?: Record<string, number>; totalBytes?: number; excluded?: string[] } | undefined
      if (!result || result.status === 'canceled') return
      const v = result.version ? ` V${result.version}` : ''
      const counts = result.counts
      const detail = counts ? `（${Object.entries(counts).map(([k,v])=>`${k} ${v}`).join(' / ')}）` : ''
      const size = result.totalBytes ? ` ${(result.totalBytes/1024/1024).toFixed(2)} MB` : ''
      const excluded = result.excluded?.length ? `；未包含：${result.excluded.join('、')}` : ''
      setImportMsg({ ok: true, text: `备份已导出${v}${detail}${size}${excluded}` })
    } catch (err) {
      setImportMsg({ ok: false, text: err instanceof Error ? err.message : '导出失败' })
    } finally {
      setBusy(null)
    }
  }

  /** 导入备份 - S1 Backup V2：支持 zip/json，校验 + 全 Store 重载 */
  const handleImport = async () => {
    setBusy('import')
    setImportMsg(null)
    try {
      const result = await window.api.settings.importBackup() as { status: string; version?: number; counts?: Record<string, number> } | undefined
      if (!result || result.status === 'canceled') return
      const v = result.version ? ` V${result.version}` : ''
      const counts = result.counts
      const detail = counts ? `（${Object.entries(counts).map(([k,v])=>`${k} ${v}`).join(' / ')}）` : ''
      setImportMsg({ ok: true, text: `导入成功${v}${detail}，正在刷新...` })
      await Promise.allSettled([
        useSettingsStore.getState().loadSettings(),
        import('../store/useCharacterStore').then(m => m.useCharacterStore.getState().loadCharacters()),
        import('../store/usePersonaStore').then(m => m.usePersonaStore.getState().loadPersonas()),
        import('../store/useGroupChatStore').then(m => m.useGroupChatStore.getState().loadGroups()),
      ])
      setTimeout(() => setImportMsg({ ok: true, text: `导入成功${v}${detail}，已刷新。如列表未更新请重启应用。` }), 800)
    } catch (err) {
      setImportMsg({ ok: false, text: err instanceof Error ? err.message : '导入失败' })
    } finally {
      setBusy(null)
    }
  }

  const sections = [
    { id: 'api', label: 'API', icon: Plug },
    { id: 'appearance', label: '外观', icon: Palette },
    { id: 'behavior', label: '行为', icon: Sliders },
    { id: 'phone', label: '手机连接', icon: Smartphone },
    { id: 'semantic', label: '语义', icon: Brain },
    { id: 'network', label: '网络', icon: Globe },
    { id: 'data', label: '数据管理', icon: Database },
  ] as const

  const scrollTo = (id: string) => {
    setActiveSection(id)
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 - S2-D：保存状态 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-tavern-accent" />
          <h1 className="font-display text-lg font-bold">设置</h1>
          <span className={cn('ml-2 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full', saveStatus === 'saving' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300')}>
            {saveStatus === 'saving' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            {saveStatus === 'saving' ? '保存中...' : '已保存'}
          </span>
        </div>
      </header>

      {/* 内容区 - S2-D：左侧目录 + 右侧滚动 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧目录 - S2-D：分区导航（测试环境始终可见，样式层再做响应式） */}
        <nav className="flex w-44 shrink-0 flex-col border-r border-tavern-border-soft bg-tavern-bg-soft/50 p-2 gap-1 overflow-y-auto" aria-label="设置分区">
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => scrollTo(s.id)}
              className={cn('flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors', activeSection === s.id ? 'bg-tavern-accent-soft text-tavern-accent' : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover')}
            >
              <s.icon className="w-4 h-4" aria-hidden /> {s.label}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto p-4 space-y-4" onScroll={(e) => {
          const container = e.currentTarget
          // 简易滚动高亮
          for (const s of sections) {
            const el = document.getElementById(`settings-${s.id}`)
            if (el) {
              const rect = el.getBoundingClientRect()
              const contRect = container.getBoundingClientRect()
              if (rect.top >= contRect.top - 80 && rect.top < contRect.top + 200) { setActiveSection(s.id); break }
            }
          }
        }}>
        <div id="settings-api">
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
        </div>
        <div id="settings-appearance">
        <AppearanceSection
          settings={settings}
          updateSettings={updateSettings}
          customFonts={customFonts}
          fontUploading={fontUploading}
          fontError={fontError}
          handleUploadFont={handleUploadFont}
          handleApplyCustomFont={handleApplyCustomFont}
          handleDeleteFont={handleDeleteFont}
        />
        </div>
        <div id="settings-behavior">
        <BehaviorSection settings={settings} updateSettings={updateSettings} />
        </div>
        <div id="settings-phone">
        <PhoneConnectionSection />
        </div>
        <div id="settings-updater">
        <UpdaterSection />
        </div>
        <div id="settings-semantic">
        <SemanticSection
          settings={settings}
          updateSettings={updateSettings}
          embedTestBusy={embedTestBusy}
          embedTestResult={embedTestResult}
          handleEmbedTest={handleEmbedTest}
        />
        </div>
        <div id="settings-network">
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
        </div>
        <div id="settings-data">
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
          <div className="mt-2 space-y-1 text-xs text-tavern-text-muted">
            <p>Backup V2（zip）：包含 设置、角色（含头像/封面）、世界书、预设、身份、正则、快捷回复、MCP、用量、全部聊天记录与群聊。</p>
            <p>未包含：API Key / 凭据、设备配对信息、向量索引（可重建）。旧版 JSON 备份仍可导入。</p>
          </div>
        </SectionCard>
        </div>
        </div>
      </div>
    </div>
  )
}
