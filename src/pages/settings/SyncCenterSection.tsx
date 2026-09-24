/**
 * 设置页「同步中心」（阶段 7 S7-06/S7-07）。
 *
 * - 本地未同步变更 / 健康状态；
 * - 「允许局域网同步」：5 分钟一次性授权窗 + QR + 短认证串核对；
 * - 冲突列表与解决（保留本机 / 保留对端 / 标记已处理）；
 * - 进度、服务器同步入口（阶段 8 启用）不在本期。
 *
 * 约束（方案 S7-07）：不提供默认自动同步；提醒只统计本地 backlog。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  AlertTriangle,
  Check,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Wifi,
  X,
} from 'lucide-react'
import { SectionCard } from '../../components/common/SettingsShared'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { pushToast } from '../../store/useToastStore'
import type { SyncCenterStatus, SyncConflictItem, SyncPeerDevice, SyncTombstoneDryRun } from '../../../shared/ipc-api'

const PHASE_LABEL: Record<string, string> = {
  idle: '未开启',
  open: '等待扫码（5 分钟内）',
  awaiting_confirm: '等待核对短认证串',
  confirmed: '已授权',
  revoked: '已吊销',
  expired: '已过期',
}

const SUGGESTION_LABEL: Record<string, string> = {
  prefer_local: '建议保留本机',
  prefer_remote: '建议保留对端',
  manual_merge: '建议手动合并',
  copy_as_new: '可复制为新实体',
  confirm_delete_vs_modify: '删除 vs 修改，需单独确认',
  resolve_dependency: '依赖冲突，需处理父实体',
}

export function SyncCenterSection() {
  const [status, setStatus] = useState<SyncCenterStatus | null>(null)
  const [conflicts, setConflicts] = useState<SyncConflictItem[]>([])
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shortAuthInput, setShortAuthInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [resolveTarget, setResolveTarget] = useState<{ id: string; choice: 'local' | 'remote' | 'manual' } | null>(null)
  const [devices, setDevices] = useState<SyncPeerDevice[]>([])
  const [tombstoneReport, setTombstoneReport] = useState<SyncTombstoneDryRun | null>(null)
  const [retireTarget, setRetireTarget] = useState<SyncPeerDevice | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [st, list, peers, dry] = await Promise.all([
        window.api.syncCenter.status(),
        window.api.syncCenter.listConflicts('open'),
        window.api.syncCenter.listDevices(),
        window.api.syncCenter.tombstoneDryRun(),
      ])
      setStatus(st)
      setConflicts(list)
      setDevices(peers)
      setTombstoneReport(dry)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh])

  // 授权窗打开时轮询，捕捉 peer hello / 过期
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    const phase = status?.lanAuthPhase
    if (phase === 'open' || phase === 'awaiting_confirm') {
      pollRef.current = setInterval(() => {
        void refresh()
      }, 1500)
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [status?.lanAuthPhase, refresh])

  // QR
  useEffect(() => {
    const raw = status?.qrJson
    if (!raw) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(raw, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [status?.qrJson])

  const startLanAuth = async () => {
    setBusy(true)
    setError(null)
    try {
      const bridge = await window.api.bridge.status()
      const bound = bridge.bound ?? { host: bridge.config.host || '127.0.0.1', port: bridge.config.port || 8321 }
      const pairing = await window.api.bridge.pairingInfo()
      const st = await window.api.syncCenter.startLanAuth({
        host: bound.host,
        port: bound.port,
        fingerprint: pairing.fingerprint,
        displayName: pairing.displayName || 'PC',
      })
      setStatus(st)
      setShortAuthInput('')
      pushToast({ variant: 'info', title: '已开启局域网同步授权（5 分钟）', durationMs: 3000 })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirmPeer = async () => {
    if (!status?.lanSessionId) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.syncCenter.confirmPeer({
        sessionId: status.lanSessionId,
        shortAuth: shortAuthInput.trim(),
      })
      setStatus(r.status)
      if (!r.ok) {
        setError(r.error === 'short_auth_mismatch' ? '短认证串不匹配，请核对两端数字' : (r.error ?? '确认失败'))
      } else {
        pushToast({ variant: 'success', title: '局域网同步已授权', durationMs: 3000 })
        setShortAuthInput('')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    setBusy(true)
    try {
      setStatus(await window.api.syncCenter.revokeLanAuth())
      setShortAuthInput('')
    } finally {
      setBusy(false)
    }
  }

  const doResolve = async () => {
    if (!resolveTarget) return
    setBusy(true)
    try {
      const r = await window.api.syncCenter.resolveConflict(resolveTarget)
      setStatus(r.status)
      setConflicts(await window.api.syncCenter.listConflicts('open'))
      pushToast({
        variant: r.ok ? 'success' : 'warning',
        title: r.ok ? '冲突已标记解决' : '解决失败',
        durationMs: 2500,
      })
    } finally {
      setBusy(false)
      setResolveTarget(null)
    }
  }

  const doRetire = async () => {
    if (!retireTarget) return
    setBusy(true)
    try {
      const r = await window.api.syncCenter.retireDevice(retireTarget.deviceId)
      setStatus(r.status)
      setDevices(await window.api.syncCenter.listDevices())
      setTombstoneReport(await window.api.syncCenter.tombstoneDryRun())
      pushToast({
        variant: r.ok ? 'success' : 'warning',
        title: r.ok ? '设备已退役（须重新授权）' : '退役失败',
        durationMs: 3000,
      })
    } finally {
      setBusy(false)
      setRetireTarget(null)
    }
  }

  const phase = status?.lanAuthPhase ?? 'idle'
  const expiresIn =
    status?.lanExpiresAt && (phase === 'open' || phase === 'awaiting_confirm')
      ? Math.max(0, Math.ceil((status.lanExpiresAt - Date.now()) / 1000))
      : null

  return (
    <SectionCard title="同步中心" icon={<RefreshCw className="w-4 h-4" />} storageKey="sync-center">
      <div className="mt-3 space-y-4">
        {/* 状态摘要 */}
        <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/40 px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-tavern-text-soft">
            <span>
              本地未同步变更{' '}
              <span className="font-mono tabular-nums text-tavern-text">{status?.journalBacklog ?? 0}</span>
            </span>
            <span>
              待解决冲突{' '}
              <span className="font-mono tabular-nums text-tavern-text">{status?.openConflicts ?? 0}</span>
            </span>
            <span>
              实体{' '}
              <span className="font-mono tabular-nums text-tavern-text">{status?.heads ?? 0}</span>
            </span>
          </div>
          {status?.needsFullRescan && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-tavern-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              同步已暂停，需全量重建索引后才能继续。{status.healthReason ? `（${status.healthReason}）` : ''}
            </p>
          )}
          <p className="mt-2 text-[11px] text-tavern-text-muted">
            同步由你手动触发，不会自动上传。服务器同步将在后续版本开放。
          </p>
        </div>

        {/* 局域网一次性授权 */}
        <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-card/55 p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Wifi className="h-4 w-4 text-tavern-accent" />
              <div>
                <p className="text-sm font-medium text-tavern-text">局域网同步</p>
                <p className="text-[11px] text-tavern-text-muted">
                  状态：{PHASE_LABEL[phase] ?? phase}
                  {expiresIn != null ? ` · ${expiresIn}s 后过期` : ''}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {phase === 'idle' || phase === 'revoked' || phase === 'expired' || phase === 'confirmed' ? (
                <button type="button" onClick={startLanAuth} disabled={busy} className="btn-primary text-xs">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <QrCode className="h-3.5 w-3.5" />}
                  允许局域网同步
                </button>
              ) : (
                <button type="button" onClick={revoke} disabled={busy} className="btn-secondary text-xs">
                  <X className="h-3.5 w-3.5" />
                  取消
                </button>
              )}
            </div>
          </div>

          {(phase === 'open' || phase === 'awaiting_confirm') && (
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="局域网同步二维码" className="h-[180px] w-[180px] rounded-lg border border-tavern-border-soft bg-white p-1" />
              ) : (
                <div className="flex h-[180px] w-[180px] items-center justify-center rounded-lg border border-dashed border-tavern-border-soft text-[11px] text-tavern-text-muted">
                  二维码生成中…
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-2 text-xs">
                <p className="text-tavern-text-muted">请用手机轻语扫码；授权窗口仅 5 分钟有效，过期需重新开启。</p>
                {phase === 'awaiting_confirm' && status?.lanShortAuth ? (
                  <div className="rounded-lg border border-tavern-accent/30 bg-tavern-accent-soft/50 px-3 py-2.5">
                    <p className="text-tavern-text-soft">
                      设备 <span className="font-medium text-tavern-text">{status.lanPeerDeviceName ?? '未知设备'}</span>
                    </p>
                    <p className="mt-1 text-tavern-text-muted">请核对手机上的短认证串是否一致：</p>
                    <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.2em] text-tavern-accent">
                      {status.lanShortAuth}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        className="input h-8 w-28 font-mono text-sm"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="输入核对"
                        value={shortAuthInput}
                        onChange={(e) => setShortAuthInput(e.target.value.replace(/\D/g, ''))}
                        aria-label="短认证串"
                      />
                      <button
                        type="button"
                        onClick={confirmPeer}
                        disabled={busy || shortAuthInput.length !== 6}
                        className="btn-primary h-8 text-xs"
                      >
                        <Check className="h-3.5 w-3.5" />
                        确认授权
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-tavern-text-muted">等待手机扫码…</p>
                )}
              </div>
            </div>
          )}

          {phase === 'confirmed' && (
            <p className="flex items-center gap-1.5 text-xs text-tavern-success">
              <ShieldCheck className="h-3.5 w-3.5" />
              本次会话已授权，可在手机端开始同步。完成后此处状态会保留至下次重新授权。
            </p>
          )}

          {error && <p className="text-xs text-tavern-danger">{error}</p>}
        </div>

        {/* 冲突 */}
        <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-card/55 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-tavern-text">待解决冲突（{conflicts.length}）</p>
            <button type="button" onClick={() => void refresh()} className="btn-ghost p-1" aria-label="刷新冲突">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          {conflicts.length === 0 ? (
            <p className="py-3 text-center text-xs text-tavern-text-muted">暂无冲突</p>
          ) : (
            <ul className="space-y-2">
              {conflicts.map((c) => (
                <li key={c.id} className="rounded-lg border border-tavern-border-soft px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-tavern-text">
                        {c.entityType} · <span className="font-mono">{c.entityId}</span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-tavern-text-muted">
                        {SUGGESTION_LABEL[c.suggestion] ?? c.suggestion}
                        {c.localDeleted ? ' · 本机已删' : ''}
                        {c.remoteDeleted ? ' · 对端已删' : ''}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-tavern-text-muted/80 truncate">
                        本机 {c.localHash.slice(0, 16) || '—'} · 对端 {c.remoteHash.slice(0, 16) || '—'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-[11px]"
                        onClick={() => setResolveTarget({ id: c.id, choice: 'local' })}
                      >
                        本机
                      </button>
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-[11px]"
                        onClick={() => setResolveTarget({ id: c.id, choice: 'remote' })}
                      >
                        对端
                      </button>
                      <button
                        type="button"
                        className="btn-ghost px-2 py-1 text-[11px]"
                        onClick={() => setResolveTarget({ id: c.id, choice: 'manual' })}
                      >
                        已处理
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-tavern-text-muted">
            「删除 vs 修改」请单独确认；解决记录只保存哈希与选择，不含正文。
          </p>
        </div>

        {/* 设备管理 + tombstone（S7-08） */}
        <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-card/55 p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-tavern-text">同步设备</p>
            <button type="button" onClick={() => void refresh()} className="btn-ghost p-1" aria-label="刷新设备">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          {devices.length === 0 ? (
            <p className="py-2 text-center text-xs text-tavern-text-muted">暂无对端设备（完成一次同步后出现）</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((d) => (
                <li
                  key={d.deviceId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-tavern-border-soft px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-tavern-text">
                      {d.displayName || '未命名设备'}
                      {d.retired && (
                        <span className="ml-2 rounded bg-tavern-bg-hover px-1.5 py-0.5 text-[10px] text-tavern-text-muted">
                          已退役
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-tavern-text-muted truncate">{d.deviceId}</p>
                    <p className="mt-0.5 text-[11px] text-tavern-text-muted">
                      {d.lastSeenAt
                        ? `最近同步 ${new Date(d.lastSeenAt).toLocaleString()}`
                        : '尚无同步记录'}
                      {d.retired ? '' : ' · 退役后须重新授权'}
                    </p>
                  </div>
                  {!d.retired && (
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1 text-[11px] text-tavern-danger"
                      onClick={() => setRetireTarget(d)}
                    >
                      退役
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-tavern-text-muted">
            退役会清除该设备的已知向量；若设备再次出现，必须当新设备重新扫码授权，旧计数器不能继续写入。
          </p>

          <div className="border-t border-tavern-border-soft pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-tavern-text">删除记录清理预览</p>
              <span className="text-[11px] text-tavern-text-muted">仅预览，不实际压缩</span>
            </div>
            {tombstoneReport ? (
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-lg bg-tavern-bg-soft/50 px-2.5 py-2">
                  <p className="text-[10px] text-tavern-text-muted">删除记录</p>
                  <p className="font-mono text-sm text-tavern-text">{tombstoneReport.total}</p>
                </div>
                <div className="rounded-lg bg-tavern-bg-soft/50 px-2.5 py-2">
                  <p className="text-[10px] text-tavern-text-muted">可清理</p>
                  <p className="font-mono text-sm text-tavern-success">{tombstoneReport.compactible}</p>
                </div>
                <div className="rounded-lg bg-tavern-bg-soft/50 px-2.5 py-2">
                  <p className="text-[10px] text-tavern-text-muted">暂不可清</p>
                  <p className="font-mono text-sm text-tavern-text">{tombstoneReport.blocked}</p>
                </div>
                <div className="rounded-lg bg-tavern-bg-soft/50 px-2.5 py-2">
                  <p className="text-[10px] text-tavern-text-muted">活跃 / 已退役</p>
                  <p className="font-mono text-sm text-tavern-text">
                    {tombstoneReport.deviceCount}/{tombstoneReport.retiredCount}
                  </p>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-tavern-text-muted">统计中…</p>
            )}
            {tombstoneReport && tombstoneReport.pendingDeviceIds.length > 0 && (
              <p className="mt-2 text-[11px] text-tavern-text-muted">
                以下设备尚未确认删除记录，长期不在线会拖慢清理：
                <span className="font-mono">{tombstoneReport.pendingDeviceIds.join(', ')}</span>
                。可考虑退役长期离线设备。
              </p>
            )}
            {tombstoneReport && Object.keys(tombstoneReport.blockedReasons).length > 0 && (
              <p className="mt-1 text-[10px] text-tavern-text-muted">
                阻塞原因：
                {Object.entries(tombstoneReport.blockedReasons)
                  .map(([k, n]) => `${k}×${n}`)
                  .join('，')}
              </p>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={resolveTarget != null}
        title="解决同步冲突"
        message={
          resolveTarget?.choice === 'local'
            ? '保留本机版本，对端同实体的这次变更将被丢弃。确定吗？'
            : resolveTarget?.choice === 'remote'
              ? '保留对端版本，本机同实体将被覆盖。确定吗？'
              : '标记为已手动处理，不再出现在待解决列表。'
        }
        onConfirm={doResolve}
        onClose={() => setResolveTarget(null)}
      />

      <ConfirmDialog
        open={retireTarget != null}
        title="退役同步设备"
        danger
        message={
          <>
            将退役「{retireTarget?.displayName || retireTarget?.deviceId}」。该设备之后若再次出现，必须重新扫码授权，
            <strong>旧同步计数器不能再写入</strong>。确定退役吗？
          </>
        }
        onConfirm={doRetire}
        onClose={() => setRetireTarget(null)}
      />
    </SectionCard>
  )
}
