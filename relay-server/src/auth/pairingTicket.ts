import { createHmac, randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function createPairTicketSecret(): string { return randomBytes(32).toString('base64url') }
export function createPairCode(random = randomBytes(8)): string {
  let output = ''
  for (let index = 0; index < 8; index++) output += CROCKFORD[random[index]! % CROCKFORD.length]
  return output
}
export function normalizePairCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}
export function hashPairSecret(pepper: string, secret: string): Buffer {
  return createHmac('sha256', pepper).update(secret).digest()
}
