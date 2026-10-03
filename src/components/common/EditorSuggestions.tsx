import type { EditorSuggestion } from '../../store/editorAssistant'

/** 冲突结果只供查看、复制；用户的新编辑始终保留。 */
export function EditorSuggestions({ suggestions, objectId }: { suggestions: readonly EditorSuggestion[]; objectId: string }) {
  const visible = suggestions.filter(item => item.objectId === objectId)
  if (!visible.length) return null
  return <details className="my-2 rounded border border-tavern-border-soft px-3 py-2 text-xs">
    <summary className="cursor-pointer text-tavern-text-muted">旧 AI 建议（{visible.length}）：输入已变化，未自动应用</summary>
    {visible.map(item => <div key={item.taskId} className="mt-2">
      <p>{item.label}</p>
      <textarea aria-label={`旧建议：${item.label}`} readOnly value={item.content} className="mt-1 w-full min-h-20 bg-tavern-bg-soft p-2" />
    </div>)}
  </details>
}
