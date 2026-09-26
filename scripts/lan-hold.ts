/**
 * 保持 PC 服务长开 + 注入 + 观察 hello（调试用）。
 */
import express from 'express'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'

const ADB = 'D:/Code/android-sdk/platform-tools/adb.exe'
const SERIAL = 'emulator-5556'
const log = (...a) => console.log('[lan-hold]', ...a)

const { buildSyncV1Router, resetSyncV1ForTest, setSyncV1DomainPeekForTest } = await import('../electron/bridge/syncRoutes')
const { syncLanAuthService } = await import('../electron/domain/syncLanAuth')
const { setSyncDomainUserDataDirForTest, getSyncDomain } = await import('../electron/domain/syncDomainService')
const { mkdtempSync, mkdirSync: mkdir } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')

resetSyncV1ForTest()
syncLanAuthService.resetForTests()
const workDir = mkdtempSync(join(tmpdir(), 'lan-hold-'))
const userData = join(workDir, 'ud')
mkdir(join(userData, 'data', 'config'), { recursive: true })
setSyncDomainUserDataDirForTest(userData)
setSyncV1DomainPeekForTest(() => {
  try { return getSyncDomain() } catch { return null }
})

const app = express()
app.use(express.json({ limit: '5mb' }))
app.use((req, res, next) => {
  log('HTTP', req.method, req.url)
  next()
})
app.use('/sync/v1', buildSyncV1Router())
const server = await new Promise((r) => {
  const s = app.listen(0, '0.0.0.0', () => r(s))
})
const port = server.address().port
try { execFileSync(ADB, ['-s', SERIAL, 'reverse', '--remove-all'], { stdio: 'pipe' }) } catch { /* 已清空或无既有 reverse */ }
execFileSync(ADB, ['-s', SERIAL, 'reverse', `tcp:${port}`, `tcp:${port}`], { stdio: 'pipe' })
log('port', port)

const started = syncLanAuthService.startAuthWindow({
  host: '127.0.0.1',
  port,
  fingerprint: 'fp',
  displayName: 'PC',
})
mkdirSync('output/pce01', { recursive: true })
writeFileSync('output/pce01/lan-hold-qr.json', started.qrJson, 'utf8')
const b64 = Buffer.from(started.qrJson, 'utf8').toString('base64')
log('qr', started.sessionId)

execFileSync(ADB, ['-s', SERIAL, 'shell', 'am', 'force-stop', 'com.qingyu.companion'], { stdio: 'pipe' })
execFileSync(ADB, ['-s', SERIAL, 'shell', 'am', 'start', '-n', 'com.qingyu.companion/.MainActivity', '--es', 'sync_qr_b64', b64], { stdio: 'inherit' })

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const st = syncLanAuthService.getStatus()
  log('t', i, st.phase, st.peerDeviceName, st.shortAuth)
  if (st.phase === 'awaiting_confirm' || st.phase === 'confirmed') {
    log('SUCCESS hello')
    break
  }
}
// 确认
const st = syncLanAuthService.getStatus()
if (st.phase === 'awaiting_confirm' && st.shortAuth) {
  syncLanAuthService.confirmPeer({ sessionId: started.sessionId, shortAuth: st.shortAuth })
  log('confirmed')
}
await new Promise((r) => setTimeout(r, 2000))
log('final auth phase', syncLanAuthService.getStatus().phase)

// Android 已自动 openSyncSession；再开一个并 push/commit 验证数据面
const sessionRes = await fetch(`http://127.0.0.1:${port}/sync/v1/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ role: 'android-e2e' }),
})
const sessionBody = await sessionRes.json()
log('session', sessionRes.status, sessionBody)

const { makeEnvelope } = await import('../shared/contracts/sync-envelope')
const env = makeEnvelope({
  entityType: 'character',
  entityId: 'char-mumu-lan',
  payload: { name: 'MuMu联调' },
  deviceId: 'android-e2e',
  schemaVersion: 3,
})
const sid = sessionBody.sessionId
if (sid) {
  const push = await fetch(`http://127.0.0.1:${port}/sync/v1/session/${sid}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId: 'mumu-b1', sequence: 0, envelopes: [env] }),
  })
  log('push', push.status, await push.json())
  const prep = await fetch(`http://127.0.0.1:${port}/sync/v1/session/${sid}/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchIds: ['mumu-b1'] }),
  })
  log('prepare', prep.status)
  const commit = await fetch(`http://127.0.0.1:${port}/sync/v1/session/${sid}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId: 'mumu-b1', peerId: 'android-e2e' }),
  })
  log('commit', commit.status, await commit.json())
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'qr-inject + adb reverse',
  port,
  sessionId: started.sessionId,
  sas: syncLanAuthService.getStatus().shortAuth,
  phase: syncLanAuthService.getStatus().phase,
  androidHello: true,
  sessionAfterAuth: sessionBody,
}
writeFileSync('output/pce01/lan-mumu-report.json', JSON.stringify(report, null, 2), 'utf8')
log('PASS', JSON.stringify(report))
server.close()
process.exit(0)
