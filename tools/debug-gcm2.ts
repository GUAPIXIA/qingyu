import { createCipheriv } from 'node:crypto'

// NIST GCM AES-256 empty PT/AAD
const key = Buffer.alloc(32, 0)
const iv = Buffer.alloc(12, 0)
const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
// no AAD
const body = Buffer.concat([c.update(Buffer.alloc(0)), c.final()])
const tag = c.getAuthTag()
console.log('nist empty body', body.toString('hex'), 'tag', tag.toString('hex'))
console.log('expect tag 530f8afbc74536b9a963b4f1c4cb738b')

const c2 = createCipheriv('aes-256-gcm', key, iv)
c2.setAAD(Buffer.alloc(0))
const body2 = Buffer.concat([c2.update(Buffer.alloc(0)), c2.final()])
console.log('empty aad body', body2.toString('hex'), 'tag', c2.getAuthTag().toString('hex'))

// known vector from SP 800-38D / common test
// key=0, iv=0, pt=0*16, aad=empty → ct and tag known
const c3 = createCipheriv('aes-256-gcm', key, iv)
const pt = Buffer.alloc(16, 0)
const body3 = Buffer.concat([c3.update(pt), c3.final()])
console.log('zero pt body', body3.toString('hex'), 'tag', c3.getAuthTag().toString('hex'))
// expected CT for AES-256-GCM zero key/iv/16zero pt: cea7403d4d606b6e074ec5d3baf39d18
// tag: d0d1c8a799996bf0265b98b5d48ab919 (this is for AES-128 actually)

// Try our exact case in isolation
const key2 = Buffer.from('00lVz6IQ6v+7KBXnj2xbq87yK/n6pSHUF5IeX1LhPaY=', 'base64')
const iv2 = Buffer.alloc(12, 1)
const plain = Buffer.from('7b226772656574696e67223a22e4bda0e5a5bd222c226e616d65223a22e6b58be8af95e8a792e889b222c2274616773223a5b2261222c2262225d7d', 'hex')
const aad = Buffer.from('71696e6779752d656e746974792d6161642f76317c31313131313131312d323232322d333333332d343434342d3535353535353535353535357c6368617261637465727c30314b43484152414354455230303030303030303030303030317c337c7368613235363a653930393566316261343037656631326635363831613438613731373537373434383062396664383662656565666630613435633634326338613136306165647c317c31', 'hex')
console.log('key2 len', key2.length, 'aad len', aad.length, 'plain', plain.length)

const c4 = createCipheriv('aes-256-gcm', key2, iv2, { authTagLength: 16 })
c4.setAAD(aad)
const body4 = Buffer.concat([c4.update(plain), c4.final()])
console.log('case body', body4.toString('hex'))
console.log('case tag', c4.getAuthTag().toString('hex'))
console.log('expect ts tag ac9f18f9b455acd22c4c4805151fb6c3')
console.log('java got    1a7a0c3125d1989db3d11b9016eeaff6')

// try without authTagLength option
const c5 = createCipheriv('aes-256-gcm', key2, iv2)
c5.setAAD(aad)
const body5 = Buffer.concat([c5.update(plain), c5.final()])
console.log('no-opt body match', body5.equals(body4), 'tag', c5.getAuthTag().toString('hex'))
