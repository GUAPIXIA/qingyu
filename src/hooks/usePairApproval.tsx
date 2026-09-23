/**
 * 阶段一：配对审批弹窗 hook（方案 §5.1 PC 侧人工确认）。
 *
 * 安卓端扫码配对 -> 桥接层挂起 -> 通知渲染层 -> 本弹窗询问
 * 「是否允许『XX 的手机』接入？」-> 确认后签发长期令牌 / 拒绝则配对作废。
 *
 * UEX-P1-21：配对审批过期倒计时——
 * - 弹窗展示「剩余 mm:ss」倒计时（每秒更新）；剩余 <60s 转 danger 色视觉警示；
 * - 到期自动关闭弹窗并轻提示「配对请求已过期」（不静默消失）；
 * - 到期后提交前校验拦截，不再发起审批；审批失败仍保持弹窗可重试（语义不变）。
 */
import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { pushToast } from '../store/useToastStore'

/** UEX-P1-21：配对审批请求（expiresAt = 审批有效期截止时间戳 ms） */
interface PairRequest {
  requestId: string
  deviceName: string
  expiresAt: number
}

/**
 * UEX-P1-21：审批有效期回退窗口（ms）——与主进程一致：
 * electron/bridge/routes.ts PAIR_WAIT_TIMEOUT_MS（55s，安卓端 readTimeout 60s 内，
 * 超时主进程自动 408 拒绝）。旧主进程未下发 expiresAt 时按「请求到达 + 该窗口」推算。
 */
const PAIR_APPROVAL_WINDOW_MS = 55_000

/** UEX-P1-21：剩余不足该值（ms）时倒计时转 danger 色警示 */
const COUNTDOWN_WARN_MS = 60_000

/** UEX-P1-21：剩余时间格式化为 mm:ss */
function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000))
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0')
  const ss = String(totalSec % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function usePairApproval(): ReactNode {
  const [pending, setPending] = useState<PairRequest | null>(null)
  const [remainingMs, setRemainingMs] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return window.api.bridge.onPairRequest((data) => {
      // UEX-P1-21：expiresAt 为可选增量（兼容旧主进程）；缺省按「请求到达 + 审批窗口」推算
      const expiresAt = data.expiresAt ?? Date.now() + PAIR_APPROVAL_WINDOW_MS
      setRemainingMs(expiresAt - Date.now())
      setPending({ requestId: data.requestId, deviceName: data.deviceName, expiresAt })
    })
  }, [])

  /**
   * UEX-P1-21：关闭过期请求并提示「配对请求已过期」（不静默消失）。
   * variant：到期自动关闭 = warning（轻提示）；提交前拦截 = error（错误提示）。
   */
  const expireNow = useCallback((requestId: string, variant: 'warning' | 'error') => {
    setPending((cur) => (cur?.requestId === requestId ? null : cur))
    pushToast({
      variant,
      title: '配对请求已过期',
      description: variant === 'error' ? '该请求已失效，请在手机上重新发起配对' : '请在手机上重新发起配对',
      requestId: 'pair-expired',
    })
  }, [])

  // UEX-P1-21：每秒走秒（busy 态下继续走秒）；到期自动关闭弹窗并轻提示。
  useEffect(() => {
    if (!pending) return
    const tick = () => {
      const remaining = pending.expiresAt - Date.now()
      if (remaining <= 0) {
        expireNow(pending.requestId, 'warning')
        return
      }
      setRemainingMs(remaining)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [pending, expireNow])

  const approve = useCallback(async () => {
    if (!pending) return
    // UEX-P1-21：提交前校验有效期，过期请求拒绝提交（错误提示 + 关闭弹窗）
    if (Date.now() >= pending.expiresAt) {
      expireNow(pending.requestId, 'error')
      return
    }
    setBusy(true)
    try {
      const result = await window.api.bridge.approvePair(pending.requestId)
      // UEX-P1-21：提交过程中到期按失败处理——「配对请求已过期」提示已由倒计时统一发出，
      // 此处不再报「已允许配对」也不重复报错（以「已过期」为最终结果，避免误导）。
      if (Date.now() >= pending.expiresAt) return
      if (!result.ok) {
        pushToast({ variant: 'error', title: '配对审批失败', description: result.error ?? '', requestId: 'pair-approve' })
        return // 保持弹窗，可重试
      }
      pushToast({ variant: 'success', title: '已允许配对' })
    } catch (e) {
      // UEX-P1-21：同上，提交中过期按失败/过期收敛，不再叠加错误提示
      if (Date.now() >= pending.expiresAt) return
      pushToast({ variant: 'error', title: '配对审批失败', description: e instanceof Error ? e.message : String(e), requestId: 'pair-approve' })
      return
    } finally {
      setBusy(false)
    }
    setPending((cur) => (cur?.requestId === pending.requestId ? null : cur))
  }, [pending, expireNow])

  const reject = useCallback(async () => {
    if (!pending) return
    // UEX-P1-21：提交前校验有效期，过期请求不再提交（拒绝同样拦截）
    if (Date.now() >= pending.expiresAt) {
      expireNow(pending.requestId, 'error')
      return
    }
    setBusy(true)
    try {
      await window.api.bridge.rejectPair(pending.requestId)
    } finally {
      setBusy(false)
      setPending((cur) => (cur?.requestId === pending.requestId ? null : cur))
    }
  }, [pending, expireNow])

  if (!pending) return null

  // UEX-P1-21：剩余 <60s 视觉警示（danger 色）
  const warning = remainingMs < COUNTDOWN_WARN_MS

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={() => { /* M7：遮罩不 reject */ }}>
      <div
        className="card w-[360px] p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg font-semibold">允许设备接入？</h2>
        <p className="text-sm text-tavern-text-muted">
          是否允许「<span className="text-tavern-accent font-medium">{pending.deviceName}</span>」
          接入此电脑？配对成功后该设备将获得长期访问令牌，可在「设置 → 手机连接」中随时吊销。
        </p>
        <div className="flex items-center justify-between">
          {/* UEX-P1-21：审批有效期倒计时（剩余 <60s 转 danger 色警示） */}
          <span className={`text-sm tabular-nums ${warning ? 'text-tavern-danger' : 'text-tavern-text-muted'}`}>
            剩余 {formatCountdown(remainingMs)}
          </span>
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
    </div>
  )
}
