import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import type { ImageGenModelConfig } from '../../../shared/types'
import type { ComfyWorkflowImportResult, LocalComfyWorkflow } from '../../../shared/ipc-api'
import {
  Image, Plus, Trash2, Check, Eye, EyeOff,
  Circle, ChevronUp, ChevronDown, Loader2, FolderOpen, RefreshCw, FileJson2,
} from 'lucide-react'

/** 提供商选项 */
const PROVIDERS = [
  { value: 'openai', label: 'OpenAI DALL-E' },
  { value: 'sd-webui', label: 'SD WebUI (A1111)' },
  { value: 'comfyui', label: 'ComfyUI' },
]

/** OpenAI DALL-E 尺寸选项 */
const OPENAI_SIZES = [
  '1024x1024', '1792x1024', '1024x1792',
  '512x512', '256x256',
]

/** SD WebUI 尺寸选项 */
const SD_SIZES = [
  '512x512', '768x768', '1024x1024',
  '512x768', '768x512',
]

/** SD WebUI 采样器选项 */
const SD_SAMPLERS = [
  'Euler a', 'Euler', 'LMS', 'Heun', 'DPM2', 'DPM2 a',
  'DPM++ 2S a', 'DPM++ 2M', 'DPM++ SDE', 'DPM fast',
  'DDIM', 'PLMS', 'UniPC',
]

/** ComfyUI 原生 KSampler 采样器名称 */
const COMFY_SAMPLERS = [
  'euler', 'euler_ancestral', 'heun', 'lms',
  'dpm_2', 'dpm_2_ancestral', 'dpm_fast', 'dpm_adaptive',
  'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_2m',
  'ddim', 'uni_pc', 'res_multistep',
]

const COMFY_SCHEDULERS = [
  'normal', 'simple', 'karras', 'exponential', 'sgm_uniform',
  'ddim_uniform', 'beta', 'linear_quadratic', 'kl_optimal',
]

const IMAGE_QUALITIES = [
  { value: 'standard', label: '标准' },
  { value: 'hd', label: 'HD 高清' },
]

/** 根据 provider 返回空表单默认值 */
function emptyForm(provider: string = 'openai'): ImageGenModelConfig {
  if (provider === 'comfyui') {
    return {
      id: '', name: '', provider: 'comfyui',
      model: '', apiKey: '', baseUrl: 'http://127.0.0.1:8188',
      size: '512x512', quality: 'standard',
      enabled: true, order: 0,
      negativePrompt: '',
      steps: 20,
      cfgScale: 7,
      sampler: 'euler',
      scheduler: 'normal',
      workflow: '',
    }
  }
  if (provider === 'sd-webui') {
    return {
      id: '', name: '', provider: 'sd-webui',
      model: '', apiKey: '', baseUrl: 'http://127.0.0.1:7860',
      size: '512x512', quality: 'standard',
      enabled: true, order: 0,
      negativePrompt: '',
      steps: 20,
      cfgScale: 7,
      sampler: 'Euler a',
    }
  }
  return {
    id: '', name: '', provider: 'openai',
    model: '', apiKey: '', baseUrl: 'https://api.openai.com/v1',
    size: '1024x1024', quality: 'standard',
    enabled: true, order: 0,
  }
}

