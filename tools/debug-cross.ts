import { createDecipheriv } from 'node:crypto'

const key = Buffer.from('00lVz6IQ6v+7KBXnj2xbq87yK/n6pSHUF5IeX1LhPaY=', 'base64')
const iv = Buffer.alloc(12, 1)
const aad = Buffer.from(
  'qingyu-entity-aad/v1|11111111-2222-3333-4444-555555555555|character|01KCHARACTER00000000000001|3|sha256:e9095f1ba407ef12f5681a48a7175774480b9fd86beeeff0a45c642c8a160aed|1|1',
  'utf8',
)
const body = Buffer.from('6dde30d94adf860073e8361554641ee74aa2734cab5da5733076b23f71baea2be559fdb458526eaf6d660dec6c28baaabe34152c2761ca1fa5bc8515', 'hex')
const tags = {
  ts: Buffer.from('ac9f18f9b455acd22c4c4805151fb6c3', 'hex'),
  java: Buffer.from('1a7a0c3125d1989db3d11b9016eeaff6', 'hex'),
}
for (const [name, tag] of Object.entries(tags)) {
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv)
    d.setAAD(aad)
    d.setAuthTag(tag)
    const plain = Buffer.concat([d.update(body), d.final()])
    console.log(name, 'DECRYPT_OK', plain.length, plain.toString('utf8'))
  } catch (e: unknown) {
    console.log(name, 'DECRYPT_FAIL', e instanceof Error ? e.message : String(e))
  }
}
console.log('aadLen', aad.length)
