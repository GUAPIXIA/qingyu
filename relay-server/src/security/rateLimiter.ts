import { createHash } from 'node:crypto'

export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export interface RateLimitResult { allowed: boolean; retryAfterSeconds: number }

const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`

export class RedisRateLimiter {
  constructor(private readonly redis: RedisEvalClient) {}

  async consume(namespace: string, identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const digest = createHash('sha256').update(identifier).digest('hex')
    const key = `rate:${namespace}:${digest}`
    const raw = await this.redis.eval(CONSUME_SCRIPT, 1, key, windowSeconds)
    const [count, ttl] = raw as [number, number]
    return { allowed: Number(count) <= limit, retryAfterSeconds: Math.max(1, Number(ttl) || windowSeconds) }
  }
}
