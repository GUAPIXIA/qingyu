import { buildEntityAad, versionHashFromCanonical, deriveSubkey, encryptEntity } from '../shared/sync-crypto'
import { contentHash } from '../shared/contracts/canonical-json'

const aad = buildEntityAad({
  spaceId: '11111111-2222-3333-4444-555555555555',
  entityType: 'character',
  entityId: '01KCHARACTER00000000000001',
  schemaVersion: 3,
  versionHash: versionHashFromCanonical('{"pc_a":"12"}'),
  keyEpoch: 1,
  cipherRevision: 1,
})
console.log('AAD_STR=' + aad)
console.log('AAD_HEX=' + Buffer.from(aad, 'utf8').toString('hex'))
console.log('AAD_LEN=' + Buffer.from(aad, 'utf8').length)
console.log('KEY_B64=' + deriveSubkey(Buffer.alloc(32, 0x11), 'entity').toString('base64'))
const p = { name: '测试角色', greeting: '你好', tags: ['a', 'b'] }
const enc = encryptEntity({
  spaceKey: Buffer.alloc(32, 0x11),
  aad,
  payload: p,
  contentHash: contentHash(p),
  nonce: Buffer.alloc(12, 0x01),
})
console.log('TAG=' + Buffer.from(enc.ciphertext, 'base64').subarray(-16).toString('hex'))
