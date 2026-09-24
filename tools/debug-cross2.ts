import { createDecipheriv, createCipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'

const vec = JSON.parse(readFileSync('tools/gcm-vector.json', 'utf8'))
const key = Buffer.from(vec.keyB64, 'base64')
const iv = Buffer.from(vec.ivHex, 'hex')
const aad = Buffer.from(vec.aadHex, 'hex')
const body = Buffer.from(vec.bodyHex, 'hex')
const tag = Buffer.from(vec.tagHex, 'hex')
const plain = Buffer.from(vec.plainHex, 'hex')

console.log('vec', { plainLen: vec.plainLen, aadLen: vec.aadLen, bodyLen: body.length })

// 1) roundtrip with vector
try {
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(aad)
  d.setAuthTag(tag)
  const out = Buffer.concat([d.update(body), d.final()])
  console.log('vector roundtrip OK', out.equals(plain))
} catch (e: any) {
  console.log('vector roundtrip FAIL', e.message)
}

// 2) re-encrypt and compare tag
const c = createCipheriv('aes-256-gcm', key, iv)
c.setAAD(aad)
const body2 = Buffer.concat([c.update(plain), c.final()])
const tag2 = c.getAuthTag()
console.log('re-encrypt body match', body2.equals(body), 'tag match', tag2.equals(tag))
console.log('re-encrypt tag', tag2.toString('hex'))

// 3) try java tag
const javaTag = Buffer.from('1a7a0c3125d1989db3d11b9016eeaff6', 'hex')
try {
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(aad)
  d.setAuthTag(javaTag)
  const out = Buffer.concat([d.update(body), d.final()])
  console.log('java tag decrypt OK', out.toString('utf8'))
} catch (e: any) {
  console.log('java tag decrypt FAIL', e.message)
}

// 4) openssl-style: also try setAAD with plaintextLength
const c2 = createCipheriv('aes-256-gcm', key, iv)
c2.setAAD(aad, { plaintextLength: plain.length })
const body3 = Buffer.concat([c2.update(plain), c2.final()])
console.log('with plaintextLength tag', c2.getAuthTag().toString('hex'))
