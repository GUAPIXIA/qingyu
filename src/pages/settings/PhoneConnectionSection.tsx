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
import type { BridgeConfig, BridgeDeviceInfo, PairingInfo } from '../../../shared/ipc-api'
import { Smartphone, Loader2, RefreshCw, Trash2, KeyRound, Copy, Check } from 'lucide-react'
interface BridgeStatus {
  running: boolean
  config: BridgeConfig
  bound: { host: string; port: number; clientCount: number } | null
}

export function PhoneConnectionSection() {
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [devices, setDevices] = useState<BridgeDeviceInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [selectedIp, setSelectedIp] = useState<string>('')
  /** 已复制的字段 label（null = 无），独立反馈 */
  const [copied, setCopied] = useState<string | null>(null)
  /** 二维码 data URL（内容 { host, port, fingerprint }，对齐安卓端 PairingQrPayload） */
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

  // 配对信息变化时重新生成二维码（含重新生成配对码后的刷新）
  useEffect(() => {
    if (!pairing) {
      setQrDataUrl(null)
      return
    }
    const payload = JSON.stringify({
      host: pairing.host,
      port: pairing.port,
      fingerprint: pairing.fingerprint,
    })
    setQrError(null)
    QRCode.toDataURL(payload, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
      .then(setQrDataUrl)
      .catch((e) => {
        setQrError((e as Error).message)
        setQrDataUrl(null)
      })
  }, [pairing])

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
          setMsg({ ok: true, text: `已开启：${result.host}:${result.port}（请允许系统防火墙放行）` })
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
    <SectionCard title="手机连接（安卓伴侣端）" icon={<Smartphone size={18} />}>
      <div className="space-y-4 p-4 text-sm">
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
                : '默认关闭。开启后局域网内的安卓设备可连接此电脑（第一次开启请允许防火墙放行）。'}
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
    </SectionCard>
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
