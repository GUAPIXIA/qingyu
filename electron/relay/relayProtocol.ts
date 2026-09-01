import { RELAY_MAX_JSON_BYTES, isRelayFrame, relayFrame, type RelayFrame } from '../../shared/relayProtocol'
export { relayFrame }
export function decodeRelayFrame(raw: string | Buffer): RelayFrame {
  if (Buffer.byteLength(raw) > RELAY_MAX_JSON_BYTES) throw new Error('Relay 帧超过 256 KiB')
  const value: unknown = JSON.parse(raw.toString())
  if (!isRelayFrame(value)) throw new Error('Relay 协议版本不兼容')
  return value
}
