import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore } from '../store/useSettingsStore'
import { getDefaultSettings } from '../utils/defaults'
import { cn } from '../lib/utils'
import { AppearanceSection } from './settings/AppearanceSection'
import { BehaviorSection } from './settings/BehaviorSection'
import { SemanticSection } from './settings/SemanticSection'
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
        <BehaviorSection settings={settings} updateSettings={updateSettings} />
        <SemanticSection
          settings={settings}
          updateSettings={updateSettings}
          embedTestBusy={embedTestBusy}
          embedTestResult={embedTestResult}
          handleEmbedTest={handleEmbedTest}
        />        {/* 网络 */}
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
