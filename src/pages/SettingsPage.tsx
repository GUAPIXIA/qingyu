import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSettingsStore } from '../store/useSettingsStore'
import { getDefaultSettings } from '../utils/defaults'
import { cn } from '../lib/utils'
import { AppearanceSection } from './settings/AppearanceSection'
import { BehaviorSection } from './settings/BehaviorSection'
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
  Check,
  RefreshCw,
} from 'lucide-react'

export function SettingsPage() {
  const { settings, updateSettings, saveStatus, saveError, saveSettings } = useSettingsStore()
  const navigate = useNavigate()
  const { hash } = useLocation()
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([])
  const [activeSection, setActiveSection] = useState<string>('updater')
  const [fontUploading, setFontUploading] = useState(false)
  const [fontError, setFontError] = useState<string | null>(null)

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

  useEffect(() => {
    if (hash !== '#settings-updater') return
    setActiveSection('updater')
    const frame = requestAnimationFrame(() => {
      document.getElementById('settings-updater')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [hash])

  // S2-D / P1-02：保存状态由 store 的真实落盘 Promise 结果驱动（不再用固定 500ms 计时器假成功）

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
    { id: 'updater', label: '软件更新', icon: RefreshCw },
    { id: 'api', label: '模型', icon: Plug },
    { id: 'appearance', label: '外观', icon: Palette },
    { id: 'behavior', label: '行为', icon: Sliders },
    { id: 'phone', label: '手机连接', icon: Smartphone },
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
          {saveStatus === 'saving' && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              <Loader2 className="w-3 h-3 animate-spin" />
              保存中...
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
              <Check className="w-3 h-3" />
              已保存
            </span>
          )}
          {saveStatus === 'error' && (
            <>
              <span
                className="ml-2 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-tavern-danger/10 text-tavern-danger"
                title={saveError ?? undefined}
              >
                保存失败{saveError ? `：${saveError}` : ''}
              </span>
              <button
                onClick={() => { void saveSettings() }}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
                title="重新保存设置"
              >
                <RefreshCw className="w-3 h-3" />
                重试
              </button>
            </>
          )}
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
        <div data-testid="settings-sections" className="flex-1 overflow-y-auto p-4 space-y-4" onScroll={(e) => {
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
        <div id="settings-updater">
        <UpdaterSection />
        </div>
        <div id="settings-api">
        <SectionCard title="模型" icon={<Plug className="w-4 h-4" />} defaultOpen={false} storageKey="api">
          <div className="mt-3">
            <p className="text-sm text-tavern-text-muted mb-3">
              管理对话连接、TTS、文本生图、识图以及语义检索模型
            </p>
            <button
              onClick={() => navigate('/api')}
              className="btn-secondary inline-flex items-center gap-1.5 text-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              打开模型
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
        <div id="settings-network">
        <SectionCard title="网络" icon={<Globe className="w-4 h-4" />} storageKey="network">
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
        <SectionCard title="数据管理" icon={<Database className="w-4 h-4" />} storageKey="data">
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
            <p>导入为合并式恢复：同名文件覆盖，备份中未包含的本地文件保留；写入前先完成整包校验，失败会回滚本次写入。</p>
            <p>未包含：API Key / 凭据、MCP 环境变量敏感值（KEY/TOKEN/SECRET/PASSWORD，导出时置空）、设备配对信息、向量索引（可重建）。旧版 JSON 备份仍可导入。</p>
          </div>
        </SectionCard>
        </div>
        </div>
      </div>
    </div>
  )
}
