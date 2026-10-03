#!/usr/bin/env node
/**
 * 阶段 0 退出标准：schema 可验证正例并拒绝主要反例。
 * 正例：city-home / planet-system（world + runtime）
 * 反例：fixtures/invalid/ 中标记为 schema 层的样本必须失败
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const root = fileURLToPath(new URL('..', import.meta.url))

const SCHEMA_FILES = {
  world: 'schemas/spatial-world-v1.schema.json',
  runtime: 'schemas/spatial-runtime-v1.schema.json',
  command: 'schemas/spatial-command-v1.schema.json',
}

/** 正例：必须通过 schema */
const POSITIVE = [
  { file: 'fixtures/city-home.json', schema: 'world' },
  { file: 'fixtures/city-home.runtime.json', schema: 'runtime' },
  { file: 'fixtures/planet-system.json', schema: 'world' },
  { file: 'fixtures/planet-system.runtime.json', schema: 'runtime' },
]

/**
 * schema 层反例：必须失败。
 * 领域层反例（cross-kind / cross-board / circular / dangling）由阶段 1 校验器负责，
 * 这里不断言 schema 失败，只记录。
 */
const SCHEMA_NEGATIVE = [
  'fixtures/invalid/missing-required.json',
  'fixtures/invalid/geometry-non-positive.json',
  'fixtures/invalid/distance-measurement.json',
  'fixtures/invalid/third-node-kind.json',
]

const DOMAIN_ONLY_NEGATIVE = [
  'fixtures/invalid/cross-kind-distance.json',
  'fixtures/invalid/cross-board-distance.json',
  'fixtures/invalid/circular-parent.json',
  'fixtures/invalid/dangling-child-board.json',
]

function loadJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'))
}

function makeAjv() {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats(ajv)
  for (const rel of Object.values(SCHEMA_FILES)) {
    ajv.addSchema(loadJson(rel), rel)
  }
  return ajv
}

const ajv = makeAjv()
let failed = 0
let passed = 0

console.log('== 正例（必须通过）==')
for (const item of POSITIVE) {
  const data = loadJson(item.file)
  const validate = ajv.getSchema(SCHEMA_FILES[item.schema])
  const ok = validate(data)
  if (ok) {
    passed += 1
    console.log(`  PASS  ${item.file}  (${item.schema})`)
  } else {
    failed += 1
    console.error(`  FAIL  ${item.file}  (${item.schema})`)
    console.error(JSON.stringify(validate.errors, null, 2))
  }
}

console.log('\n== schema 层反例（必须失败）==')
for (const rel of SCHEMA_NEGATIVE) {
  const data = loadJson(rel)
  const validate = ajv.getSchema(SCHEMA_FILES.world)
  const ok = validate(data)
  if (!ok) {
    passed += 1
    console.log(`  PASS  ${rel}  (已拒绝)`)
  } else {
    failed += 1
    console.error(`  FAIL  ${rel}  (schema 未拒绝)` )
  }
}

console.log('\n== 领域层反例（阶段 1 负责；schema 可通过）==')
for (const rel of DOMAIN_ONLY_NEGATIVE) {
  const data = loadJson(rel)
  const validate = ajv.getSchema(SCHEMA_FILES.world)
  const ok = validate(data)
  console.log(`  NOTE  ${rel}  schema=${ok ? '通过（预期）' : '意外失败'}`)
  if (!ok) {
    console.error(JSON.stringify(validate.errors, null, 2))
    failed += 1
  } else {
    passed += 1
  }
}

console.log('\n== command schema 冒烟 ==')
const v = ajv.getSchema(SCHEMA_FILES.command)
const goodSample = {
  schemaVersion: 1,
  expectedRevision: 17,
  commands: [
    {
      type: 'move_actor',
      actorId: 'actor_lin_xue',
      from: { nodeId: 'place_square' },
      to: {
        boardId: 'board_home',
        anchor: { kind: 'node', nodeId: 'place_bedroom' },
        position: { x: -320, y: 1440 },
        semanticPosition: {
          precision: 'inside-only',
          relativeDirection: 'inside',
          note: '角色已跟随用户进入卧室',
        },
      },
      reason: 'assistant_message_explicit_arrival',
    },
  ],
}
const badSample = {
  schemaVersion: 1,
  expectedRevision: 17,
  commands: [{ type: 'teleport_actor', actorId: 'actor_lin_xue' }],
}
if (v(goodSample)) {
  passed += 1
  console.log('  PASS  合法 move_actor 命令批次')
} else {
  failed += 1
  console.error('  FAIL  合法 move_actor 命令批次')
  console.error(JSON.stringify(v.errors, null, 2))
}
if (!v(badSample)) {
  passed += 1
  console.log('  PASS  非法命令类型已拒绝')
} else {
  failed += 1
  console.error('  FAIL  非法命令类型未被拒绝')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
console.log('阶段 0 schema 退出标准达成。')
