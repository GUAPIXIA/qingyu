#!/usr/bin/env node
/**
 * 阶段 1 契约漂移门禁（Windows/Linux 可跑）。
 * 检查：schemas 可解析、fixtures JSON 合法、settings_public 无敏感字段、openapi operationId 唯一。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

function loadJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'))
}

const schemaDir = join(root, 'shared/contracts/schemas')
for (const f of readdirSync(schemaDir)) {
  if (!f.endsWith('.json')) continue
  try {
    JSON.parse(readFileSync(join(schemaDir, f), 'utf8'))
  } catch (e) {
    errors.push(`schema ${f}: ${e.message}`)
  }
}

for (const dir of ['canonical', 'valid', 'invalid']) {
  const p = join(root, 'shared/contracts/fixtures', dir)
  for (const f of readdirSync(p)) {
    if (!f.endsWith('.json')) continue
    try {
      JSON.parse(readFileSync(join(p, f), 'utf8'))
    } catch (e) {
      errors.push(`fixture ${dir}/${f}: ${e.message}`)
    }
  }
}

const valid = loadJson('shared/contracts/fixtures/valid/payloads.json')
const settings = valid.find((v) => v.entityType === 'settings_public')
const forbidden = ['apiKey', 'token', 'spaceKey', 'password', 'secret', 'privateKey']
if (settings) {
  const text = JSON.stringify(settings.payload).toLowerCase()
  for (const k of forbidden) {
    if (text.includes(k.toLowerCase())) errors.push(`settings_public fixture 含敏感字段: ${k}`)
  }
}
const invalid = loadJson('shared/contracts/fixtures/invalid/payloads.json')
if (!invalid.some((i) => i.expect === 'reject-sensitive')) {
  errors.push('invalid fixtures 缺少敏感字段拒绝样例')
}

const openapi = readFileSync(join(root, 'shared/contracts/openapi/sync-v1.yaml'), 'utf8')
const ids = [...openapi.matchAll(/operationId:\s*(\S+)/g)].map((m) => m[1])
const seen = new Set()
for (const id of ids) {
  if (seen.has(id)) errors.push(`openapi operationId 重复: ${id}`)
  seen.add(id)
}
for (const required of [
  'createSyncSession',
  'planSyncSession',
  'pushBatch',
  'pullBatch',
  'transferBlobs',
  'commitSyncSession',
  'abortSyncSession',
  'getSyncSession',
]) {
  if (!seen.has(required)) errors.push(`openapi 缺少 operationId: ${required}`)
}

// entityType 集合以 shared/contracts/sync-envelope.ts 的 SyncEntityType 联合类型为单一事实源，
// 与 JSON schema 的 enum 做双向比对：任一侧单独变更都必须使门禁变红。
// 历史教训：本脚本曾硬编码 17 项清单，D-11/D-12 冻结契约（群会话/群消息拆类型、memory_state/
// memory_fact 随 session 走、media_manifest 推迟到阶段 7）后清单过期，门禁长期"已知红"且无人维护；
// 改为派生比对后，契约变更只需改 sync-envelope.ts 与 schema 两侧的一致内容，不再需要维护清单。
function diffEntityTypes(tsTypes, enumValues) {
  const tsSet = new Set(tsTypes)
  const schemaSet = new Set(enumValues)
  return {
    missingInSchema: tsTypes.filter((t) => !schemaSet.has(t)),
    missingInTs: enumValues.filter((t) => !tsSet.has(t)),
  }
}

// 门禁自检：比对函数必须能识别注入的漂移，否则门禁"永远绿"形同虚设。
{
  const probe = diffEntityTypes(['probe_a', 'probe_b'], ['probe_a'])
  if (probe.missingInSchema.length !== 1 || probe.missingInTs.length !== 0) {
    errors.push('自检失败：entityType 比对函数未能识别注入的漂移')
  }
}

const envelopeTs = readFileSync(join(root, 'shared/contracts/sync-envelope.ts'), 'utf8')
const typeStart = envelopeTs.indexOf('export type SyncEntityType')
const typeEnd = typeStart === -1 ? -1 : envelopeTs.indexOf('export interface', typeStart)
if (typeStart === -1 || typeEnd === -1) {
  errors.push('shared/contracts/sync-envelope.ts 未找到 SyncEntityType 联合类型声明')
}
const tsDeclaration =
  typeStart === -1 || typeEnd === -1
    ? ''
    : envelopeTs
        .slice(typeStart, typeEnd)
        .replace(/\/\*[\s\S]*?\*\//g, '') // 去块注释，避免注释里的引号被当成成员
        .replace(/\/\/.*$/gm, '')
const tsEntityTypes = [...tsDeclaration.matchAll(/'([^']+)'/g)].map((m) => m[1])
if (tsEntityTypes.length === 0) {
  errors.push('SyncEntityType 联合类型解析为空（fail-loud，避免门禁静默通过）')
}

const envelopeSchema = JSON.parse(
  readFileSync(join(root, 'shared/contracts/schemas/sync-envelope.schema.json'), 'utf8'),
)
const enums = envelopeSchema.properties.entityType.enum
if (tsEntityTypes.length !== new Set(tsEntityTypes).size) {
  errors.push('SyncEntityType 联合类型存在重复成员')
}
if (enums.length !== new Set(enums).size) {
  errors.push('sync-envelope.schema.json entityType enum 存在重复值')
}

// 解析失败时已单独报错，跳过比对，避免刷出与实际原因无关的连带差异。
if (tsEntityTypes.length > 0) {
  const drift = diffEntityTypes(tsEntityTypes, enums)
  for (const t of drift.missingInSchema) {
    errors.push(`sync-envelope.schema.json 缺少 entityType: ${t}（SyncEntityType 已声明）`)
  }
  for (const t of drift.missingInTs) {
    errors.push(`sync-envelope.schema.json 多出 entityType: ${t}（SyncEntityType 未声明）`)
  }
}

if (errors.length) {
  console.error('check-contracts FAILED')
  for (const e of errors) console.error(' -', e)
  process.exit(1)
}
console.log('check-contracts OK')
console.log(
  ` schemas=${readdirSync(schemaDir).filter((f) => f.endsWith('.json')).length}`,
)
console.log(` openapi operations=${ids.length}`)
console.log(` entityTypes=${enums.length} schema / ${tsEntityTypes.length} SyncEntityType`)
