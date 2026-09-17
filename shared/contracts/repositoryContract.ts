/**
 * 阶段 2 S2-01：repository 契约套件（语言无关行为表的 TypeScript 执行器）。
 *
 * 行为表位于 `shared/contracts/fixtures/repository/behavior-table.json`。
 * PC 文件实现（`PcDomainRepository`）、进程内内存实现，以及阶段 3 的 Room 实现
 * 必须对同一份表给出一致结果；Kotlin 侧按同一 JSON 表实现等价 runner 即可。
 *
 * 断言风格刻意保持与测试框架无关：执行器只返回失败原因，由调用方转换为各自框架的断言。
 */
import type { VersionVector } from './version-vector'
import type { SyncEntityType } from './sync-envelope'

export interface RepositoryContractStep {
  op: string
  entityType?: SyncEntityType | string
  entityId?: string
  payload?: Record<string, unknown>
  cursor?: number
  limit?: number
  expect?: Record<string, unknown>
  as?: string
  earlier?: string
  later?: string
  left?: string
  right?: string
  expectTotal?: number
  deviceId?: string
  counter?: string
  payloadContains?: Record<string, unknown>
}

export interface RepositoryContractCase {
  id: string
  description?: string
  steps: RepositoryContractStep[]
}

export interface RepositoryContractTable {
  version: number
  cases: RepositoryContractCase[]
}

/** 被契约约束的最小仓储接口 */
export interface ContractRepositoryAdapter {
  put(input: { entityType: string; entityId: string; payload: Record<string, unknown> }): void
  tombstone(input: { entityType: string; entityId: string }): void
  applyRemote(input: {
    entityType: string
    entityId: string
    payload: Record<string, unknown>
    deviceId: string
    counter: string
  }): void
  getHead(entityType: string, entityId: string): { version: VersionVector; hash: string; deleted: boolean } | null
  changesAfter(cursor: number, limit: number): { rows: Array<{ seq: number; origin: string }>; nextCursor: number }
  /** 读取实体当前落盘内容；不存在返回 null */
  readEntity(entityType: string, entityId: string): Record<string, unknown> | null
  /** 清空实现内部状态，供单个 case 独立运行 */
  reset(): void
}

export interface ContractFailure {
  caseId: string
  stepIndex: number
  op: string
  message: string
}

function compareVersionVectors(a: VersionVector, b: VersionVector): 'equal' | 'less' | 'greater' | 'incomparable' {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  let aGreater = false
  let bGreater = false
  for (const key of keys) {
    const av = BigInt(a[key] ?? '0')
    const bv = BigInt(b[key] ?? '0')
    if (av > bv) aGreater = true
    else if (av < bv) bGreater = true
  }
  if (aGreater && bGreater) return 'incomparable'
  if (aGreater) return 'greater'
  if (bGreater) return 'less'
  return 'equal'
}

