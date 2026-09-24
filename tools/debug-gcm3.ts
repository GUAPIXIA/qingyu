import { createCipheriv } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const plainHex = '7b226772656574696e67223a22e4bda0e5a5bd222c226e616d65223a22e6b58be8af95e8a792e889b222c2274616773223a5b2261222c2262225d7d'
const aadHex = '71696e6779752d656e746974792d6161642f76317c31313131313131312d323232322d333333332d343434342d3535353535353535353535357c6368617261637465727c30314b43484152414354455230303030303030303030303030317c337c7368613235363a653930393566316261343037656631326635363831613438613731373537373434383062396664383662656565666630613435633634326338613136306165647c317c31'

const plain = Buffer.from(plainHex, 'hex')
const aad = Buffer.from(aadHex, 'hex')
const key = Buffer.from('00lVz6IQ6v+7KBXnj2xbq87yK/n6pSHUF5IeX1LhPaY=', 'base64')
const iv = Buffer.alloc(12, 1)

console.log('plainLen', plain.length, 'aadLen', aad.length, 'keyLen', key.length)

const c = createCipheriv('aes-256-gcm', key, iv)
c.setAAD(aad)
const body = Buffer.concat([c.update(plain), c.final()])
const tag = c.getAuthTag()
console.log('body', body.toString('hex'))
console.log('tag', tag.toString('hex'))

writeFileSync(
  'tools/gcm-vector.json',
  JSON.stringify({ plainHex, aadHex, keyB64: key.toString('base64'), ivHex: iv.toString('hex'), bodyHex: body.toString('hex'), tagHex: tag.toString('hex') }, null, 2),
)
