import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import type { ImageGenModelConfig, ImageGenProvider } from '../../../shared/types'
import type {
  ComfyWorkflowAnalysis,
  ComfyWorkflowImportResult,
  ComfyWorkflowParameter,
  LocalComfyWorkflow,
} from '../../../shared/ipc-api'
import {
  Image, Plus, Trash2, Check, Eye, EyeOff,
  Circle, ChevronUp, ChevronDown, Loader2, FolderOpen, RefreshCw, FileJson2,
  AlertTriangle, RotateCcw, Box,
} from 'lucide-react'

/** 提供商选项 */
const PROVIDERS: Array<{ value: ImageGenProvider; label: string }> = [
  { value: 'openai', label: 'OpenAI DALL-E' },
  { value: 'sd-webui', label: 'SD WebUI (A1111)' },
  { value: 'comfyui', label: 'ComfyUI' },
]

/** OpenAI DALL-E 3 尺寸选项（服务端仅接受这三种） */
const DALLE3_SIZES = ['1024x1024', '1792x1024', '1024x1792']

/** DALL-E 2 尺寸选项（仅正方形；旧模型兼容） */
const DALLE2_SIZES = ['256x256', '512x512', '1024x1024']

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

const IMAGE_QUALITIES = [
  { value: 'standard', label: '标准' },
  { value: 'hd', label: 'HD 高清' },
]

