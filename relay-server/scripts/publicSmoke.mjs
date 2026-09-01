import WebSocket from 'ws'

const baseUrl = process.env.RELAY_SMOKE_BASE_URL
if (!baseUrl) throw new Error('RELAY_SMOKE_BASE_URL is required')
const origin = new URL(baseUrl).origin
const spaces = []

async function request(path, init) {
  const response = await fetch(`${origin}${path}`, init)
  return response
}

async function register(name) {
  const response = await request('/relay/v1/spaces/register-pc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, fingerprint: `smoke-${name}-${crypto.randomUUID()}` }),
  })
  if (response.status !== 201) throw new Error(`register ${name} returned ${response.status}`)
  const token = await response.json()
  spaces.push(token.spaceId)
  return token
}

function pcReady(token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/relay/v1/ws/pc', origin); url.protocol = 'wss:'
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token.accessToken}` } })
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('WebSocket pc:ready timeout')) }, 10_000)
    ws.on('open', () => ws.send(JSON.stringify({
      v: 1, type: 'pc:hello', id: crypto.randomUUID(), sentAt: Date.now(),
      payload: { deviceId: token.deviceId, appVersion: 'smoke', protocolVersion: 1, capabilities: ['relay.rpc'] },
    })))
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.type !== 'pc:ready') return
      clearTimeout(timeout); ws.close(); resolve()
    })
    ws.on('error', (error) => { clearTimeout(timeout); reject(error) })
  })
}

try {
  const a = await register('relay-smoke-a')
  const b = await register('relay-smoke-b')
  await pcReady(a)
  const ownDevices = await request('/relay/v1/devices', { headers: { Authorization: `Bearer ${a.accessToken}` } })
  const ownDeviceRows = ownDevices.status === 200 ? await ownDevices.json() : []
  const crossRevoke = await request(`/relay/v1/devices/${encodeURIComponent(b.deviceId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${a.accessToken}` } })
  const refresh = await request('/relay/v1/tokens/refresh', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: a.refreshToken }),
  })
  if (ownDevices.status !== 200 || ownDeviceRows.length !== 1 || ownDeviceRows.some((device) => device.deviceId === b.deviceId) || crossRevoke.status !== 404 || refresh.status !== 200) {
    throw new Error(`unexpected statuses devices=${ownDevices.status} cross=${crossRevoke.status} refresh=${refresh.status}`)
  }
  console.log(JSON.stringify({ ok: true, websocket: 'pc:ready', ownDevices: ownDevices.status, ownDeviceCount: ownDeviceRows.length, crossTenantRevoke: crossRevoke.status, refresh: refresh.status, cleanupSpaceIds: spaces }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), cleanupSpaceIds: spaces }))
  process.exitCode = 1
}
