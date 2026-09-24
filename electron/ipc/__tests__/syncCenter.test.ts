// @vitest-environment node
/**
 * S7-06/S7-07：同步中心 IPC——状态、LAN 授权、冲突列表/解决。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { generateKeyPairSync } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-sync-center-test' },
}))

import { registerSyncCenterIPC } from '../syncCenter'
import { syncLanAuthService } from '../../domain/syncLanAuth'
import {
  setSyncDomainUserDataDirForTest,
  resetSyncDomainForTest,
  getSyncDomain,
} from '../../domain/syncDomainService'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

function ipcMainMock(): IpcMain {
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  } as unknown as IpcMain
}

function call(channel: string, ...args: unknown[]): Promise<never> | never {
  const h = handlers.get(channel)
  if (!h) throw new Error('missing handler ' + channel)
  return h(null, ...args) as never
}

describe('S7-06/S7-07 syncCenter IPC', () => {
  let workDir: string
  let userData: string

  beforeEach(() => {
    handlers.clear()
    workDir = mkdtempSync(join(tmpdir(), 'qingyu-sync-center-'))
    userData = join(workDir, 'userdata')
    mkdirSync(join(userData, 'data', 'config'), { recursive: true })
    setSyncDomainUserDataDirForTest(userData)
    syncLanAuthService.resetForTests()
    registerSyncCenterIPC(ipcMainMock())
  })

  afterEach(() => {
    syncLanAuthService.resetForTests()
    resetSyncDomainForTest()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('status 初始：无冲突、lan idle', async () => {
    const st = (await call('syncCenter:status')) as Record<string, unknown>
    expect(st.lanAuthPhase).toBe('idle')
    expect(st.openConflicts).toBe(0)
    expect(st.syncReady).toBe(true)
  })

  it('startLanAuth → open；hello 后 confirm 到 confirmed', async () => {
    const started = (await call('syncCenter:startLanAuth', {
      host: '127.0.0.1',
      port: 8321,
      fingerprint: 'fp',
      displayName: 'pc',
    })) as Record<string, unknown>
    expect(started.lanAuthPhase).toBe('open')
    expect(started.qrJson).toBeTruthy()

    const android = generateKeyPairSync('x25519')
    const raw = (android.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
      .subarray(-32)
      .toString('base64')
    const st = syncLanAuthService.getStatus()
    const hello = syncLanAuthService.submitPeerHello({
      sessionId: st.sessionId!,
      deviceName: 'Pixel',
      androidPublicKey: raw,
    })
    expect(hello.phase).toBe('awaiting_confirm')

    const ok = (await call('syncCenter:confirmPeer', {
      sessionId: st.sessionId,
      shortAuth: hello.shortAuth,
    })) as { ok: boolean; status: Record<string, unknown> }
    expect(ok.ok).toBe(true)
    expect(ok.status.lanAuthPhase).toBe('confirmed')
  })

  it('conflicts：delete_vs_modify 给 confirm 建议；resolve 后 open 清空', async () => {
    const meta = getSyncDomain().meta
    meta.insertConflict({
      id: 'cf-1',
      entityType: 'character',
      entityId: 'c1',
      localEnvelope: { hash: 'sha256:aa', deleted: false },
      remoteEnvelope: { hash: 'sha256:bb', deleted: true },
    })
    const list = (await call('syncCenter:listConflicts', 'open')) as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]!.suggestion).toBe('confirm_delete_vs_modify')
    expect(list[0]!.localHash).toBe('sha256:aa')

    const r = (await call('syncCenter:resolveConflict', { id: 'cf-1', choice: 'local' })) as {
      ok: boolean
      status: Record<string, unknown>
    }
    expect(r.ok).toBe(true)
    expect(r.status.openConflicts).toBe(0)
    const after = (await call('syncCenter:listConflicts', 'open')) as unknown[]
    expect(after).toHaveLength(0)
  })

  it('S7-08：设备列表 / 退役后 receipt 清除 / tombstone dry-run', async () => {
    const meta = getSyncDomain().meta
    meta.saveReceipt({
      peerId: 'android-1',
      cursor: 5,
      knownVector: { 'android-1': '5', 'pc-1': '3' },
    })
    meta.upsertPeerDeviceState({ peerId: 'android-1', displayName: 'Pixel' })

    const devices = (await call('syncCenter:listDevices')) as Array<Record<string, unknown>>
    expect(devices).toHaveLength(1)
    expect(devices[0]!.deviceId).toBe('android-1')
    expect(devices[0]!.displayName).toBe('Pixel')
    expect(devices[0]!.retired).toBe(false)
    expect(devices[0]!.cursor).toBe(5)

    // tombstone dry-run：无删除记录时 total=0
    const dry0 = (await call('syncCenter:tombstoneDryRun')) as Record<string, unknown>
    expect(dry0.total).toBe(0)
    expect(dry0.deviceCount).toBe(1)

    // 退役：receipt 清除 + retired 标记
    const retired = (await call('syncCenter:retireDevice', 'android-1')) as { ok: boolean }
    expect(retired.ok).toBe(true)
    expect(meta.getReceipt('android-1')).toBeNull()
    expect(meta.isPeerDeviceRetired('android-1')).toBe(true)

    const devices2 = (await call('syncCenter:listDevices')) as Array<Record<string, unknown>>
    expect(devices2).toHaveLength(1)
    expect(devices2[0]!.retired).toBe(true)

    const dry1 = (await call('syncCenter:tombstoneDryRun')) as Record<string, unknown>
    expect(dry1.retiredCount).toBe(1)
    expect(dry1.deviceCount).toBe(0)
  })
})
