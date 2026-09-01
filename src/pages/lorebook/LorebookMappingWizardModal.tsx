import { useEffect, useRef, useState } from 'react'
import { FileQuestion, Loader2, Save, Upload, Wand2 } from 'lucide-react'
import { Modal } from '../../components/common/Modal'
import { logError } from '../../lib/logger'
import type { LorebookImportResult } from '../../../shared/ipc-api'
import type { LorebookMappingTemplate } from '../../../shared/lorebook/adapters/mapping'

interface Props {
  /** 导入成功后回调（页面负责把世界书加入列表并弹出兼容性报告）。 */
  onImported: (result: LorebookImportResult) => void
  onClose: () => void
}

const EMPTY_FIELDS = {
  keys: '',
  content: '',
  title: '',
  secondaryKeys: '',
  enabled: '',
  order: '',
  probability: '',
  constant: '',
  useRegex: '',
}

type FieldState = typeof EMPTY_FIELDS

const FIELD_LABELS: Array<{ key: keyof FieldState; label: string; hint?: string }> = [
  { key: 'keys', label: '关键词字段', hint: '数组或逗号分隔字符串' },
  { key: 'content', label: '正文字段' },
  { key: 'title', label: '标题字段（可选）' },
  { key: 'secondaryKeys', label: '二级关键词字段（可选）' },
  { key: 'enabled', label: '启用字段（可选）' },
  { key: 'order', label: '顺序字段（可选）' },
  { key: 'probability', label: '概率字段（可选）' },
  { key: 'constant', label: '常驻字段（可选）' },
  { key: 'useRegex', label: '正则标记字段（可选）' },
]

/**
 * 阶段 6 P2：未知 Tavern fork / 通用 JSON 的受限映射向导。
 * 打开文件 → 展示截断预览与猜测模板 → 用户调整字段路径 → 导入并可选保存模板。
 * 模板只搬运字段路径，不执行任何表达式或脚本。
 */
export function LorebookMappingWizardModal({ onImported, onClose }: Props) {
  const [source, setSource] = useState<{ sourceId: string; fileName: string; preview: unknown } | null>(null)
  const [entriesPath, setEntriesPath] = useState('')
  const [namePath, setNamePath] = useState('')
  const [fields, setFields] = useState<FieldState>(EMPTY_FIELDS)
  const [templates, setTemplates] = useState<LorebookMappingTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('通用映射模板')
  const [saveTemplate, setSaveTemplate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openedRef = useRef(false)

  useEffect(() => {
    if (openedRef.current) return
    openedRef.current = true
    void (async () => {
      try {
        const opened = await window.api.lorebook.openMappingSource()
        if (!opened) { onClose(); return }
        setSource({ sourceId: opened.sourceId, fileName: opened.fileName, preview: opened.preview })
        if (opened.guessedTemplate) applyTemplate(opened.guessedTemplate)
        setTemplates(await window.api.lorebook.listMappingTemplates())
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [onClose])

  const applyTemplate = (template: LorebookMappingTemplate) => {
    setEntriesPath(template.entriesPath)
    setNamePath(template.namePath ?? '')
    setFields({ ...EMPTY_FIELDS, ...Object.fromEntries(Object.entries(template.fields).map(([key, value]) => [key, value ?? ''])) } as FieldState)
    setTemplateName(template.name)
    setSelectedTemplateId(template.id)
  }

  const loadTemplate = (id: string) => {
    setSelectedTemplateId(id)
    const template = templates.find((item) => item.id === id)
    if (template) applyTemplate(template)
  }

  const buildTemplate = (): LorebookMappingTemplate => {
    const now = Date.now()
    return {
      id: selectedTemplateId || 'guess',
      name: templateName.trim() || '通用映射模板',
      createdAt: now,
      updatedAt: now,
      entriesPath: entriesPath.trim(),
      ...(namePath.trim() ? { namePath: namePath.trim() } : {}),
      fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim() || undefined])) as FieldState,
    }
  }

  const handleImport = async () => {
    if (!source) return
    if (!fields.keys.trim() || !fields.content.trim()) {
      setError('关键词字段与正文字段为必填路径')
      return
    }
    setBusy(true); setError(null)
    try {
      const template = buildTemplate()
      const result = await window.api.lorebook.importWithTemplate(source.sourceId, template)
      if (saveTemplate) {
        await window.api.lorebook.saveMappingTemplate(template)
      }
      onImported(result)
    } catch (e) {
      logError('LorebookMappingWizardModal', e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="映射向导导入"
      width="lg"
      footer={(
        <div className="flex items-center justify-between w-full gap-2">
          <span className="text-xs text-tavern-text-muted truncate">
            {source ? `已选择：${source.fileName}` : '正在打开文件…'}
          </span>
          <div className="flex gap-2 shrink-0">
            <button className="btn-secondary px-4 py-2" onClick={onClose}>取消</button>
            <button className="btn-primary px-4 py-2" onClick={() => void handleImport()} disabled={!source || busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              按模板导入
            </button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <p className="text-xs text-tavern-text-muted leading-relaxed">
          未知格式的 Tavern fork 世界书可以用映射向导导入：选择条目数组和关键字段的路径即可。
          模板只做字段搬运，不会执行任何表达式或脚本；未映射的字段会保留在调试信息中。
        </p>

        {templates.length > 0 && (
          <label className="block text-sm">
            载入已保存的模板
            <select className="input text-sm mt-1" value={selectedTemplateId} onChange={(event) => loadTemplate(event.target.value)}>
              <option value="">不使用（手动填写）</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </select>
          </label>
        )}

        {!source && !error && (
          <div className="flex items-center gap-2 text-sm text-tavern-text-muted py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> 正在打开文件…
          </div>
        )}

        {source && (
          <>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <label>条目数组路径
                <input className="input text-sm mt-1" value={entriesPath} onChange={(event) => setEntriesPath(event.target.value)} placeholder="如 entries 或 data.book.entries；顶层为数组时留空" />
              </label>
              <label>书名字段路径（可选）
                <input className="input text-sm mt-1" value={namePath} onChange={(event) => setNamePath(event.target.value)} placeholder="留空时读取顶层 name" />
              </label>
            </div>

            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              {FIELD_LABELS.map((field) => (
                <label key={field.key}>
                  {field.label}
                  <input
                    className="input text-sm mt-1"
                    value={fields[field.key]}
                    onChange={(event) => setFields((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    placeholder={field.hint}
                  />
                </label>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={saveTemplate} onChange={(event) => setSaveTemplate(event.target.checked)} />
              <Save className="w-4 h-4" /> 保存为可复用模板
              {saveTemplate && (
                <input className="input text-sm" value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
              )}
            </label>

            <details className="rounded-lg border border-tavern-border-soft">
              <summary className="cursor-pointer text-xs text-tavern-text-muted px-3 py-2 flex items-center gap-1.5">
                <FileQuestion className="w-3.5 h-3.5" /> 查看文件结构预览（长文本与深层内容已截断）
              </summary>
              <pre className="text-xs px-3 pb-3 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(source.preview, null, 2)}</pre>
            </details>
          </>
        )}

        {error && (
          <p className="text-xs text-tavern-danger flex items-center gap-1.5"><Upload className="w-3.5 h-3.5" />{error}</p>
        )}
      </div>
    </Modal>
  )
}
