import { createCipheriv } from 'node:crypto'

const key = Buffer.alloc(32, 0x11)
const nonce = Buffer.alloc(12, 0x01)
const plain = Buffer.from('hello', 'utf8')

function enc(aad: Buffer | null) {
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  if (aad) c.setAAD(aad)
  const body = Buffer.concat([c.update(plain), c.final()])
  const tag = c.getAuthTag()
  return { body: body.toString('hex'), tag: tag.toString('hex') }
}

const a = enc(null)
const b = enc(Buffer.from('hello-aad', 'utf8'))
console.log('noaad', a)
console.log('withaad', b)
console.log('tags equal?', a.tag === b.tag)

const c = createCipheriv('aes-256-gcm', key, nonce)
c.setAAD(Buffer.from('x', 'utf8'))
const body = Buffer.concat([c.update(plain), c.final()])
console.log('setAAD default options', body.toString('hex'), c.getAuthTag().toString('hex'))
