/**
 * 设置页「手机连接」面板（方案 §4.2 / §5.1 / §6.1）。
 *
 * - 开关：显式开启桥接服务（默认关闭 + 防火墙提示）；
 * - 网络候选：列出私有网段 IP（过滤虚拟网卡），勾选绑定（多网卡策略，§4.2）；
 * - 配对二维码数据：host/port/fingerprint（fingerprint = 一次性配对码）；
 * - 设备管理：已配对设备列表，可吊销（§5.1）。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import QRCode from 'qrcode'
import { SectionCard } from '../../components/common/SettingsShared'
import type { BridgeConfig, BridgeDeviceInfo, PairingInfo, RelayStatus } from '../../../shared/ipc-api'
import { DEFAULT_RELAY_BASE_URL, type RelayPairingQr } from '../../../shared/relayProtocol'
import { Smartphone, Loader2, RefreshCw, Trash2, KeyRound, Copy, Check, ShieldAlert, Cloud, Wifi, ArrowRightLeft } from 'lucide-react'
interface BridgeStatus {
  running: boolean
  config: BridgeConfig
  bound: { host: string; port: number; clientCount: number } | null
}

export function PhoneConnectionSection() {
  const [channel, setChannel] = useState<'lan' | 'relay'>('lan')

  return (
    <SectionCard title="手机连接" icon={<Smartphone size={18} />} storageKey="phone-connection">
      <div className="space-y-4 pt-3">
        <div className="relative overflow-hidden rounded-2xl border border-tavern-border-soft bg-tavern-bg-soft px-4 py-4">
          <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-tavern-accent/10 blur-2xl" />
          <div className="relative flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-tavern-accent/20 bg-tavern-accent-soft text-tavern-accent">
              <ArrowRightLeft size={18} />
            </div>
            <div>
              <div className="font-display text-sm font-semibold text-tavern-text">双通道连接</div>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-tavern-text-muted">
                同一 Wi-Fi 优先使用局域网直连；移动网络或异地访问使用服务器中继。两种方式可独立启停，配对设备共享同一套轻语数据。
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="tablist" aria-label="手机连接通道">
          <ConnectionChannelTab
            selected={channel === 'lan'}
            icon={<Wifi size={17} />}
            title="局域网连接"
            description="同一网络 · 低延迟直连"
            controls="phone-connection-lan"
            onClick={() => setChannel('lan')}
          />
          <ConnectionChannelTab
            selected={channel === 'relay'}
            icon={<Cloud size={17} />}
            title="服务器连接"
            description="移动网络 · 异地可用"
            controls="phone-connection-relay"
            onClick={() => setChannel('relay')}
          />
        </div>

        <div
          id={`phone-connection-${channel}`}
          role="tabpanel"
          aria-label={channel === 'lan' ? '局域网连接' : '服务器连接'}
        >
          {channel === 'lan' ? <LanConnectionPanel /> : <RelayConnectionPanel />}
        </div>
      </div>
    </SectionCard>
  )
}

function ConnectionChannelTab({
  selected,
  icon,
  title,
  description,
  controls,
  onClick,
}: {
  selected: boolean
  icon: React.ReactNode
  title: string
  description: string
  controls: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={controls}
      onClick={onClick}
      className={`group flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all ${
        selected
          ? 'border-tavern-accent/45 bg-tavern-accent-soft shadow-sm'
          : 'border-tavern-border-soft bg-tavern-bg hover:border-tavern-border hover:bg-tavern-bg-hover'
      }`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
        selected ? 'bg-tavern-accent text-white' : 'bg-tavern-bg-soft text-tavern-text-muted group-hover:text-tavern-text'
      }`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-medium ${selected ? 'text-tavern-accent' : 'text-tavern-text'}`}>{title}</span>
        <span className="mt-0.5 block truncate text-xs text-tavern-text-muted">{description}</span>
      </span>
      <span className={`h-1.5 w-1.5 rounded-full ${selected ? 'bg-tavern-accent' : 'bg-tavern-border'}`} />
    </button>
  )
}

export function LanConnectionPanel() {
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [devices, setDevices] = useState<BridgeDeviceInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [selectedIp, setSelectedIp] = useState<string>('')
  /** 已复制的字段 label（null = 无），独立反馈 */
  const [copied, setCopied] = useState<string | null>(null)
  /**
   * 二维码模式（D-02）：默认 v2（serverId/capabilities/expiresAt/endpoints）；
   * 旧 Android（<支持 QR v2 的版本）无法解析 v2 时，可切换"旧版兼容"输出
   * 旧格式 {host,port,fingerprint}。
   */
  const [qrMode, setQrMode] = useState<'v2' | 'legacy'>('v2')
  /** 二维码 data URL（内容由主进程按模式生成，对齐安卓端 PairingQr 解析） */
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [st, pairingInfo, deviceList] = await Promise.all([
        window.api.bridge.status(),
        window.api.bridge.pairingInfo(),
        window.api.bridge.listDevices(),
      ])
      setStatus(st)
      setPairing(pairingInfo)
      setDevices(deviceList)
      if (st.config.host && !selectedIp) setSelectedIp(st.config.host)
    } catch (e) {
      setMsg({ ok: false, text: `读取桥接状态失败：${(e as Error).message}` })
    }
  }, [selectedIp])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 配对码/模式变化时重新生成二维码：载荷 JSON 由主进程统一构造
  // （v2 = QR v2 契约；legacy = 旧 {host,port,fingerprint}）。
  // 依赖取 fingerprint 原始值：主进程可能轮换/消费配对码（自动重生成路径），
  // 刷新后若指纹变化则重新出码；指纹未变则不循环。
  const pairingFingerprint = pairing?.fingerprint ?? ''
  useEffect(() => {
    if (!pairingFingerprint) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    window.api.bridge
      .pairingQrPayload(qrMode)
      .then(async (payload) => {
        if (cancelled) return
        const url = await QRCode.toDataURL(payload, {
          width: 220,
          margin: 1,
          errorCorrectionLevel: 'M',
        })
        if (cancelled) return
        setQrError(null)
        setQrDataUrl(url)
        // 主进程可能已自动轮换配对码：同步展示信息（旧指纹则无操作，不触发重入）
        const fresh = await window.api.bridge.pairingInfo()
        if (!cancelled && fresh.fingerprint !== pairingFingerprint) setPairing(fresh)
      })
      .catch((e) => {
        if (cancelled) return
        setQrError((e as Error).message)
        setQrDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [pairingFingerprint, qrMode])

  /** 开关桥接服务 */
  const toggleBridge = async () => {
    setBusy(true)
    setMsg(null)
    try {
      if (status?.running) {
        await window.api.bridge.stop()
        setMsg({ ok: true, text: '已关闭「手机连接」' })
      } else {
        const result = await window.api.bridge.start()
        if (result.ok) {
          setMsg({ ok: true, text: `已开启：${result.host}:${result.port}` })
        } else {
          setMsg({ ok: false, text: result.error ?? '启动失败' })
        }
      }
      await refresh()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  /** 切换绑定网卡 */
  const switchBindIp = async (ip: string) => {
    setBusy(true)
    setMsg(null)
    try {
      const result = await window.api.bridge.setConfig({ host: ip })
      if (result.ok) {
        setSelectedIp(ip)
        // 已开启时重启生效
        if (status?.running) {
          await window.api.bridge.stop()
          await window.api.bridge.start()
        }
        setMsg({ ok: true, text: `已绑定 ${ip}` })
        await refresh()
      } else {
        setMsg({ ok: false, text: result.error ?? '设置失败' })
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  /** 复制单个配对字段（主机/端口/配对码分开，方便安卓端逐个粘贴） */
  const copyField = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // 回退：隐藏 textarea + execCommand（对齐 MessageActionBar BUG-31 处理）
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        setMsg({ ok: false, text: '复制失败：无法访问剪贴板' })
        return
      }
    }
    setCopied(label)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(null), 2000)
  }

  /** 重新生成配对码（旧码作废，二维码同步刷新） */
  const regeneratePairing = async () => {
    const info = await window.api.bridge.regeneratePairing()
    setPairing(info)
    setMsg({ ok: true, text: '已生成新配对码（旧码作废，5 分钟有效）' })
  }

  const revokeDevice = async (deviceId: string) => {
    const result = await window.api.bridge.revokeDevice(deviceId)
    if (result.ok) {
      setMsg({ ok: true, text: '设备已吊销' })
      setDevices((d) => d.filter((x) => x.deviceId !== deviceId))
    }
  }

  const candidateIps = status?.config.bindIps ?? []

  return (
    <div className="space-y-4 rounded-xl border border-tavern-border-soft bg-tavern-bg/45 p-4 text-sm">
        {/* 开关 + 状态 */}
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">
              {status?.running
                ? `运行中：${status.bound?.host}:${status.bound?.port}`
                : '未开启'}
            </div>
            <div className="text-tavern-text-muted text-xs">
              {status?.running
                ? `已连接设备 ${status.bound?.clientCount} 台`
                : '默认关闭。开启后局域网内的安卓设备可连接此电脑。'}
            </div>
          </div>
          <button
            onClick={toggleBridge}
            disabled={busy}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              status?.running
                ? 'bg-tavern-danger/10 text-tavern-danger hover:bg-tavern-danger/20'
                : 'bg-tavern-accent/10 text-tavern-accent hover:bg-tavern-accent/20'
            }`}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : status?.running ? '关闭' : '开启'}
          </button>
        </div>

        <div className="rounded-lg border border-tavern-warning/35 bg-tavern-warning/5 p-3">
          <div className="flex items-start gap-2.5">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-tavern-warning" />
            <div className="min-w-0 space-y-1.5">
              <div className="font-medium">安卓端无法通过局域网连接时</div>
              <div className="text-tavern-text-muted text-xs leading-relaxed">
                请依次打开 Windows「设置 → 隐私与安全性 → 防火墙与网络保护」，关闭“专用网络”和“公用网络”防火墙后重新连接。
              </div>
              <div className="text-tavern-danger/85 text-xs leading-relaxed">
                关闭防火墙会降低电脑安全性，仅建议用于局域网连接排查；测试完成后请重新开启。
              </div>
            </div>
          </div>
        </div>

        {/* 网络候选（多网卡绑定，§4.2） */}
        {candidateIps.length > 0 && (
          <div>
            <div className="text-tavern-text-muted text-xs mb-1">绑定网卡（多网卡候选，换 WiFi 后重新绑定）</div>
            <div className="flex flex-wrap gap-2">
              {candidateIps.map((ip) => (
                <button
                  key={ip}
                  onClick={() => switchBindIp(ip)}
                  className={`px-3 py-1 rounded-md border text-xs transition-colors ${
                    selectedIp === ip || status?.config.host === ip
                      ? 'border-tavern-accent text-tavern-accent bg-tavern-accent/10'
                      : 'border-tavern-border text-tavern-text-muted hover:border-tavern-accent'
                  }`}
                >
                  {ip}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 配对二维码（方案 §5.1：安卓端扫码配对主路径） */}
        {pairing && (
          <div className="flex flex-col items-center gap-2">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="配对二维码"
                width={220}
                height={220}
                className="rounded-lg bg-white p-2"
              />
            ) : qrError ? (
              <div className="text-tavern-danger text-xs">二维码生成失败：{qrError}</div>
            ) : (
              <Loader2 size={20} className="animate-spin text-tavern-text-muted" />
            )}
            <div className="text-tavern-text-muted text-xs">
              打开安卓端「轻语伴侣」→ 扫码配对，或手动输入下方信息
            </div>
            {/* QR v2 / 旧版兼容切换（D-02：旧 Android 无法解析 v2 时切 legacy） */}
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => setQrMode(qrMode === 'v2' ? 'legacy' : 'v2')}
                className={`px-2.5 py-1 rounded-md border transition-colors ${
                  qrMode === 'legacy'
                    ? 'border-tavern-accent text-tavern-accent bg-tavern-accent/10'
                    : 'border-tavern-border text-tavern-text-muted hover:border-tavern-accent'
                }`}
                title="旧版 Android（不支持 QR v2）扫码配对时切换"
              >
                {qrMode === 'legacy' ? '旧版兼容模式（点击切回 QR v2）' : 'QR v2（点击切换旧版兼容）'}
              </button>
              {qrMode === 'legacy' && (
                <span className="text-tavern-text-muted">输出旧格式 {`{host,port,fingerprint}`}</span>
              )}
            </div>
          </div>
        )}

        {/* 配对信息：主机/端口/配对码分开展示，各自可复制 */}
        {pairing && (
          <div className="rounded-lg bg-tavern-bg p-3 space-y-2 font-mono text-xs">
            <CopyField
              label="主机"
              value={pairing.host}
              copied={copied === '主机'}
              onCopy={copyField}
            />
            <CopyField
              label="端口"
              value={String(pairing.port)}
              copied={copied === '端口'}
              onCopy={copyField}
            />
            <CopyField
              label="配对码"
              value={pairing.fingerprint}
              copied={copied === '配对码'}
              hint={`${pairing.expiresInSec / 60} 分钟有效，一次性`}
              onCopy={copyField}
            />
            <div className="text-tavern-text-muted">
              在安卓端扫码，或手动输入上述主机/端口/配对码进行配对。
            </div>
          </div>
        )}

        {/* 设备列表 */}
        {devices.length > 0 && (
          <div>
            <div className="text-tavern-text-muted text-xs mb-1">已配对设备</div>
            <div className="space-y-1">
              {devices.map((d) => (
                <div key={d.deviceId} className="flex items-center justify-between rounded-md bg-tavern-bg px-3 py-2">
                  <div>
                    <div className="font-medium">{d.name}</div>
                    <div className="text-tavern-text-muted text-xs">
                      {d.deviceId.slice(0, 8)} · 最近活跃 {new Date(d.lastSeen).toLocaleString()}
                    </div>
                  </div>
                  <button
                    onClick={() => revokeDevice(d.deviceId)}
                    className="text-tavern-danger/70 hover:text-tavern-danger transition-colors"
                    title="吊销此设备"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 操作 */}
        <div className="flex gap-2">
          <button
            onClick={regeneratePairing}
            className="px-3 py-1.5 rounded-md border border-tavern-border text-xs hover:border-tavern-accent flex items-center gap-1"
          >
            <RefreshCw size={14} /> 重新生成配对码
          </button>
          <button
            onClick={refresh}
            className="px-3 py-1.5 rounded-md border border-tavern-border text-xs hover:border-tavern-accent flex items-center gap-1"
          >
            <KeyRound size={14} /> 刷新状态
          </button>
        </div>

        {msg && (
          <div className={`text-xs ${msg.ok ? 'text-tavern-success' : 'text-tavern-danger'}`}>{msg.text}</div>
        )}
    </div>
  )
}

export function RelayConnectionPanel() {
  const [status, setStatus] = useState<RelayStatus>({ state: 'Disabled' })
  const [baseUrl, setBaseUrl] = useState(DEFAULT_RELAY_BASE_URL)
  const [ticket, setTicket] = useState<RelayPairingQr | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    // 旧版 preload 与部分独立渲染测试可能尚未注入 relay；LAN 面板仍应可用。
    const relay = window.api.relay
    if (!relay) return
    relay.status().then((next) => {
      setStatus(next)
      if ('baseUrl' in next && next.baseUrl) setBaseUrl(next.baseUrl)
    }).catch(() => {})
    return relay.onStatusChanged((next) => {
      setStatus(next)
      if ('baseUrl' in next && next.baseUrl) setBaseUrl(next.baseUrl)
    })
  }, [])

  useEffect(() => {
    if (!ticket) { setQr(null); return }
    QRCode.toDataURL(JSON.stringify(ticket), { width: 220, margin: 1 })
      .then(setQr).catch(() => setQr(null))
  }, [ticket])

  const enabled = status.state !== 'Disabled'
  const toggle = async () => {
    if (!window.confirm(enabled ? '确定停用服务器连接？局域网连接不受影响。' : '确定启用服务器连接？')) return
    setBusy(true); setMessage(null)
    try {
      const result = enabled ? await window.api.relay.disable() : await window.api.relay.enable(baseUrl)
      if (!result.ok) setMessage((result as { error?: string }).error ?? '操作失败')
      setStatus(await window.api.relay.status())
    } finally { setBusy(false) }
  }

  const createTicket = async () => {
    setBusy(true); setMessage(null)
    try { setTicket(await window.api.relay.createPairTicket()) }
    catch (error) { setMessage((error as Error).message) }
    finally { setBusy(false) }
  }

  const clearCache = async () => {
    if (!window.confirm('确定清空 Relay 上的临时缓存？PC 本地数据不会被删除。')) return
    const result = await window.api.relay.clearCache()
    setMessage(result.ok ? '云端缓存已清空' : '清空失败')
  }

  const statusText = status.state === 'Online' ? '已连接' : status.state === 'Reconnecting'
    ? `重连中（第 ${status.attempt + 1} 次）` : status.state === 'NeedsAuth' ? '需要重新注册' : status.state

  return (
    <div className="space-y-4 rounded-xl border border-tavern-border-soft bg-tavern-bg/45 p-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 font-medium text-tavern-text">
              服务器中继
              <span className="rounded-full bg-tavern-accent-soft px-2 py-0.5 text-[11px] font-normal text-tavern-accent">无需入站端口</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-tavern-text-muted">电脑和手机均主动连接 HTTPS/WSS 服务，局域网不可用时仍可连接。</p>
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
            status.state === 'Online'
              ? 'bg-tavern-success/10 text-tavern-success'
              : 'bg-tavern-bg-soft text-tavern-text-muted'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${status.state === 'Online' ? 'bg-tavern-success' : 'bg-tavern-text-muted/50'}`} />
            {statusText}
          </span>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label htmlFor="relay-base-url" className="text-xs font-medium text-tavern-text-soft">服务器地址</label>
            <span className="text-[11px] text-tavern-text-muted">HTTPS</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="relay-base-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={enabled}
              placeholder={DEFAULT_RELAY_BASE_URL}
              className="min-w-0 flex-1 rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2.5 text-sm outline-none transition-colors focus:border-tavern-accent disabled:cursor-not-allowed disabled:opacity-65"
            />
            <button onClick={toggle} disabled={busy || (!enabled && !baseUrl.trim())}
              className={`inline-flex min-w-20 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                enabled
                  ? 'bg-tavern-danger/10 text-tavern-danger hover:bg-tavern-danger/20'
                  : 'bg-tavern-accent text-white hover:brightness-105'
              }`}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : enabled ? '停用' : '启用'}
            </button>
          </div>
          {'spaceId' in status && status.spaceId && (
            <div className="mt-1.5 text-[11px] text-tavern-text-muted">当前空间：<span className="font-mono">{status.spaceId.slice(0, 8)}…</span></div>
          )}
        </div>
        {status.state === 'Online' && (
          <div className="flex flex-wrap gap-2 border-t border-tavern-border-soft pt-3">
            <button onClick={createTicket} className="inline-flex items-center gap-1.5 rounded-lg bg-tavern-accent-soft px-3 py-2 text-xs font-medium text-tavern-accent transition-colors hover:bg-tavern-accent/15">
              <KeyRound size={14} /> 创建服务器连接码
            </button>
            <button onClick={clearCache} className="rounded-lg border border-tavern-border px-3 py-2 text-xs text-tavern-text-muted transition-colors hover:border-tavern-danger/50 hover:text-tavern-danger">清空云端缓存</button>
          </div>
        )}
        {ticket && (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-tavern-accent/25 bg-tavern-accent-soft/40 p-4 sm:flex-row sm:items-start">
            {qr && <img src={qr} alt="Relay 配对二维码" className="h-36 w-36 rounded-lg bg-white p-1.5 shadow-sm" />}
            <div className="space-y-2 text-center text-xs sm:pt-1 sm:text-left">
              <div className="font-medium text-tavern-text">在 Android 的“服务器连接”中扫码</div>
              {ticket.code && <div>或输入连接码：<span className="ml-1 font-mono text-base tracking-[0.18em] text-tavern-accent">{ticket.code}</span></div>}
              <div className="text-tavern-text-muted">一次性连接码 · 有效至 {new Date(ticket.expiresAt).toLocaleTimeString()}</div>
            </div>
          </div>
        )}
        {message && <div className="rounded-lg bg-tavern-danger/8 px-3 py-2 text-xs text-tavern-danger">{message}</div>}
    </div>
  )
}

/** 单个配对字段行：label + 值 + 独立复制按钮 */
function CopyField({
  label,
  value,
  copied,
  hint,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  hint?: string
  onCopy: (label: string, value: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <span className="text-tavern-text-muted mr-1">{label}：</span>
        <span className="break-all">{value}</span>
        {hint && <span className="text-tavern-text-muted ml-1">（{hint}）</span>}
      </div>
      <button
        onClick={() => onCopy(label, value)}
        className="shrink-0 px-2 py-1 rounded border border-tavern-border text-xs hover:border-tavern-accent flex items-center gap-1"
        title={`复制${label}`}
      >
        {copied ? <Check size={14} className="text-tavern-success" /> : <Copy size={14} />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  )
}
