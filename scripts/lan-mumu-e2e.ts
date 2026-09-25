/**
 * MuMu ↔ PC 真 LAN 联调（QR 注入）。
 *
 * 1. 本机起 `/sync/v1`（挂真实路由 + LAN 授权服务）
 * 2. 以 **10.0.2.2**（模拟器 NAT 宿主地址）开授权窗，生成 QR
 * 3. `adb am start --es sync_qr` 注入 Android（与扫码同一路径）
 * 4. 轮询 auth/status；看到 peer hello 后用 **同一 SAS** 确认
 * 5. 断言 Android 进入 Confirmed / 已授权，并可开 session
 *
 * 运行：pnpm exec tsx --import ./scripts/electron-stub.mjs scripts/lan-mumu-e2e.ts
 */
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync, execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'

const ADB = 'D:/Code/android-sdk/platform-tools/adb.exe'
const SERIAL = process.env.ANDROID_SERIAL ?? 'emulator-5556'
const HOST_FROM_EMU = process.env.LAN_HOST_FROM_EMU ?? '127.0.0.1'

const log = (...a: unknown[]) => console.log('[lan-mumu]', ...a)
const fail = (m: string): never => {
  console.error('[lan-mumu] FAIL', m)
  process.exit(1)
}

function adb(...args: string[]): string {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' })
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function uiTexts(): string {
  try {
    execFileSync(ADB, ['-s', SERIAL, 'shell', 'uiautomator', 'dump', '/sdcard/ui.xml'], { stdio: 'pipe' })
  } catch {
    /* MuMu uiautomator 常 139 退出 */
  }
  execFileSync(ADB, ['-s', SERIAL, 'pull', '/sdcard/ui.xml', 'output/pce01/lan-mumu-ui.xml'], { stdio: 'pipe' })
  const t = readFileSync('output/pce01/lan-mumu-ui.xml', 'utf8')
  return [...t.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter(Boolean).join(' | ')
}

async function main() {
  mkdirSync('output/pce01', { recursive: true })

  // ---- 动态 import（先 electron stub）----
  const { buildSyncV1Router, resetSyncV1ForTest, syncV1Runtime, setSyncV1DomainPeekForTest } =
    await import('../electron/bridge/syncRoutes')
  const { syncLanAuthService } = await import('../electron/domain/syncLanAuth')
  const {
    setSyncDomainUserDataDirForTest,
    resetSyncDomainForTest,
    getSyncDomain,
  } = await import('../electron/domain/syncDomainService')
  const { mkdtempSync, mkdirSync: mkdir } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  resetSyncV1ForTest()
  syncLanAuthService.resetForTests()
  const workDir = mkdtempSync(join(tmpdir(), 'qingyu-lan-mumu-'))
  const userData = join(workDir, 'userdata')
  mkdir(join(userData, 'data', 'config'), { recursive: true })
  setSyncDomainUserDataDirForTest(userData)
  setSyncV1DomainPeekForTest(() => {
    try {
      return getSyncDomain()
    } catch {
      return null
    }
  })

  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/sync/v1', buildSyncV1Router())
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '0.0.0.0', () => resolve(s))
  })
  const { port } = server.address() as AddressInfo
  // 模拟器常无到宿主的默认路由：adb reverse 把设备 127.0.0.1:port 转到宿主
  try {
    execFileSync(ADB, ['-s', SERIAL, 'reverse', '--remove-all'], { stdio: 'pipe' })
  } catch { /* ignore */ }
  log('adb reverse tcp:' + port + ' → tcp:' + port)
  execFileSync(ADB, ['-s', SERIAL, 'reverse', `tcp:${port}`, `tcp:${port}`], { stdio: 'inherit' })
  // 先从设备侧探活
  try {
    const probe = execFileSync(
      ADB,
      ['-s', SERIAL, 'shell', `toybox nc -z -w 2 127.0.0.1 ${port}; echo PROBE:$?`],
      { encoding: 'utf8' },
    )
    log('device probe', probe.trim())
  } catch (e) {
    log('device probe failed', String(e))
  }
  log('server listening', port, 'host-from-emu', HOST_FROM_EMU)

  // ---- PC 开授权窗（host 填模拟器可达地址）----
  const started = syncLanAuthService.startAuthWindow({
    host: HOST_FROM_EMU,
    port,
    fingerprint: 'fp-lan-mumu',
    displayName: 'PC-MuMu-LAN',
  })
  if (!started.qrJson) fail('未生成 QR')
  writeFileSync('output/pce01/lan-mumu-qr.json', started.qrJson, 'utf8')
  log('QR ready', started.sessionId, 'host', started.host, 'port', started.port)

  // ---- 安装 APK（可选；重装会干扰 adb reverse，默认跳过）----
  const apk = 'android/app/build/outputs/apk/debug/app-debug.apk'
  if (process.env.LAN_INSTALL_APK === '1') {
    if (!existsSync(apk)) fail('APK 不存在')
    log('install apk…')
    execFileSync(ADB, ['-s', SERIAL, 'install', '-r', '-t', apk], { stdio: 'inherit' })
  } else {
    log('skip install (set LAN_INSTALL_APK=1 to force)')
  }

  // QR 可能含引号：用文件 + am start 读 extras 不便；改为 base64 传参
  const qrB64 = Buffer.from(started.qrJson, 'utf8').toString('base64')
  log('launch app with sync_qr extra…')
  try {
    execFileSync(
      ADB,
      [
        '-s', SERIAL, 'shell', 'am', 'force-stop', 'com.qingyu.companion',
      ],
      { stdio: 'pipe' },
    )
  } catch { /* ignore */ }
  sleep(500)
  // 用 base64 降低 shell 转义风险；Android 侧同步解码
  execFileSync(
    ADB,
    [
      '-s', SERIAL, 'shell', 'am', 'start',
      '-n', 'com.qingyu.companion/.MainActivity',
      '--es', 'sync_qr_b64', qrB64,
    ],
    { stdio: 'inherit' },
  )

  // ---- 轮询 PC：等 hello ----
  let sawHello = false
  let shortAuth: string | null = null
  for (let i = 0; i < 60; i++) {
    sleep(500)
    const st = syncLanAuthService.getStatus()
    log('pc phase', st.phase, 'peer', st.peerDeviceName, 'sas', st.shortAuth)
    if (st.phase === 'awaiting_confirm' && st.shortAuth) {
      sawHello = true
      shortAuth = st.shortAuth
      break
    }
    if (st.phase === 'confirmed') {
      sawHello = true
      shortAuth = st.shortAuth
      break
    }
    if (i % 4 === 3) {
      log('ui', uiTexts().slice(0, 200))
      try {
        const lg = execFileSync(
          ADB,
          ['-s', SERIAL, 'shell', 'logcat', '-d', '-t', '40'],
          { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 },
        )
        const hits = lg.split(/\r?\n/).filter((l) => /SyncQrInject|LanSync|OkHttp|unexpected|ECONN/.test(l))
        if (hits.length) log('logcat', hits.slice(-6).join(' || '))
      } catch { /* ignore */ }
    }
  }
  if (!sawHello || !shortAuth) {
    log('ui', uiTexts())
    fail('未收到 Android hello（检查网络/QR 注入/解码）')
  }
  log('hello received, SAS', shortAuth)

  // ---- PC 确认（模拟用户核对）----
  if (syncLanAuthService.getStatus().phase === 'awaiting_confirm') {
    const confirm = syncLanAuthService.confirmPeer({
      sessionId: started.sessionId!,
      shortAuth: shortAuth!,
    })
    if (!confirm.ok) fail('confirm 失败 ' + confirm.error)
    log('pc confirmed')
  }

  // ---- 等 Android 进入已授权 ----
  let authorized = false
  for (let i = 0; i < 30; i++) {
    sleep(500)
    const texts = uiTexts()
    log('android ui', texts.slice(0, 160))
    if (texts.includes('已授权') || texts.includes('Confirmed') || texts.includes('开始同步')) {
      authorized = true
      break
    }
  }

  // ---- 再开一个 sync session 验证休眠门已开 ----
  const sessionRes = await fetch(`http://127.0.0.1:${port}/sync/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'android' }),
  })
  const sessionBody = (await sessionRes.json()) as { sessionId?: string; error?: string }
  log('session after auth', sessionRes.status, sessionBody)

  const report = {
    generatedAt: new Date().toISOString(),
    hostFromEmu: HOST_FROM_EMU,
    port,
    sessionId: started.sessionId,
    sas: shortAuth,
    sawHello,
    pcConfirmed: syncLanAuthService.getStatus().phase === 'confirmed',
    androidSeesAuthorized: authorized,
    sessionAfterAuth: sessionBody,
  }
  writeFileSync('output/pce01/lan-mumu-report.json', JSON.stringify(report, null, 2), 'utf8')

  if (!authorized && sessionRes.status !== 200) {
    fail('Android 未确认且 session 未打开')
  }
  log('PASS', JSON.stringify(report))
  server.close()
}

main().catch((e) => {
  console.error('[lan-mumu] unexpected', e)
  process.exit(1)
})
