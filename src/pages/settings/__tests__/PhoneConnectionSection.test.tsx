import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RELAY_BASE_URL } from '../../../../shared/relayProtocol'
import { PhoneConnectionSection } from '../PhoneConnectionSection'

describe('PhoneConnectionSection', () => {
  beforeEach(() => {
    localStorage.clear()
    ;(window.api as any).bridge = {
      status: vi.fn().mockResolvedValue({
        running: false,
        config: { enabled: false, host: '', port: 8321, bindIps: [] },
        bound: null,
      }),
      pairingInfo: vi.fn().mockResolvedValue({ host: '', port: 8321, fingerprint: '', expiresInSec: 0 }),
      listDevices: vi.fn().mockResolvedValue([]),
      pairingQrPayload: vi.fn().mockResolvedValue(''),
      start: vi.fn(),
      stop: vi.fn(),
      setConfig: vi.fn(),
      regeneratePairing: vi.fn(),
      revokeDevice: vi.fn(),
    }
    ;(window.api as any).relay = {
      status: vi.fn().mockResolvedValue({ state: 'Disabled' }),
      enable: vi.fn(),
      disable: vi.fn(),
      createPairTicket: vi.fn(),
      clearCache: vi.fn(),
      onStatusChanged: vi.fn().mockReturnValue(() => {}),
    }
  })

  it('将局域网与服务器连接收纳在同一个双通道面板', async () => {
    render(<PhoneConnectionSection />)

    expect(screen.getAllByRole('heading', { name: '手机连接' })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /局域网连接/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /服务器连接/ })).toHaveAttribute('aria-selected', 'false')
    await waitFor(() => expect((window.api as any).bridge.status).toHaveBeenCalled())
  })

  it('服务器连接默认填写官方地址', async () => {
    render(<PhoneConnectionSection />)

    fireEvent.click(screen.getByRole('tab', { name: /服务器连接/ }))

    expect(screen.getByLabelText('服务器地址')).toHaveValue(DEFAULT_RELAY_BASE_URL)
    await waitFor(() => expect((window.api as any).relay.status).toHaveBeenCalled())
  })
})