/** 运行行为表；返回全部失败项（空数组表示实现满足契约） */
export function runRepositoryContract(
  table: RepositoryContractTable,
  adapter: ContractRepositoryAdapter,
  hashOf: (payload: Record<string, unknown>) => string,
): ContractFailure[] {
  const failures: ContractFailure[] = []

  for (const testCase of table.cases) {
    adapter.reset()
    const captured: Record<string, unknown> = {}

    testCase.steps.forEach((step, stepIndex) => {
      const fail = (message: string): void => {
        failures.push({ caseId: testCase.id, stepIndex, op: step.op, message })
      }
      const entityType = String(step.entityType ?? '')
      const entityId = String(step.entityId ?? '')

      try {
        switch (step.op) {
          case 'put':
            adapter.put({ entityType, entityId, payload: step.payload ?? {} })
            break

          case 'tombstone':
            adapter.tombstone({ entityType, entityId })
            break

          case 'applyRemote':
            adapter.applyRemote({
              entityType,
              entityId,
              payload: step.payload ?? {},
              deviceId: step.deviceId ?? 'remote',
              counter: step.counter ?? '1',
            })
            break

          case 'captureHeadVersion': {
            const head = adapter.getHead(entityType, entityId)
            if (!head) {
              fail('head 不存在，无法捕获版本向量')
              break
            }
            captured[String(step.as)] = head.version
            break
          }

          case 'captureHeadHash': {
            const head = adapter.getHead(entityType, entityId)
            if (!head) {
              fail('head 不存在，无法捕获哈希')
              break
            }
            captured[String(step.as)] = head.hash
            break
          }

          case 'expectVersionStrictlyGreater': {
            const earlier = captured[String(step.earlier)] as VersionVector | undefined
            const later = captured[String(step.later)] as VersionVector | undefined
            if (!earlier || !later) {
              fail('缺少捕获的版本向量')
              break
            }
            const rel = compareVersionVectors(later, earlier)
            if (rel !== 'greater') fail(`版本向量未严格递增（later vs earlier = ${rel}）`)
            break
          }

          case 'expectEqual': {
            const left = captured[String(step.left)]
            const right = captured[String(step.right)]
            if (left !== right) fail(`期望相等：${String(left)} != ${String(right)}`)
            break
          }

          case 'expectHead': {
            const head = adapter.getHead(entityType, entityId)
            const expect = step.expect ?? {}
            if (expect.exists === false) {
              if (head) fail('期望 head 不存在，但实际存在')
              break
            }
            if (!head) {
              fail('期望 head 存在，但缺失')
              break
            }
            if (expect.deleted !== undefined && head.deleted !== expect.deleted) {
              fail(`deleted 期望 ${String(expect.deleted)} 实际 ${String(head.deleted)}`)
            }
            if (expect.hashIsContentHashOfPayload === true) {
              const expected = hashOf(step.payload ?? {})
              if (head.hash !== expected) fail('head.hash 与 payload 的规范 contentHash 不一致')
            }
            break
          }

          case 'expectChanges': {
            const expect = step.expect ?? {}
            const origin = String(expect.origin ?? '')
            const page = adapter.changesAfter(step.cursor ?? 0, step.limit ?? 1000)
            const matched = page.rows.filter((r) => r.origin === origin)
            if (expect.count !== undefined && matched.length !== Number(expect.count)) {
              fail(`origin=${origin} 变更数期望 ${String(expect.count)} 实际 ${matched.length}`)
            }
            break
          }

          case 'expectPagedUnionEqualsTotal': {
            const limit = step.limit ?? 2
            const expectedTotal = step.expectTotal ?? 0
            const seen: number[] = []
            let cursor = 0
            let guard = 0
            for (;;) {
              const page = adapter.changesAfter(cursor, limit)
              if (page.rows.length === 0) break
              if (page.nextCursor < cursor) {
                fail('nextCursor 回退')
                break
              }
              for (const row of page.rows) {
                if (seen.includes(row.seq)) fail(`分页出现重复 seq=${row.seq}`)
                seen.push(row.seq)
              }
              cursor = page.nextCursor
              if (++guard > 50) {
                fail('分页未收敛')
                break
              }
            }
            if (seen.length !== expectedTotal) {
              fail(`分页并集大小期望 ${expectedTotal} 实际 ${seen.length}`)
            }
            break
          }

          case 'expectReadable': {
            const entity = adapter.readEntity(entityType, entityId)
            if (!entity) {
              fail('实体不可读')
              break
            }
            for (const [key, value] of Object.entries(step.payloadContains ?? {})) {
              if (entity[key] !== value) fail(`读取内容缺少 ${key}=${String(value)}`)
            }
            break
          }

          case 'expectNotReadable': {
            if (adapter.readEntity(entityType, entityId)) fail('实体仍然可读，期望已删除')
            break
          }

          case 'expectPutRejected': {
            let threw = false
            try {
              adapter.put({ entityType, entityId, payload: step.payload ?? {} })
            } catch {
              threw = true
            }
            if (!threw) fail('非法实体 ID 未被拒绝')
            break
          }

          default:
            fail(`未知操作 ${step.op}`)
        }
      } catch (err) {
        fail(`执行抛出异常：${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  return failures
}