export function ImageGenModelsSection() {
  const {
    settings, addImageGenModel, updateImageGenModel, deleteImageGenModel,
    setActiveImageGenModelId, reorderImageGenModels,
  } = useSettingsStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [form, setForm] = useState<ImageGenModelConfig>(emptyForm())
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [localWorkflows, setLocalWorkflows] = useState<LocalComfyWorkflow[]>([])
  const [selectedWorkflowPath, setSelectedWorkflowPath] = useState('')
  const [loadingWorkflows, setLoadingWorkflows] = useState(false)
  const [importingWorkflow, setImportingWorkflow] = useState(false)
  const [workflowMessage, setWorkflowMessage] = useState<{ success: boolean; text: string } | null>(null)

  const models = [...settings.imageGenModels].sort((a, b) => a.order - b.order)

  const isSdWebui = form.provider === 'sd-webui'
  const isComfyUi = form.provider === 'comfyui'
  const usesDiffusionSettings = isSdWebui || isComfyUi
  const standardSizes = usesDiffusionSettings ? SD_SIZES : OPENAI_SIZES
  const sizeOptions = standardSizes.includes(form.size) ? standardSizes : [form.size, ...standardSizes]
  const comfySamplers = form.sampler && !COMFY_SAMPLERS.includes(form.sampler)
    ? [form.sampler, ...COMFY_SAMPLERS]
    : COMFY_SAMPLERS
  const comfySchedulers = form.scheduler && !COMFY_SCHEDULERS.includes(form.scheduler)
    ? [form.scheduler, ...COMFY_SCHEDULERS]
    : COMFY_SCHEDULERS

  const loadLocalWorkflows = async () => {
    setLoadingWorkflows(true)
    try {
      const result = await window.api.imageGen.listLocalComfyWorkflows()
      const workflows = result.workflows ?? []
      setLocalWorkflows(workflows)
      setSelectedWorkflowPath((current) => current || workflows[0]?.path || '')
      if (!result.success) setWorkflowMessage({ success: false, text: result.error ?? '读取本地工作流失败' })
    } catch (error) {
      setWorkflowMessage({ success: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoadingWorkflows(false)
    }
  }

  useEffect(() => {
    if (isComfyUi) void loadLocalWorkflows()
  }, [isComfyUi])

  const resetForm = () => {
    setForm(emptyForm())
    setShowKey(false)
    setWorkflowMessage(null)
  }

  const openEdit = (m: ImageGenModelConfig) => {
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

  /** 切换 provider 时重置相关默认值 */
  const handleProviderChange = (provider: string) => {
    setForm((f) => {
      const defaults = emptyForm(provider)
      return {
        ...f,
        provider,
        baseUrl: defaults.baseUrl,
        size: defaults.size,
        steps: defaults.steps,
        cfgScale: defaults.cfgScale,
        sampler: defaults.sampler,
        scheduler: defaults.scheduler,
        workflow: defaults.workflow,
        workflowName: undefined,
      }
    })
    setTestResult(null)
  }

  const applyImportedWorkflow = (result: ComfyWorkflowImportResult) => {
    if (!result.success || !result.workflow) {
      if (!result.canceled) setWorkflowMessage({ success: false, text: result.error ?? '导入工作流失败' })
      return
    }
    const inferred = result.settings ?? {}
    setForm((current) => ({
      ...current,
      workflow: result.workflow,
      workflowName: result.sourceName,
      size: inferred.size ?? current.size,
      steps: inferred.steps ?? current.steps,
      cfgScale: inferred.cfgScale ?? current.cfgScale,
      sampler: inferred.sampler ?? current.sampler,
      scheduler: inferred.scheduler ?? current.scheduler,
      model: inferred.model ?? current.model,
      negativePrompt: inferred.negativePrompt ?? current.negativePrompt,
      name: current.name || result.sourceName || current.name,
    }))
    setWorkflowMessage({
      success: true,
      text: `已读取 ${result.sourceName ?? '工作流'} · ${result.nodeCount ?? 0} 个节点${result.converted ? ' · 已转换为 API 格式' : ''}`,
    })
  }

  const handleImportWorkflow = async (path?: string) => {
    setImportingWorkflow(true)
    setWorkflowMessage(null)
    try {
      applyImportedWorkflow(await window.api.imageGen.importLocalComfyWorkflow(path))
    } catch (error) {
      setWorkflowMessage({ success: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setImportingWorkflow(false)
    }
  }

  /** 测试连接 */
  const handleTestConnection = async () => {
    if (!form.baseUrl.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.imageGen.testConnection({
        provider: form.provider,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
      })
      setTestResult({
        success: result.success,
        message: result.success ? (result.message ?? '连接成功') : (result.error ?? '连接失败'),
      })
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    if (!form.name.trim()) return
    if (editingId) {
      updateImageGenModel(editingId, form)
      setEditingId(null)
    } else {
      addImageGenModel(form)
      setShowAdd(false)
    }
    resetForm()
  }

  const handleDelete = (id: string) => {
    deleteImageGenModel(id)
    if (editingId === id) {
      setEditingId(null)
      resetForm()
    }
  }

  const moveModel = (id: string, direction: 'up' | 'down') => {
    const idx = models.findIndex((m) => m.id === id)
    if (idx < 0) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= models.length) return
    const newModels = [...models]
    const [item] = newModels.splice(idx, 1)
    newModels.splice(targetIdx, 0, item)
    reorderImageGenModels(newModels.map((m) => m.id))
  }

  const renderForm = () => (
    <div className="space-y-3 mt-3">
      {/* 名称 */}
      <input
        type="text"
        className="input text-sm"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        placeholder="配置名称（如：本地 SD / DALL-E 3）"
        autoFocus
      />

      {/* 提供商（下拉选择） */}
      <div>
        <label className="label">提供商</label>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.value}
              onClick={() => handleProviderChange(p.value)}
              className={cn(
                'px-2.5 py-1 rounded text-xs border transition-colors',
                form.provider === p.value
                  ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                  : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Base URL */}
      <div>
        <label className="label">Base URL</label>
        <input
          type="text"
          className="input text-xs font-mono"
          value={form.baseUrl}
          onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          placeholder={isComfyUi ? 'http://127.0.0.1:8188' : isSdWebui ? 'http://127.0.0.1:7860' : 'https://api.openai.com/v1'}
        />
      </div>

      {/* API Key（ComfyUI 本地服务可留空，远程代理可选） */}
      {!isSdWebui && (
        <div>
          <label className="label">API Key{isComfyUi ? '（可选）' : ''}</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              className="input text-xs pr-10"
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={isComfyUi ? '本地服务留空' : 'sk-...'}
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
      )}

      {/* 模型名称 */}
      <div>
        <label className="label">{isComfyUi ? 'Checkpoint 文件名' : '模型名称'}</label>
        <input
          type="text"
          className="input text-sm"
          value={form.model}
          onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
          placeholder={isComfyUi ? '例如 model.safetensors' : isSdWebui ? '（可选，如 v1-5-pruned）' : '例如 dall-e-3'}
        />
        {isComfyUi && (
          <p className="text-xs text-tavern-text-muted mt-1">使用自定义工作流且模型已写入工作流时可留空</p>
        )}
      </div>

      {/* 尺寸 */}
      <div>
        <label className="label">图片尺寸（默认值，可在快捷面板覆盖）</label>
        <select
          className="input text-sm"
          value={form.size}
          onChange={(e) => setForm((f) => ({ ...f, size: e.target.value }))}
        >
          {sizeOptions.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* 质量（仅 OpenAI 显示） */}
      {!usesDiffusionSettings && (
        <div>
          <label className="label">生成质量</label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {IMAGE_QUALITIES.map((q) => (
              <button
                key={q.value}
                onClick={() => setForm((f) => ({ ...f, quality: q.value }))}
                className={cn(
                  'px-2.5 py-1 rounded text-xs border transition-colors',
                  form.quality === q.value
                    ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                    : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* SD WebUI / ComfyUI 扩散参数 */}
      {usesDiffusionSettings && (
        <>
          {/* 负面提示词 */}
          <div>
            <label className="label">负面提示词</label>
            <textarea
              className="input text-xs resize-none"
              rows={2}
              value={form.negativePrompt ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, negativePrompt: e.target.value }))}
              placeholder="如: lowres, bad anatomy, bad hands, text, error"
            />
          </div>

          {/* 步数 + CFG */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">采样步数 (Steps)</label>
              <input
                type="number"
                className="input text-sm"
                value={form.steps ?? 20}
                min={1}
                max={150}
                onChange={(e) => setForm((f) => ({ ...f, steps: parseInt(e.target.value) || 20 }))}
              />
            </div>
            <div>
              <label className="label">CFG Scale</label>
              <input
                type="number"
                className="input text-sm"
                value={form.cfgScale ?? 7}
                min={1}
                max={30}
                step={0.5}
                onChange={(e) => setForm((f) => ({ ...f, cfgScale: parseFloat(e.target.value) || 7 }))}
              />
            </div>
          </div>

          {/* 采样器 */}
          <div>
            <label className="label">采样器</label>
            <select
              className="input text-sm"
              value={form.sampler ?? (isComfyUi ? 'euler' : 'Euler a')}
              onChange={(e) => setForm((f) => ({ ...f, sampler: e.target.value }))}
            >
              {(isComfyUi ? comfySamplers : SD_SAMPLERS).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {isComfyUi && (
            <>
              <div>
                <label className="label">调度器</label>
                <select
                  className="input text-sm"
                  value={form.scheduler ?? 'normal'}
                  onChange={(e) => setForm((f) => ({ ...f, scheduler: e.target.value }))}
                >
                  {comfySchedulers.map((scheduler) => (
                    <option key={scheduler} value={scheduler}>{scheduler}</option>
                  ))}
                </select>
              </div>

              <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/60 p-3 space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-medium text-tavern-text">
                      <FileJson2 className="w-3.5 h-3.5 text-tavern-accent" />
                      ComfyUI Desktop 工作流
                    </div>
                    <p className="text-[11px] text-tavern-text-muted mt-1">
                      自动读取 Desktop 安装目录，并将画布工作流转换为可执行格式。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadLocalWorkflows()}
                    disabled={loadingWorkflows}
                    title="重新扫描"
                    className="p-1.5 rounded-md text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft disabled:opacity-50"
                  >
                    <RefreshCw className={cn('w-3.5 h-3.5', loadingWorkflows && 'animate-spin')} />
                  </button>
                </div>

                {localWorkflows.length > 0 ? (
                  <div className="flex gap-2">
                    <select
                      className="input text-xs min-w-0 flex-1"
                      value={selectedWorkflowPath}
                      onChange={(e) => setSelectedWorkflowPath(e.target.value)}
                    >
                      {localWorkflows.map((workflow) => (
                        <option key={workflow.path} value={workflow.path}>
                          {workflow.name} · {workflow.installation}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleImportWorkflow(selectedWorkflowPath)}
                      disabled={!selectedWorkflowPath || importingWorkflow}
                      className="btn-primary shrink-0 text-xs"
                    >
                      {importingWorkflow ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileJson2 className="w-3.5 h-3.5" />}
                      读取
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-tavern-text-muted">
                    {loadingWorkflows ? '正在扫描本机安装…' : '未检测到 Desktop 工作流，可手动选择文件。'}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => void handleImportWorkflow()}
                  disabled={importingWorkflow}
                  className="inline-flex items-center gap-1.5 text-xs text-tavern-text-soft hover:text-tavern-accent transition-colors"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  选择其他 JSON
                </button>

                {(workflowMessage || form.workflowName) && (
                  <div className={cn(
                    'text-xs rounded-lg px-2.5 py-2 border',
                    workflowMessage?.success !== false
                      ? 'border-tavern-success/25 bg-tavern-success/10 text-tavern-success'
                      : 'border-tavern-danger/25 bg-tavern-danger/10 text-tavern-danger',
                  )}>
                    {workflowMessage?.text ?? `已载入 ${form.workflowName}`}
                  </div>
                )}
              </div>

              <details className="group">
                <summary className="cursor-pointer text-xs text-tavern-text-muted hover:text-tavern-text select-none">
                  高级：查看或粘贴 API 工作流 JSON
                </summary>
                <div className="mt-2">
                  <textarea
                    className="textarea text-xs font-mono min-h-36"
                    value={form.workflow ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, workflow: e.target.value, workflowName: undefined }))}
                    placeholder="也可以直接粘贴 ComfyUI 导出的 API 格式工作流"
                    spellCheck={false}
                  />
                  <p className="text-xs text-tavern-text-muted mt-1 leading-relaxed">
                    支持 {'{{prompt}}'}、{'{{negative_prompt}}'}、{'{{width}}'}、{'{{height}}'}、{'{{seed}}'}、{'{{steps}}'}、{'{{cfg}}'}、{'{{sampler}}'}、{'{{scheduler}}'} 和 {'{{checkpoint}}'} 占位符。
                  </p>
                </div>
              </details>
            </>
          )}
        </>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={handleSave} disabled={!form.name.trim()} className="btn-primary text-xs">
          <Check className="w-3.5 h-3.5" />保存
        </button>
        <button
          onClick={handleTestConnection}
          disabled={!form.baseUrl.trim() || testing}
          className="px-3 py-1.5 rounded-lg text-xs border border-tavern-border-soft text-tavern-text-soft hover:border-tavern-accent hover:text-tavern-accent transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Circle className="w-3 h-3" />}
          {testing ? '测试中...' : '测试连接'}
        </button>
        <button
          onClick={() => { if (editingId) setEditingId(null); else setShowAdd(false); resetForm() }}
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
          <Image className="w-10 h-10 text-tavern-text-muted mx-auto mb-2 opacity-30" />
          <p className="text-sm text-tavern-text-muted mb-3">尚未配置生图模型</p>
          <button onClick={openAdd} className="btn-primary inline-flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" />添加生图模型
          </button>
        </div>
      ) : (
        <>
          {models.map((m, idx) => (
            <div
              key={m.id}
              className={cn(
                'rounded-xl border transition-colors',
                m.id === settings.activeImageGenModelId
                  ? 'border-tavern-accent bg-tavern-accent-soft/30'
                  : 'border-tavern-border-soft bg-tavern-bg-card'
              )}
            >
              <div
                className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-tavern-bg-hover/50 rounded-t-xl"
                onClick={() => {
                  if (editingId === m.id) { setEditingId(null); resetForm() }
                  else openEdit(m)
                }}
              >
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); moveModel(m.id, 'up') }}
                    disabled={idx === 0}
                    className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30"
                  >
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); moveModel(m.id, 'down') }}
                    disabled={idx === models.length - 1}
                    className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </div>

                <Circle
                  className={cn(
                    'w-3 h-3 shrink-0',
                    m.id === settings.activeImageGenModelId
                      ? 'text-tavern-success fill-current'
                      : 'text-tavern-text-muted'
                  )}
                />

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-tavern-text truncate">{m.name}</div>
                  <div className="text-xs text-tavern-text-muted">
                    {m.provider}
                    {m.model ? ` · ${m.model}` : ''}
                    {m.size ? ` · ${m.size}` : ''}
                    {m.provider === 'openai' && m.quality ? ` · ${m.quality}` : ''}
                    {(m.provider === 'sd-webui' || m.provider === 'comfyui') && m.steps ? ` · ${m.steps}步` : ''}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {m.id === settings.activeImageGenModelId ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent font-medium">
                      使用中
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveImageGenModelId(m.id) }}
                      className="text-xs px-2 py-0.5 rounded border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-accent hover:border-tavern-accent transition-colors"
                    >
                      启用
                    </button>
                  )}
                </div>
              </div>

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

          {showAdd && (
            <div className="rounded-xl border border-tavern-accent bg-tavern-accent-soft/20">
              <div className="px-4 py-3 border-b border-tavern-border-soft flex items-center gap-2 text-sm font-medium text-tavern-accent">
                <Plus className="w-4 h-4" />新建生图配置
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
              <span className="text-sm">添加生图模型</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}
