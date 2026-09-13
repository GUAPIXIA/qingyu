/**
 * 重新生成 shared/fixtures/roleplay-blocks.json 的 expected 字段。
 *
 * 契约：TS 参考实现（src/utils/roleplayBlocks.ts）是权威；修改分块规则后
 * 运行本脚本刷新 expected，再复制到 android/app/src/test/resources/fixtures/，
 * 双端 fixture 测试同时跑绿才算改完。
 *
 * 用法：npx tsx scripts/regenerate-roleplay-fixture.ts
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { buildRoleplayBlocks } from '../src/utils/roleplayBlocks'

const fixturePath = new URL('../shared/fixtures/roleplay-blocks.json', import.meta.url)
const androidCopy = new URL('../android/app/src/test/resources/fixtures/roleplay-blocks.json', import.meta.url)

const data = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  cases: Array<{ name: string; input: string; expected: unknown }>
}

for (const testCase of data.cases) {
  testCase.expected = buildRoleplayBlocks(testCase.input)
}

writeFileSync(fixturePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
copyFileSync(fixturePath, androidCopy)
console.log(`regenerated ${data.cases.length} cases -> shared + android copy`)
