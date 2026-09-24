import { createCipheriv } from 'node:crypto'
import { canonicalize, contentHash } from '../shared/contracts/canonical-json'
import { buildEntityAad, versionHashFromCanonical, deriveSubkey, encryptEntity } from '../shared/sync-crypto'

const payload = { name: '测试角色', greeting: '你好', tags: ['a', 'b'] }
const plain = Buffer.from(canonicalize(payload), 'utf8')
const aadStr = buildEntityAad({
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
const aad = Buffer.from(aadStr, 'utf8')

const enc = encryptEntity({
  spaceKey: Buffer.alloc(32, 0x11),
  aad: aadStr as never,
  payload,
  contentHash: contentHash(payload),
  nonce: iv,
})
const ct = Buffer.from(enc.ciphertext, 'base64')
console.log('encryptEntity tag', ct.subarray(ct.length - 16).toString('hex'))

for (const mode of ['none', 'withLen'] as const) {
  const c = createCipheriv('aes-256-gcm', key, iv)
  if (mode === 'none') c.setAAD(aad)
  else c.setAAD(aad, { plaintextLength: plain.length })
  const body = Buffer.concat([c.update(plain), c.final()])
  console.log(mode, 'tag', c.getAuthTag().toString('hex'), 'bodyEq', body.equals(ct.subarray(0, ct.length - 16)))
}
console.log('aadLen', aad.length, 'plainLen', plain.length)
