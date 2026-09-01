import { readFileSync } from 'node:fs'

export interface RelayConfig {
  port: number; publicUrl: URL; databaseUrl: string; redisUrl: string
  jwtPrivateKey: string; jwtPublicKey: string; tokenPepper: string; pairCodePepper: string
  registrationMode: 'open' | 'invite'; quotaBytes: number; retentionDays: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function secret(env: NodeJS.ProcessEnv, pathName: string, inlineName: string): string {
  const path = env[pathName]?.trim()
  if (path) return readFileSync(path, 'utf8')
  if (env.NODE_ENV === 'test') return required(env, inlineName)
  throw new Error(`${pathName} must point to a mounted secret`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const publicUrl = new URL(required(env, 'RELAY_PUBLIC_URL'))
  if (publicUrl.protocol !== 'https:' && env.NODE_ENV === 'production') throw new Error('RELAY_PUBLIC_URL must use HTTPS')
  const tokenPepper = required(env, 'TOKEN_PEPPER')
  const pairCodePepper = required(env, 'PAIR_CODE_PEPPER')
  if (Buffer.byteLength(tokenPepper) < 32 || Buffer.byteLength(pairCodePepper) < 32 || tokenPepper === pairCodePepper) {
    throw new Error('Token and pair-code peppers must be distinct and at least 32 bytes')
  }
  return {
    port: Number(env.PORT ?? 3100), publicUrl,
    databaseUrl: required(env, 'DATABASE_URL'), redisUrl: required(env, 'REDIS_URL'),
    jwtPrivateKey: secret(env, 'JWT_PRIVATE_KEY_PATH', 'JWT_PRIVATE_KEY'),
    jwtPublicKey: secret(env, 'JWT_PUBLIC_KEY_PATH', 'JWT_PUBLIC_KEY'),
    tokenPepper, pairCodePepper,
    registrationMode: env.REGISTRATION_MODE === 'invite' ? 'invite' : 'open',
    quotaBytes: Number(env.DEFAULT_SPACE_QUOTA_BYTES ?? 524_288_000),
    retentionDays: Number(env.DEFAULT_CACHE_RETENTION_DAYS ?? 7),
  }
}
