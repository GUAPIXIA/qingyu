/**
 * 重新生成 shared/fixtures/roleplay-blocks.json 的 expected 字段。
 *
 * 契约：TS 参考实现（src/utils/roleplayBlocks.ts）是权威；修改分块规则后运行本脚本刷新 expected。
 *
 * 说明（2026-10-14）：安卓端已从 PC 仓解绑；原先复制到 `android/app/src/test/resources/`
 * 的副本由 qingyu-android 独立仓自行同步，本脚本不再跨仓写文件。
 *
 * 用法：npx tsx scripts/regenerate-roleplay-fixture.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { buildRoleplayBlocks } from '../src/utils/roleplayBlocks'

const fixturePath = new URL('../shared/fixtures/roleplay-blocks.json', import.meta.url)

const data = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  cases: Array<{ name: string; input: string; expected: unknown }>
}

for (const testCase of data.cases) {
  testCase.expected = buildRoleplayBlocks(testCase.input)
}

writeFileSync(fixturePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log(`regenerated ${data.cases.length} cases -> shared/fixtures/roleplay-blocks.json`)