/** 根据 provider 返回空表单默认值 */
function emptyForm(provider: ImageGenProvider = 'openai'): ImageGenModelConfig {
  if (provider === 'comfyui') {
    return {
      id: '', name: '', provider: 'comfyui',
      apiKey: '', baseUrl: 'http://127.0.0.1:8188',
      enabled: true, order: 0,
      workflow: '',
    }
  }
  if (provider === 'sd-webui') {
    return {
      id: '', name: '', provider: 'sd-webui',
      model: '', apiKey: '', baseUrl: 'http://127.0.0.1:7860',
      size: '512x512',
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
  const [analysis, setAnalysis] = useState<ComfyWorkflowAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  const models = [...settings.imageGenModels].sort((a, b) => a.order - b.order)

  const isSdWebui = form.provider === 'sd-webui'
  const isComfyUi = form.provider === 'comfyui'
  const isOpenAi = form.provider === 'openai'
  // 联合类型收窄：ComfyUI 专属字段（workflow / overrides 等）只在 comfyui 分支存在。
  const comfyForm = form.provider === 'comfyui' ? form : null
  // OpenAI 与 SD WebUI 共用尺寸字段；ComfyUI 的尺寸由工作流节点决定。
  const formSize = isOpenAi || isSdWebui ? form.size : ''
  const formSampler = isSdWebui ? form.sampler ?? '' : ''
  // OpenAI 按模型名区分尺寸集合：dall-e-2 用正方形，其余（dall-e-3 等）用标准三档。
  const openAiSizes = form.provider === 'openai' && /dall-e-2/i.test(form.model ?? '') ? DALLE2_SIZES : DALLE3_SIZES
  const standardSizes = isOpenAi ? openAiSizes : SD_SIZES
  const sizeOptions = standardSizes.includes(formSize) ? standardSizes : [formSize, ...standardSizes]
  const sdSamplers = formSampler && !SD_SAMPLERS.includes(formSampler)
    ? [formSampler, ...SD_SAMPLERS]
    : SD_SAMPLERS

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
  const handleProviderChange = (provider: ImageGenProvider) => {
    setForm((f) => {
      const defaults = emptyForm(provider)
      // 保留用户已填写的标识与连接信息，其余按新 provider 重置。
      return {
        ...defaults,
        id: f.id,
        name: f.name,
        apiKey: f.apiKey,
        baseUrl: defaults.baseUrl,
        enabled: f.enabled,
        order: f.order,
      }
    })
    setTestResult(null)
    setWorkflowMessage(null)
  }

  const applyImportedWorkflow = (result: ComfyWorkflowImportResult) => {
    if (!result.success || !result.workflow) {
      if (!result.canceled) setWorkflowMessage({ success: false, text: result.error ?? '导入工作流失败' })
      return
    }
    const analysis = result.analysis
    setAnalysis(result.analysis ?? null)
    setForm((current) => {
      if (current.provider !== 'comfyui') return current
      const inferred = analysis?.promptBindings ?? []
      const positiveIds = inferred.filter((b) => b.role === 'positive').map((b) => b.nodeId)
      const negativeIds = inferred.filter((b) => b.role === 'negative').map((b) => b.nodeId)
      const outputIds = analysis?.outputBindings.map((b) => b.nodeId) ?? []
      // 只有存在歧义时才持久化绑定；唯一确定的入口由运行时自动识别。
      const needsBindings = (analysis?.warnings ?? []).some(
        (w) => w.code === 'ambiguous-prompt' || w.code === 'ambiguous-output',
      )
      return {
        ...current,
        workflow: result.workflow!,
        workflowName: result.sourceName,
        workflowMeta: result.workflowMeta,
        overrides: {},
        ...(needsBindings
          ? { bindings: { positivePromptNodeIds: positiveIds, negativePromptNodeIds: negativeIds, outputNodeIds: outputIds } }
          : { bindings: undefined }),
        name: current.name || result.sourceName || current.name,
      }
    })
    setWorkflowMessage({
      success: true,
      text: `已读取 ${result.sourceName ?? '工作流'} · ${result.nodeCount ?? 0} 个节点${result.converted ? ' · 已转换为 API 格式' : ''}`,
    })
  }

  const handleImportWorkflow = async (path?: string) => {
    setImportingWorkflow(true)
    setWorkflowMessage(null)
    try {
      const result = await window.api.imageGen.importLocalComfyWorkflow(path)
      applyImportedWorkflow(result)
      // 主进程分析拿不到 /object_info，这里补一次带节点定义的分析，
      // 否则模型依赖的可用性校验不会发生。
      if (result.success && result.workflow) {
        await runAnalysis(result.workflow, form.baseUrl, form.apiKey)
      }
    } catch (error) {
      setWorkflowMessage({ success: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setImportingWorkflow(false)
    }
  }

  /**
   * 重建动态参数。
   *
   * `/object_info` 只用于补全控件类型、范围、选项与模型可用性校验；
   * 服务不可达时按 JS 类型降级渲染，不阻塞编辑。
   */
  const runAnalysis = async (workflowJson: string, baseUrl: string, apiKey: string) => {
    if (!workflowJson.trim()) {
      setAnalysis(null)
      return
    }
    setAnalyzing(true)
    try {
      let objectInfo: Record<string, unknown> | undefined
      try {
        const info = await window.api.imageGen.fetchObjectInfo(baseUrl, apiKey)
        if (info.success) objectInfo = info.objectInfo
      } catch {
        // 降级：没有节点定义也能按工作流原值渲染。
      }
      const result = await window.api.imageGen.analyzeComfyWorkflow(workflowJson, objectInfo)
      if (result.success && result.analysis) {
        setAnalysis(result.analysis)
      } else {
        setAnalysis(null)
        setWorkflowMessage({ success: false, text: result.error ?? '分析工作流失败' })
      }
    } catch (error) {
      setAnalysis(null)
      setWorkflowMessage({ success: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAnalyzing(false)
    }
  }

  /** 打开已有 ComfyUI 配置或粘贴 JSON 后，重建参数区。 */
  useEffect(() => {
    if (!isComfyUi || !comfyForm?.workflow?.trim()) {
      setAnalysis(null)
      return
    }
    void runAnalysis(comfyForm.workflow, comfyForm.baseUrl, comfyForm.apiKey)
    // 仅在真正打开一个配置时重建；表单内其他字段变化不触发网络请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComfyUi, editingId, showAdd])

  /** 写入单参数覆盖；尺寸类型需同时覆盖配对的 height。 */
  const setOverride = (param: ComfyWorkflowParameter, value: unknown) => {
    setForm((f) => {
      if (f.provider !== 'comfyui') return f
      const overrides = { ...(f.overrides ?? {}) }
      overrides[param.id] = value
      if (param.type === 'size' && param.pairedInputName) {
        const [width, height] = String(value).split('x')
        const w = Number(width)
        const h = Number(height)
        if (Number.isFinite(w) && Number.isFinite(h)) {
          overrides[param.id] = w
          overrides[`${param.nodeId}.${param.pairedInputName}`] = h
        }
      }
      return { ...f, overrides }
    })
  }

  /** 撤销单参数覆盖，回到工作流原值。尺寸类型同时清除配对项。 */
  const resetOverride = (param: ComfyWorkflowParameter) => {
    setForm((f) => {
      if (f.provider !== 'comfyui' || !f.overrides) return f
      const overrides = { ...f.overrides }
      delete overrides[param.id]
      if (param.type === 'size' && param.pairedInputName) {
        delete overrides[`${param.nodeId}.${param.pairedInputName}`]
      }
      return { ...f, overrides: Object.keys(overrides).length > 0 ? overrides : undefined }
    })
  }

  const resetAllOverrides = () => setForm((f) => (
    f.provider === 'comfyui' ? { ...f, overrides: undefined } : f
  ))

  /** 当前显示值：有覆盖用覆盖值，否则用工作流原值。 */
  const paramValue = (param: ComfyWorkflowParameter): unknown => {
    if (form.provider !== 'comfyui') return param.workflowValue
    const overridden = form.overrides?.[param.id]
    return overridden !== undefined ? overridden : param.workflowValue
  }

  const isOverridden = (param: ComfyWorkflowParameter): boolean => (
    form.provider === 'comfyui' && form.overrides?.[param.id] !== undefined
  )

  const overrideCount = form.provider === 'comfyui' && form.overrides
    ? Object.keys(form.overrides).length
    : 0

  /** 单个动态参数控件；覆盖过的项显示「已改」标记与还原按钮。 */
  const renderParameter = (param: ComfyWorkflowParameter) => {
    const value = paramValue(param)
    const overridden = isOverridden(param)
    const numberValue = typeof value === 'number' ? value : Number(value)

    let control: JSX.Element
    if (param.type === 'size') {
      // 尺寸在快照中是 width/height 两个输入，覆盖时需成对写入。
      const stored = String(param.workflowValue ?? '').split('x')
      const storedWidth = Number(stored[0])
      const storedHeight = Number(stored[1])
      const overrides = form.provider === 'comfyui' ? form.overrides : undefined
      const heightKey = `${param.nodeId}.${param.pairedInputName ?? 'height'}`
      const rawWidth = overrides?.[param.id]
      const rawHeight = overrides?.[heightKey]
      const width = typeof rawWidth === 'number' ? rawWidth : storedWidth
      const height = typeof rawHeight === 'number' ? rawHeight : storedHeight

      const commit = (nextWidth: number, nextHeight: number) => {
        setForm((f) => {
          if (f.provider !== 'comfyui') return f
          const next = { ...(f.overrides ?? {}) }
          next[param.id] = nextWidth
          next[heightKey] = nextHeight
          return { ...f, overrides: next }
        })
      }

      control = (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            className="input text-xs w-20"
            aria-label={`${param.label} 宽`}
            value={Number.isFinite(width) ? width : ''}
            min={param.min}
            max={param.max}
            step={param.step ?? 8}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (Number.isFinite(next)) commit(next, height)
            }}
          />
          <span className="text-xs text-tavern-text-muted">×</span>
          <input
            type="number"
            className="input text-xs w-20"
            aria-label={`${param.label} 高`}
            value={Number.isFinite(height) ? height : ''}
            min={param.min}
            max={param.max}
            step={param.step ?? 8}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (Number.isFinite(next)) commit(width, next)
            }}
          />
        </div>
      )
    } else if (param.type === 'select') {
      const options = (param.options ?? []).filter((o): o is string => typeof o === 'string')
      const current = String(value)
      const list = options.includes(current) || !current ? options : [current, ...options]
      control = (
        <select
          className="input text-xs"
          value={current}
          onChange={(e) => setOverride(param, e.target.value)}
        >
          {list.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      )
    } else if (param.type === 'boolean') {
      control = (
        <input
          type="checkbox"
          className="mt-1"
          checked={value === true}
          onChange={(e) => setOverride(param, e.target.checked)}
        />
      )
    } else if (param.type === 'number') {
      control = (
        <input
          type="number"
          className="input text-xs"
          value={Number.isFinite(numberValue) ? numberValue : ''}
          min={param.min}
          max={param.max}
          step={param.step ?? 1}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (Number.isFinite(next)) setOverride(param, next)
          }}
        />
      )
    } else {
      control = (
        <input
          type="text"
          className="input text-xs"
          value={String(value ?? '')}
          onChange={(e) => setOverride(param, e.target.value)}
        />
      )
    }

    return (
      <div key={param.id} className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-tavern-text-soft truncate">{param.label}</span>
            {overridden && (
              <span className="text-[10px] px-1 rounded bg-tavern-accent-soft text-tavern-accent shrink-0">已改</span>
            )}
          </div>
          <div className="text-[10px] text-tavern-text-muted font-mono truncate">{param.id}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {control}
          {overridden && (
            <button
              type="button"
              onClick={() => resetOverride(param)}
              title="恢复工作流原值"
              className="p-1 rounded text-tavern-text-muted hover:text-tavern-accent"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    )
  }

  /** 按节点分组的动态参数区；无有效工作流时不渲染。 */
  const renderDynamicParameters = () => {
    if (!analysis) return null
    const groups = analysis.parameterGroups.filter(
      (group) => group.parameters.some((param) => !param.advanced),
    )
    const advancedGroups = analysis.parameterGroups.filter(
      (group) => group.parameters.some((param) => param.advanced),
    )
    if (groups.length === 0 && advancedGroups.length === 0) return null

    return (
      <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/60 p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-tavern-text">
            <Box className="w-3.5 h-3.5 text-tavern-accent" />
            工作流参数
            {overrideCount > 0 && (
              <span className="text-[10px] px-1.5 rounded bg-tavern-accent-soft text-tavern-accent">
                {overrideCount} 项已覆盖
              </span>
            )}
          </div>
          {overrideCount > 0 && (
            <button
              type="button"
              onClick={resetAllOverrides}
              className="text-[11px] text-tavern-text-muted hover:text-tavern-accent"
            >
              全部还原
            </button>
          )}
        </div>

        {groups.map((group) => (
          <div key={group.id} className="space-y-1.5">
            <div className="text-[11px] text-tavern-text-muted">
              {group.title}
              <span className="ml-1.5 text-tavern-text-muted/70">{group.classType}</span>
            </div>
            {group.parameters.filter((p) => !p.advanced).map(renderParameter)}
          </div>
        ))}

        {advancedGroups.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-[11px] text-tavern-text-muted hover:text-tavern-text select-none">
              高级参数（种子等）
            </summary>
            <div className="mt-2 space-y-3">
              {advancedGroups.map((group) => (
                <div key={group.id} className="space-y-1.5">
                  <div className="text-[11px] text-tavern-text-muted">{group.title}</div>
                  {group.parameters.filter((p) => p.advanced).map(renderParameter)}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    )
  }

  /** 模型依赖卡：列出 Loader 引用的模型文件，并在 /object_info 可用时校验存在性。 */
  const renderDependencies = () => {
    if (!analysis || analysis.dependencies.length === 0) return null
    return (
      <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/60 p-3 space-y-2">
        <div className="text-xs font-medium text-tavern-text">模型依赖</div>
        {analysis.dependencies.map((dep) => (
          <div key={`${dep.nodeId}.${dep.inputName}`} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] text-tavern-text-muted">{dep.label}</div>
              <div className="text-xs text-tavern-text-soft font-mono truncate">{dep.value}</div>
            </div>
            {dep.available === false ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-tavern-danger/10 text-tavern-danger shrink-0">
                未找到
              </span>
            ) : dep.available === true ? (
              <Check className="w-3 h-3 text-tavern-success shrink-0" />
            ) : (
              <span className="text-[10px] text-tavern-text-muted shrink-0">未校验</span>
            )}
          </div>
        ))}
      </div>
    )
  }

  /** 工作流检查卡：展示分析警告与可用性结论。 */
  const renderWorkflowCheck = () => {
    if (!analysis) return null
    const kindLabel: Record<ComfyWorkflowAnalysis['kind'], string> = {
      'text-to-image': '文生图',
      'image-to-image': '图生图',
      video: '视频',
      unknown: '未知类型',
    }
    return (
      <div className={cn(
        'rounded-xl border p-3 space-y-2',
        analysis.compatible
          ? 'border-tavern-success/25 bg-tavern-success/5'
          : 'border-tavern-warning/30 bg-tavern-warning/5',
      )}>
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {analysis.compatible
            ? <Check className="w-3.5 h-3.5 text-tavern-success" />
            : <AlertTriangle className="w-3.5 h-3.5 text-tavern-warning" />}
          <span className={analysis.compatible ? 'text-tavern-success' : 'text-tavern-warning'}>
            {analysis.compatible ? '工作流可用' : '工作流需要确认'}
          </span>
          <span className="text-tavern-text-muted font-normal">
            {kindLabel[analysis.kind]} · {analysis.nodeCount} 节点
          </span>
        </div>
        {analysis.warnings.length > 0 && (
          <ul className="space-y-1">
            {analysis.warnings.map((warning) => (
              <li key={warning.code} className="text-[11px] text-tavern-text-muted flex gap-1.5">
                <span className="text-tavern-text-muted/60">•</span>
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  /** ComfyUI 工作流选择与读取；位于表单首位，切换下拉即读取。 */
  const renderComfyWorkflowPicker = () => (
    <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/60 p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-tavern-text">
            <FileJson2 className="w-3.5 h-3.5 text-tavern-accent" />
            ComfyUI Desktop 工作流
          </div>
          <p className="text-[11px] text-tavern-text-muted mt-1">
            工作流是参数的唯一来源。自动读取 Desktop 安装目录并转换为可执行格式。
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
        <select
          className="input text-xs"
          value={selectedWorkflowPath}
          onChange={(e) => {
            setSelectedWorkflowPath(e.target.value)
            // 切换即读取，去掉额外的确认按钮。
            if (e.target.value) void handleImportWorkflow(e.target.value)
          }}
        >
          {localWorkflows.map((workflow) => (
            <option key={workflow.path} value={workflow.path}>
              {workflow.name} · {workflow.installation}
            </option>
          ))}
        </select>
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

      {importingWorkflow && (
        <div className="text-xs text-tavern-text-muted flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />正在读取并分析…
        </div>
      )}

      {(workflowMessage || comfyForm?.workflowName) && (
        <div className={cn(
          'text-xs rounded-lg px-2.5 py-2 border',
          workflowMessage?.success !== false
            ? 'border-tavern-success/25 bg-tavern-success/10 text-tavern-success'
            : 'border-tavern-danger/25 bg-tavern-danger/10 text-tavern-danger',
        )}>
          {workflowMessage?.text ?? `已载入 ${comfyForm?.workflowName}`}
        </div>
      )}
    </div>
  )

  /** 高级区：原始 JSON，默认折叠。 */
  const renderAdvancedJson = () => (
    <details className="group">
      <summary className="cursor-pointer text-xs text-tavern-text-muted hover:text-tavern-text select-none">
        高级：查看或粘贴 API 工作流 JSON
      </summary>
      <div className="mt-2">
        <textarea
          className="textarea text-xs font-mono min-h-36"
          value={comfyForm?.workflow ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, workflow: e.target.value, workflowName: undefined }))}
          placeholder="也可以直接粘贴 ComfyUI 导出的 API 格式工作流"
          spellCheck={false}
        />
        <p className="text-xs text-tavern-text-muted mt-1 leading-relaxed">
          支持 {'{{prompt}}'}、{'{{negative_prompt}}'}、{'{{width}}'}、{'{{height}}'} 和 {'{{seed}}'} 占位符。
          其余参数（Steps、CFG、采样器等）请通过节点级覆盖修改，不再提供全局占位符。
        </p>
      </div>
    </details>
  )

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
    // ComfyUI 必须已有可执行工作流；否则保存后无法生图。
    if (form.provider === 'comfyui' && !form.workflow?.trim()) return
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

      {/* ComfyUI：工作流选择器位于参数之前，因为工作流是参数的唯一来源 */}
      {isComfyUi && (
        <>
          {renderComfyWorkflowPicker()}
          {analyzing && (
            <div className="text-xs text-tavern-text-muted flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />正在分析工作流…
            </div>
          )}
          {renderWorkflowCheck()}
          {renderDynamicParameters()}
          {renderDependencies()}
          {renderAdvancedJson()}
        </>
      )}

      {/* 模型名称：ComfyUI 的模型由工作流内的 Loader 节点决定，故不显示该输入框 */}
      {!isComfyUi && (
        <div>
          <label className="label">模型名称</label>
          <input
            type="text"
            className="input text-sm"
            value={form.model ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder={isSdWebui ? '（可选，如 v1-5-pruned）' : '例如 dall-e-3'}
          />
        </div>
      )}

      {/* 尺寸：OpenAI 与 SD WebUI 使用固定字段；ComfyUI 由工作流 Latent 节点决定 */}
      {!isComfyUi && (
        <div>
          <label className="label">图片尺寸（默认值，可在快捷面板覆盖）</label>
          <select
            className="input text-sm"
            value={formSize}
            onChange={(e) => setForm((f) => (f.provider === 'comfyui' ? f : { ...f, size: e.target.value }))}
          >
            {sizeOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      )}

      {/* 质量（仅 OpenAI 显示） */}
      {isOpenAi && (
        <div>
          <label className="label">生成质量</label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {IMAGE_QUALITIES.map((q) => (
              <button
                key={q.value}
                onClick={() => setForm((f) => (f.provider === 'openai' ? { ...f, quality: q.value } : f))}
                className={cn(
                  'px-2.5 py-1 rounded text-xs border transition-colors',
                  form.provider === 'openai' && form.quality === q.value
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

      {/* SD WebUI 扩散参数：ComfyUI 的同类参数由工作流节点决定，见阶段三的动态参数区 */}
      {isSdWebui && (
        <>
          {/* 负面提示词 */}
          <div>
            <label className="label">负面提示词</label>
            <textarea
              className="input text-xs resize-none"
              rows={2}
              value={form.negativePrompt ?? ''}
              onChange={(e) => setForm((f) => (f.provider === 'sd-webui' ? { ...f, negativePrompt: e.target.value } : f))}
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
                value={form.provider === 'sd-webui' ? form.steps ?? 20 : 20}
                min={1}
                max={150}
                onChange={(e) => setForm((f) => (
                  f.provider === 'sd-webui' ? { ...f, steps: parseInt(e.target.value) || 20 } : f
                ))}
              />
            </div>
            <div>
              <label className="label">CFG Scale</label>
              <input
                type="number"
                className="input text-sm"
                value={form.provider === 'sd-webui' ? form.cfgScale ?? 7 : 7}
                min={1}
                max={30}
                step={0.5}
                onChange={(e) => setForm((f) => (
                  f.provider === 'sd-webui' ? { ...f, cfgScale: parseFloat(e.target.value) || 7 } : f
                ))}
              />
            </div>
          </div>

          {/* 采样器 */}
          <div>
            <label className="label">采样器</label>
            <select
              className="input text-sm"
              value={formSampler || 'Euler a'}
              onChange={(e) => setForm((f) => (f.provider === 'sd-webui' ? { ...f, sampler: e.target.value } : f))}
            >
              {sdSamplers.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleSave}
          disabled={!form.name.trim() || (isComfyUi && !comfyForm?.workflow?.trim())}
          title={isComfyUi && !comfyForm?.workflow?.trim() ? '请先选择或粘贴工作流' : undefined}
          className="btn-primary text-xs"
        >
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
                    {m.provider === 'comfyui'
                      ? (m.workflowName ? ` · ${m.workflowName}` : '')
                      : (m.model ? ` · ${m.model}` : '')}
                    {m.provider !== 'comfyui' && m.size ? ` · ${m.size}` : ''}
                    {m.provider === 'openai' && m.quality ? ` · ${m.quality}` : ''}
                    {m.provider === 'sd-webui' && m.steps ? ` · ${m.steps}步` : ''}
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
