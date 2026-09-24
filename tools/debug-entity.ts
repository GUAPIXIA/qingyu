import { contentHash, canonicalize } from '../shared/contracts/canonical-json'
import { encryptEntity, buildEntityAad, deriveSubkey, versionHashFromCanonical, decryptEntity } from '../shared/sync-crypto'

const p = { name: '测试角色', greeting: '你好', tags: ['a', 'b'] }
const plain = Buffer.from(canonicalize(p), 'utf8')
console.log('plain len', plain.length, plain.toString('hex'))
console.log('contentHash', contentHash(p))

const aad = buildEntityAad({
  spaceId: '11111111-2222-3333-4444-555555555555',
  entityType: 'character',
  entityId: '01KCHARACTER00000000000001',
  schemaVersion: 3,
  versionHash: versionHashFromCanonical('{"pc_a":"12"}'),
  keyEpoch: 1,
  cipherRevision: 1,
})
console.log('aad', aad)
console.log('key', deriveSubkey(Buffer.alloc(32, 0x11), 'entity').toString('base64'))

const enc = encryptEntity({
  spaceKey: Buffer.alloc(32, 0x11),
  aad,
  payload: p,
  contentHash: contentHash(p),
  nonce: Buffer.alloc(12, 0x01),
})
const ct = Buffer.from(enc.ciphertext, 'base64')
console.log('ct total', ct.length, 'body', ct.length - 16, 'tag', ct.subarray(ct.length - 16).toString('hex'))
console.log('ct body hex', ct.subarray(0, ct.length - 16).toString('hex'))
console.log('full ct b64', enc.ciphertext)

const dec = decryptEntity({ spaceKey: Buffer.alloc(32, 0x11), aad, encrypted: enc })
console.log('dec ok', contentHash(dec) === contentHash(p))
