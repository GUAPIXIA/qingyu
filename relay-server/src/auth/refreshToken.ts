import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export function createOpaqueToken(): string { return randomBytes(32).toString('base64url') }
export function hashOpaqueToken(pepper: string, token: string): Buffer {
  return createHmac('sha256', pepper).update(token).digest()
}
export function verifyOpaqueToken(pepper: string, token: string, expected: Buffer): boolean {
  const actual = hashOpaqueToken(pepper, token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
