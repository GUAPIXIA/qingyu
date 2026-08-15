/**
 * 阶段一：配对审批弹窗 hook（方案 §5.1 PC 侧人工确认）。
 *
 * 安卓端扫码配对 -> 桥接层挂起 -> 通知渲染层 -> 本弹窗询问
 * 「是否允许『XX 的手机』接入？」-> 确认后签发长期令牌 / 拒绝则配对作废。
 */
import { useEffect, useState, useCallback, type ReactNode } from 'react'

interface PairRequest {
  requestId: string
  deviceName: string
}

export function usePairApproval(): ReactNode {
  const [pending, setPending] = useState<PairRequest | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return window.api.bridge.onPairRequest((data) => {
      setPending(data)
    })
  }, [])

  const approve = useCallback(async () => {
    if (!pending) return
    setBusy(true)
    try {
      const result = await window.api.bridge.approvePair(pending.requestId)
      if (!result.ok) {
        console.warn('配对审批失败', result.error)
      }
    } finally {
      setBusy(false)
      setPending(null)
    }
  }, [pending])

  const reject = useCallback(async () => {
    if (!pending) return
    setBusy(true)
    try {
      await window.api.bridge.rejectPair(pending.requestId)
    } finally {
      setBusy(false)
      setPending(null)
    }
  }, [pending])

  if (!pending) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={reject}>
      <div
        className="card w-[360px] p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg font-semibold">允许设备接入？</h2>
        <p className="text-sm text-tavern-text-muted">
          是否允许「<span className="text-tavern-accent font-medium">{pending.deviceName}</span>」
          接入此电脑？配对成功后该设备将获得长期访问令牌，可在「设置 → 手机连接」中随时吊销。
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={reject} disabled={busy} className="btn-secondary">
            拒绝
          </button>
          <button onClick={approve} disabled={busy} className="btn-primary">
            {busy ? '处理中…' : '允许接入'}
          </button>
        </div>
      </div>
    </div>
  )
}
