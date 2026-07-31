import { useRef, useState } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import type { TTSModelConfig } from '../../../shared/types'
import {
  Volume2, Plus, Trash2, Check, Eye, EyeOff,
  Circle, ChevronUp, ChevronDown, Loader2, Play, Square,
} from 'lucide-react'

const TTS_PROVIDERS = [
  { value: 'system' as const, label: '系统语音 (本地)', desc: 'Windows 内置语音（System.Speech）' },
  { value: 'edge' as const, label: 'Edge TTS', desc: '微软免费在线语音，音质好，无需 key' },
  { value: 'openai' as const, label: 'OpenAI TTS', desc: 'OpenAI 兼容 /audio/speech，需 API Key' },
]

/** OpenAI TTS 预设音色 */
const OPENAI_VOICE_OPTIONS = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'ballad', 'coral', 'sage']

/** Edge TTS 常用音色 */
const EDGE_VOICE_OPTIONS = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女·温暖）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女·活泼）' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男·阳光）' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男·沉稳）' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男·专业）' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏（男·少年）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（女·东北）' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（女·陕西）' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻（女·台湾）' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼（女·香港）' },
  { id: 'en-US-AriaNeural', label: 'Aria（女·美音）' },
  { id: 'en-US-GuyNeural', label: 'Guy（男·美音）' },
]

function emptyForm(): TTSModelConfig {
  return {
    id: '', name: '', provider: 'system' as const,
    model: 'tts-1', voice: 'zh-CN-XiaoxiaoNeural', apiKey: '', baseUrl: 'https://api.openai.com/v1',
    enabled: true, order: 0,
  }
}

