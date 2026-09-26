import { describe, expect, it } from 'vitest'
import {
  TELEMETRY_DEFAULT_CONSENT,
  byteBucket,
  countBucket,
  isTelemetryAllowed,
  redactForTelemetry,
} from '../telemetry/privacy'

const granted = { granted: true, enabled: true, updatedAt: 1 }

describe('S9-06 遥测隐私', () => {
  it('默认未同意：返回 null 且 isTelemetryAllowed=false', () => {
    expect(isTelemetryAllowed(TELEMETRY_DEFAULT_CONSENT)).toBe(false)
    expect(redactForTelemetry({ stage: 'sync', durationMs: 12 }, TELEMETRY_DEFAULT_CONSENT)).toBeNull()
  })

  it('用户关闭后不影响功能（仅拒绝上报）', () => {
    const off = { granted: true, enabled: false, updatedAt: 2 }
    expect(isTelemetryAllowed(off)).toBe(false)
    expect(redactForTelemetry({ stage: 'sync' }, off)).toBeNull()
  })

  it('只保留白名单字段', () => {
    const out = redactForTelemetry(
      {
        stage: 'lan_push',
        errorCode: 'E_TIMEOUT',
        durationMs: 123.4,
        itemCount: 55,
        byteCount: 2048,
        conflictKind: 'version_concurrent',
        // 禁止字段
        body: '用户聊天正文',
        entityId: '01ABCDEF',
        url: 'https://example.com/x',
        apiKey: 'sk-secret',
        spaceId: 'space-1',
        deviceName: 'MyPhone',
      },
      granted,
      '1.2.3',
    )
    expect(out).toBeTruthy()
    const o = out as Record<string, string | number>
    expect(o.app_version).toBe('1.2.3')
    expect(o.stage).toBe('lan_push')
    expect(o.error_code).toBe('E_TIMEOUT')
    expect(o.duration_ms).toBe(123)
    expect(o.item_count_bucket).toBe('11-100')
    expect(o.byte_count_bucket).toBe('1KB-64KB')
    expect(o.conflict_kind).toBe('version_concurrent')
    expect(JSON.stringify(o)).not.toContain('用户聊天正文')
    expect(JSON.stringify(o)).not.toContain('sk-secret')
    expect(JSON.stringify(o)).not.toContain('example.com')
    expect(JSON.stringify(o)).not.toContain('01ABCDEF')
    expect(JSON.stringify(o)).not.toContain('MyPhone')
  })

  it('拒绝 URL 与超长字符串', () => {
    const out = redactForTelemetry(
      { stage: 'https://evil.example/x', errorCode: 'x'.repeat(200) },
      granted,
    )
    expect(out).toBeNull()
  })

  it('计数落桶', () => {
    expect(countBucket(0)).toBe('0')
    expect(countBucket(5)).toBe('1-10')
    expect(countBucket(50)).toBe('11-100')
    expect(countBucket(5000)).toBe('1k-10k')
    expect(byteBucket(100)).toBe('1B-1KB')
    expect(byteBucket(2_000_000)).toBe('1MB-8MB')
  })
})
