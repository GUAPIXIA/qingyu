import { RELAY_MAX_JSON_BYTES, RELAY_PROTOCOL_VERSION, isRelayFrame, type RelayFrame } from '../../../shared/relayProtocol.js'

export class RelayProtocolError extends Error {
  constructor(message: string, readonly closeCode: number) { super(message) }
}

export function decodeFrame(raw: Buffer | string): RelayFrame {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength
  if (bytes > RELAY_MAX_JSON_BYTES) throw new RelayProtocolError('frame too large', 1009)
  let value: unknown
  try { value = JSON.parse(raw.toString()) } catch { throw new RelayProtocolError('invalid json', 1007) }
  const version = (value as { v?: unknown } | null)?.v
  if (version !== RELAY_PROTOCOL_VERSION) throw new RelayProtocolError('upgrade required', 4406)
  if (!isRelayFrame(value)) throw new RelayProtocolError('invalid frame', 1007)
  return value
}

export function encodeFrame(frame: RelayFrame): string {
  const json = JSON.stringify(frame)
  if (Buffer.byteLength(json) > RELAY_MAX_JSON_BYTES) throw new RelayProtocolError('frame too large', 1009)
  return json
}