export function TTSModelsSection() {
  const {
    settings, addTTSModel, updateTTSModel, deleteTTSModel,
    setActiveTTSModelId, reorderTTSModels,
  } = useSettingsStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [form, setForm] = useState<TTSModelConfig>(emptyForm())
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  /** 试听 */
  const [auditioning, setAuditioning] = useState(false)
  const auditionRef = useRef<HTMLAudioElement | null>(null)

  const models = [...settings.ttsModels].sort((a, b) => a.order - b.order)

  const resetForm = () => {
    setForm(emptyForm())
    setShowKey(false)
  }

  const openEdit = (m: TTSModelConfig) => {
    setForm({ ...m })
    setEditingId(m.id)
    setShowAdd(false)
    setShowKey(false)
    setTestResult(null)
  }

  const openAdd = () => {
    resetForm()
    setEditingId(null)
    setShowAdd(true)
    setTestResult(null)
  }

  /** 测试连接 */
  const handleTestConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      if (form.provider === 'system') {
        // 系统语音：检查本地语音引擎
        const voices = await window.api.tts.listVoices('system')
        if (voices.length > 0) {
          setTestResult({ success: true, message: `连接成功，${voices.length} 个可用语音` })
        } else {
          setTestResult({ success: false, message: '未找到已安装的语音，请检查 Windows 语音设置' })
        }
      } else {
        // OpenAI TTS: 复用对话 API 测试连接
        const result = await window.api.ai.testConnection({
          type: 'openai',
          baseUrl: form.baseUrl || 'https://api.openai.com/v1',
          apiKey: form.apiKey,
          model: form.model || 'tts-1',
        })
        if (result.success) {
          setTestResult({ success: true, message: result.models ? `连接成功，${result.models.length} 个模型可用` : '连接成功' })
        } else {
          setTestResult({ success: false, message: result.error ?? '连接失败' })
        }
      }
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    if (!form.name.trim()) return
    if (editingId) {
      updateTTSModel(editingId, form)
      setEditingId(null)
    } else {
      addTTSModel(form)
      setShowAdd(false)
    }
    resetForm()
  }

  const handleDelete = (id: string) => {
    deleteTTSModel(id)
    if (editingId === id) {
      setEditingId(null)
      resetForm()
    }
  }

  /** 试听：用当前表单配置合成并播放一句测试语音 */
  const auditionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const auditionUnsubRef = useRef<(() => void) | null>(null)

  const stopAudition = async () => {
    auditionRef.current?.pause()
    auditionRef.current = null
    if (auditionTimerRef.current) { clearTimeout(auditionTimerRef.current); auditionTimerRef.current = null }
    auditionUnsubRef.current?.()
    auditionUnsubRef.current = null
    // system 引擎：真正停止主进程播放
    if (form.provider !== 'openai' && form.provider !== 'edge') {
      await window.api.tts.stop().catch(() => {})
    }
    setAuditioning(false)
  }

  const handleAudition = async () => {
    if (auditioning) {
      await stopAudition()
      return
    }
    setAuditioning(true)
    setTestResult(null)
    try {
      const res = await window.api.tts.speak('你好，这是一段试听语音，用来检查当前音色效果。', {
        provider: form.provider,
        voice: form.voice || (form.provider === 'openai' ? 'alloy' : 'zh-CN-XiaoxiaoNeural'),
        rate: 1,
        model: form.model,
        apiKey: form.apiKey,
        baseUrl: form.baseUrl,
        // Edge TTS 代理（配置留空直连；主进程代理失败自动回退直连）
        proxy: form.provider === 'edge' ? (form.proxy || undefined) : undefined,
      })
      // 强制复位：无论何种引擎，试听最长 20 秒
      if (auditionTimerRef.current) clearTimeout(auditionTimerRef.current)
      auditionTimerRef.current = setTimeout(() => {
        setAuditioning(false)
        auditionTimerRef.current = null
      }, 20000)

      if (res.success && res.audioBase64) {
        // openai/edge：渲染进程播放
        const audio = new Audio(`data:audio/mp3;base64,${res.audioBase64}`)
        audio.onended = () => { setAuditioning(false); auditionRef.current = null }
        audio.onerror = () => { setAuditioning(false); auditionRef.current = null }
        auditionRef.current = audio
        await audio.play().catch(() => setAuditioning(false))
      } else if (res.success) {
        // system 引擎：主进程播放，等状态推送复位（idle）
        auditionUnsubRef.current?.()
        auditionUnsubRef.current = window.api.tts.onState((state) => {
          if (state === 'idle') setAuditioning(false)
        })
      } else {
        setAuditioning(false)
        setTestResult({ success: false, message: res.error || '试听失败' })
      }
    } catch (e) {
      setAuditioning(false)
      setTestResult({ success: false, message: e instanceof Error ? e.message : '试听失败' })
    }
  }

  const handleMove = (id: string, direction: 'up' | 'down') => {
    const idx = models.findIndex((m) => m.id === id)
    if (idx < 0) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= models.length) return
    const newModels = [...models]
    const [item] = newModels.splice(idx, 1)
    newModels.splice(targetIdx, 0, item)
    reorderTTSModels(newModels.map((m) => m.id))
  }

  const renderForm = () => (
    <div className="space-y-3 mt-3">
      {/* 名称 */}
      <input
        type="text"
        className="input text-sm"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        placeholder="配置名称（如：Edge 中文女声）"
        autoFocus
      />

      {/* 提供商选择 */}
      <div>
        <label className="label">TTS 提供商</label>
        <div className="flex flex-wrap gap-1.5">
          {TTS_PROVIDERS.map((pr) => (
            <button
              key={pr.value}
              onClick={() => setForm((f) => ({ ...f, provider: pr.value }))}
              className={cn(
                'px-2.5 py-1 rounded text-xs border transition-colors',
                form.provider === pr.value
                  ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                  : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
              )}
              title={pr.desc}
            >
              {pr.label}
            </button>
          ))}
        </div>
      </div>

      {/* OpenAI 特有字段 */}
      {form.provider === 'openai' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Base URL</label>
              <input
                type="text"
                className="input text-xs font-mono"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <label className="label">API Key</label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  className="input text-xs pr-10"
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  placeholder="sk-..."
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-tavern-text-muted hover:text-tavern-text"
                >
                  {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
          <div>
            <label className="label">模型名称</label>
            <input
              type="text"
              className="input text-sm"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="例如 tts-1、tts-1-hd"
            />
          </div>
        </>
      )}

      {/* 语音：openai/edge 用预设下拉，system 手输 */}
      <div>
        <label className="label">语音</label>
        {form.provider === 'openai' ? (
          <select
            className="select"
            value={form.voice || 'alloy'}
            onChange={(e) => setForm((f) => ({ ...f, voice: e.target.value }))}
          >
            {OPENAI_VOICE_OPTIONS.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        ) : form.provider === 'edge' ? (
          <select
            className="select"
            value={form.voice || 'zh-CN-XiaoxiaoNeural'}
            onChange={(e) => setForm((f) => ({ ...f, voice: e.target.value }))}
          >
            {EDGE_VOICE_OPTIONS.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            className="input text-sm"
            value={form.voice}
            onChange={(e) => setForm((f) => ({ ...f, voice: e.target.value }))}
            placeholder="例如 zh-CN-XiaoxiaoNeural（留空使用默认）"
          />
        )}
        {form.provider === 'openai' && (
          <p className="text-xs text-tavern-text-muted mt-1">中文效果较好：nova（女）/ onyx（男）/ echo / fable</p>
        )}
        {form.provider === 'edge' && (
          <>
            <p className="text-xs text-tavern-text-muted mt-1">微软免费在线语音，无需 API Key；默认直连，需联网</p>
            <div className="mt-2">
              <label className="label">代理地址（可选，留空直连）</label>
              <input
                type="text"
                className="input text-xs font-mono"
                value={form.proxy ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, proxy: e.target.value.trim() || undefined }))}
                placeholder="http://127.0.0.1:7890"
              />
              <p className="text-xs text-tavern-text-muted mt-1">国内网络直连失败时才需要；代理失败会自动回退直连</p>
            </div>
          </>
        )}
        {form.provider === 'system' && (
          <p className="text-xs text-tavern-text-muted mt-1">留空使用系统默认语音</p>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={handleSave} disabled={!form.name.trim()} className="btn-primary text-xs">
          <Check className="w-3.5 h-3.5" />保存
        </button>
        <button
          onClick={handleTestConnection}
          disabled={testing}
          className="px-3 py-1.5 rounded-lg text-xs border border-tavern-border-soft text-tavern-text-soft hover:border-tavern-accent hover:text-tavern-accent transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Circle className="w-3 h-3" />}
          {testing ? '测试中...' : '测试连接'}
        </button>
        {/* 试听：用当前配置合成播放 */}
        <button
          onClick={handleAudition}
          disabled={testing}
          title="试听当前音色"
          className={cn(
            'px-3 py-1.5 rounded-lg text-xs border transition-colors flex items-center gap-1.5 disabled:opacity-50',
            auditioning
              ? 'border-tavern-danger text-tavern-danger hover:bg-tavern-danger/10'
              : 'border-tavern-border-soft text-tavern-text-soft hover:border-tavern-accent hover:text-tavern-accent'
          )}
        >
          {auditioning ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          {auditioning ? '停止' : '试听'}
        </button>
        <button
          onClick={() => { editingId ? setEditingId(null) : setShowAdd(false); resetForm() }}
          className="px-3 py-1.5 text-xs text-tavern-text-muted hover:text-tavern-text"
        >
          取消
        </button>
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div className={cn(
          'text-xs px-3 py-2 rounded-lg border',
          testResult.success
            ? 'border-tavern-success/30 bg-tavern-success/10 text-tavern-success'
            : 'border-tavern-danger/30 bg-tavern-danger/10 text-tavern-danger'
        )}>
          {testResult.success ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-2">
      {models.length === 0 && !showAdd ? (
        <div className="text-center py-8">
          <Volume2 className="w-10 h-10 text-tavern-text-muted mx-auto mb-2 opacity-30" />
          <p className="text-sm text-tavern-text-muted mb-3">尚未配置 TTS 模型</p>
          <button onClick={openAdd} className="btn-primary inline-flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" />添加 TTS 模型
          </button>
        </div>
      ) : (
        <>
          {models.map((m, idx) => (
            <div
              key={m.id}
              className={cn(
                'rounded-xl border transition-colors',
                m.id === settings.activeTTSModelId
                  ? 'border-tavern-accent bg-tavern-accent-soft/30'
                  : 'border-tavern-border-soft bg-tavern-bg-card'
              )}
            >
              {/* 折叠头部 */}
              <div
                className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-tavern-bg-hover/50 rounded-t-xl"
                onClick={() => {
                  if (editingId === m.id) { setEditingId(null); resetForm() }
                  else openEdit(m)
                }}
              >
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleMove(m.id, 'up') }}
                    disabled={idx === 0}
                    className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30"
                  >
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleMove(m.id, 'down') }}
                    disabled={idx === models.length - 1}
                    className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </div>

                <Circle
                  className={cn(
                    'w-3 h-3 shrink-0',
                    m.id === settings.activeTTSModelId
                      ? 'text-tavern-success fill-current'
                      : 'text-tavern-text-muted'
                  )}
                />

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-tavern-text truncate">{m.name}</div>
                  <div className="text-xs text-tavern-text-muted">
                    {m.provider === 'openai' ? 'OpenAI TTS' : '系统语音'}
                    {m.voice ? ` · ${m.voice}` : ''}
                    {m.model ? ` · ${m.model}` : ''}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {m.id === settings.activeTTSModelId ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent font-medium">
                      使用中
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveTTSModelId(m.id) }}
                      className="text-xs px-2 py-0.5 rounded border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-accent hover:border-tavern-accent transition-colors"
                    >
                      启用
                    </button>
                  )}
                </div>
              </div>

              {/* 编辑区 */}
              {editingId === m.id && (
                <div className="px-4 pb-4 pt-1 border-t border-tavern-border-soft">
                  <div className="flex items-center justify-end mb-2">
                    <button
                      onClick={() => handleDelete(m.id)}
                      className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {renderForm()}
                </div>
              )}
            </div>
          ))}

          {/* 新建表单 */}
          {showAdd && (
            <div className="rounded-xl border border-tavern-accent bg-tavern-accent-soft/20">
              <div className="px-4 py-3 border-b border-tavern-border-soft flex items-center gap-2 text-sm font-medium text-tavern-accent">
                <Plus className="w-4 h-4" />新建 TTS 配置
              </div>
              <div className="px-4 pb-4 pt-1">{renderForm()}</div>
            </div>
          )}

          {!showAdd && (
            <button
              onClick={openAdd}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 border-dashed border-tavern-border-soft text-tavern-text-muted hover:border-tavern-accent hover:text-tavern-accent transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span className="text-sm">添加 TTS 模型</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}
