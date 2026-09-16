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

const envelopeSchema = JSON.parse(
  readFileSync(join(root, 'shared/contracts/schemas/sync-envelope.schema.json'), 'utf8'),
)
const requiredTypes = [
  'settings_public',
  'character',
  'lorebook',
  'preset',
  'persona',
  'regex_rule',
  'quick_reply_set',
  'group',
  'session',
  'message',
  'memory_state',
  'memory_fact',
  'usage_record',
  'mcp_public_config',
  'media_manifest',
  'lorebook_mapping_template',
  'usage_clear_marker',
]
const enums = envelopeSchema.properties.entityType.enum
for (const t of requiredTypes) {
  if (!enums.includes(t)) errors.push(`envelope schema 缺少 entityType: ${t}`)
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
console.log(` entityTypes=${enums.length}`)
