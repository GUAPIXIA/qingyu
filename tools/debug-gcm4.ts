import { canonicalize, contentHash } from '../shared/contracts/canonical-json'
import { buildEntityAad, versionHashFromCanonical, deriveSubkey, encryptEntity } from '../shared/sync-crypto'
import { writeFileSync } from 'node:fs'

const payload = { name: '测试角色', greeting: '你好', tags: ['a', 'b'] }
const plain = Buffer.from(canonicalize(payload), 'utf8')
const aad = buildEntityAad({
  spaceId: '11111111-2222-3333-4444-555555555555',
  entityType: 'character',
  entityId: '01KCHARACTER00000000000001',
  schemaVersion: 3,
  versionHash: versionHashFromCanonical('{"pc_a":"12"}'),
  keyEpoch: 1,
  cipherRevision: 1,
})
const key = deriveSubkey(Buffer.alloc(32, 0x11), 'entity')
const iv = Buffer.alloc(12, 0x01)
const enc = encryptEntity({
  spaceKey: Buffer.alloc(32, 0x11),
  aad,
  payload,
  contentHash: contentHash(payload),
  nonce: iv,
})
const ct = Buffer.from(enc.ciphertext, 'base64')
writeFileSync(
  'tools/gcm-vector.json',
  JSON.stringify(
    {
      plainHex: plain.toString('hex'),
      plainLen: plain.length,
      aadHex: Buffer.from(aad, 'utf8').toString('hex'),
      aadLen: Buffer.from(aad, 'utf8').length,
      keyB64: key.toString('base64'),
      ivHex: iv.toString('hex'),
      bodyHex: ct.subarray(0, ct.length - 16).toString('hex'),
      tagHex: ct.subarray(ct.length - 16).toString('hex'),
      contentHash: contentHash(payload),
    },
    null,
    2,
  ),
)
console.log('wrote tools/gcm-vector.json', plain.length, aad.length)
