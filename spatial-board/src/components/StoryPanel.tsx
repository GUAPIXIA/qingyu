import { useState } from 'react'
import { useSpatialStore } from '../store/spatialStore.ts'
import type { AutoMovePolicy } from '../story-adapter/index.ts'
import { POLICY_LABELS, labelOf } from './labels.ts'

const SAMPLE = `{
  "schemaVersion": 1,
  "expectedRevision": 0,
  "commands": [
    {
      "type": "move_actor",
      "actorId": "actor_user",
      "to": {
        "boardId": "board_home",
        "anchor": { "kind": "node", "nodeId": "place_bedroom" },
        "semanticPosition": {
          "precision": "inside-only",
          "relativeDirection": "inside",
          "note": "角色已跟随用户进入卧室"
        }
      },
      "reason": "assistant_message_explicit_arrival"
    }
  ],
  "summary": "林雪进入卧室",
  "completed": true,
  "confidence": 0.95
}`

export function StoryPanel() {
  const policy = useSpatialStore((s) => s.autoMovePolicy)
  const setPolicy = useSpatialStore((s) => s.setAutoMovePolicy)
  const submit = useSpatialStore((s) => s.submitStoryEnvelope)
  const accept = useSpatialStore((s) => s.acceptSuggestion)
  const reject = useSpatialStore((s) => s.rejectSuggestion)
  const clear = useSpatialStore((s) => s.clearSuggestions)
  const suggestions = useSpatialStore((s) => s.pendingSuggestions)
  const revision = useSpatialStore((s) => s.core.runtime.revision)
  const [text, setText] = useState(SAMPLE.replace('"expectedRevision": 0', `"expectedRevision": ${useSpatialStore.getState().core.runtime.revision}`))
  const [lastResult, setLastResult] = useState('')

  const pending = suggestions.filter((s) => s.status === 'pending')
  const done = suggestions.filter((s) => s.status !== 'pending').slice(-5)

  return (
    <aside className="inspector">
      <h3>剧情命令模拟</h3>
      <div className="field">
        <label>自动移动策略</label>
        <select
          value={policy}
          onChange={(e) => setPolicy(e.target.value as AutoMovePolicy)}
        >
          {(['off', 'suggest', 'auto'] as AutoMovePolicy[]).map((p) => (
            <option key={p} value={p}>
              {labelOf(POLICY_LABELS, p, p)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>
          命令 JSON（当前 revision = {revision}）
        </label>
        <textarea
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={() => {
            const d = submit(text)
            setLastResult(`${d.code}：${d.message}`)
          }}
        >
          提交剧情命令
        </button>
        <button
          type="button"
          onClick={() => {
            setText(
              SAMPLE.replace(
                '"expectedRevision": 0',
                `"expectedRevision": ${useSpatialStore.getState().core.runtime.revision}`
              )
            )
          }}
        >
          填入示例
        </button>
      </div>
      {lastResult && (
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>{lastResult}</p>
      )}

      <h3 style={{ marginTop: 16 }}>待确认（{pending.length}）</h3>
      {pending.length === 0 ? (
        <div className="empty">无待确认建议</div>
      ) : (
        pending.map((s) => (
          <div
            key={s.id}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 8,
              marginBottom: 8,
            }}
          >
            <div style={{ fontSize: 12, marginBottom: 6 }}>{s.label}</div>
            {s.reason && (
              <div style={{ fontSize: 11, color: 'var(--warning)', marginBottom: 6 }}>
                {s.reason}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => accept(s.id)}>
                采用
              </button>
              <button type="button" onClick={() => reject(s.id)}>
                忽略
              </button>
            </div>
          </div>
        ))
      )}
      {done.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>最近处理</h3>
          <ul className="history-list" style={{ margin: 0, paddingLeft: 16 }}>
            {done.map((s) => (
              <li key={s.id}>
                [{s.status}] {s.label}
                {s.reason ? ` · ${s.reason}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" style={{ width: '100%', marginTop: 12 }} onClick={clear}>
        清理已处理
      </button>
    </aside>
  )
}
