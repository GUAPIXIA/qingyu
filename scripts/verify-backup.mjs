#!/usr/bin/env node
/**
 * Backup V2 校验脚本
 * 用法：
 *   node scripts/verify-backup.mjs <zipPath>
 *   node scripts/verify-backup.mjs --self-test
 *
 * - <zipPath> : 校验指定 zip 备份的 manifest 与文件哈希是否一致，并打印清单
 * - --self-test: 调用真实的 createBackupV2 / restoreBackupV2 做「导出→校验→清空→导入→比对」，
 *   并附带一次恶意 zip（目录穿越条目）拒绝检查。
 *
 * 自检不再用 AdmZip 模拟 manifest 逻辑（A3）：只有真实实现的往返结果才算证据。
 * 真实实现通过 esbuild 打包 electron/services/backup.ts 并注入 electron 桩模块运行。
 */

import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }

async function loadAdmZip() {
  const mod = await import('adm-zip')
  return mod.default ?? mod
}

async function verifyZip(zipPath) {
  if (!existsSync(zipPath)) { console.error(`文件不存在: ${zipPath}`); process.exit(1) }
  const AdmZip = await loadAdmZip()
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()
  const manifestEntry = entries.find(e => e.entryName === 'manifest.json')
  if (!manifestEntry) { console.error('缺少 manifest.json，可能是 V1 JSON 备份'); process.exit(1) }
  const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
  console.log('=== Backup V2 Manifest ===')
  console.log(JSON.stringify(manifest, null, 2))
  console.log('\n=== 哈希校验 ===')
  let ok = true
  const names = new Set(entries.filter((e) => !e.isDirectory).map((e) => e.entryName))
  for (const e of entries) {
    if (e.isDirectory || e.entryName === 'manifest.json') continue
    const expected = manifest.hashes?.[e.entryName]
    if (!expected) { console.error(`❌ 无哈希记录: ${e.entryName}`); ok = false; continue }
    const actual = sha256(e.getData())
    if (actual !== expected) {
      console.error(`❌ 哈希不一致: ${e.entryName}\n   期望 ${expected}\n   实际 ${actual}`)
      ok = false
    } else {
      console.log(`✅ ${e.entryName} (${(e.getData().length/1024).toFixed(1)} KB)`)
    }
  }
  for (const recorded of Object.keys(manifest.hashes ?? {})) {
    if (!names.has(recorded)) { console.error(`❌ manifest 记录的条目在包内缺失: ${recorded}`); ok = false }
  }
  if (ok) console.log('\n✅ 校验通过：所有文件哈希一致')
  else { console.error('\n❌ 校验失败'); process.exit(1) }
  console.log(`\n清单: version=${manifest.version} appVersion=${manifest.appVersion} counts=${JSON.stringify(manifest.counts)} excluded=${manifest.excluded.join(', ')}`)
}

/**
 * 打包并加载真实的 backup.ts 实现。
 * electron 模块被替换为桩：getPath('userData') 指向自检根目录（DIRS 会再拼 /data），
 * safeStorage 走内存实现。
 */
async function loadRealBackup(userDataDir, workDir) {
  const backupTs = join(process.cwd(), 'electron', 'services', 'backup.ts')
  if (!existsSync(backupTs)) throw new Error(`找不到真实实现: ${backupTs}`)

  const stubPath = join(workDir, 'electron-stub.mjs')
  writeFileSync(stubPath, [
    `export const app = { getPath: () => ${JSON.stringify(userDataDir)}, getVersion: () => 'self-test' }`,
    'export const dialog = {}',
    'const store = new Map()',
    'export const safeStorage = {',
    '  isEncryptionAvailable: () => true,',
    "  encryptString: (v) => Buffer.from('enc:' + v, 'utf-8'),",
    "  decryptString: (b) => b.toString('utf-8').replace(/^enc:/, ''),",
    '  __store: store,',
    '}',
    '',
  ].join('\n'), 'utf-8')

  let esbuild
  try {
    esbuild = await import('esbuild')
  } catch {
    throw new Error('自检需要 esbuild（项目 devDependency），请先在仓库根目录执行 pnpm install')
  }
  const outPath = join(workDir, 'selftest.bundle.cjs')
  await esbuild.build({
    // 用 stdin + resolveDir 引用真实实现，避免临时目录与仓库不同盘符时的相对路径问题
    stdin: {
      contents: "export { createBackupV2, restoreBackupV2 } from './backup.ts'",
      resolveDir: join(process.cwd(), 'electron', 'services'),
      sourcefile: 'selftest-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    // adm-zip 等 CJS 依赖内部使用动态 require，必须打成 CJS 产物
    format: 'cjs',
    outfile: outPath,
    alias: { electron: stubPath.replace(/\\/g, '/') },
    logLevel: 'silent',
  })
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)(outPath)
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ 自检失败：${message}`)
    process.exit(1)
  }
}

async function selfTest() {
  console.log('=== Backup V2 自检：真实实现 导出→校验→清空→导入→比对 ===')
  const AdmZip = await loadAdmZip()
  const dir = mkdtempSync(join(tmpdir(), 'qingyu-verify-'))
  const dataDir = join(dir, 'data')
  const configDir = join(dataDir, 'config')
  mkdirSync(configDir, { recursive: true })

  // 拼接构造的夹具值（非真实凭据），用于断言导出包内不出现明文
  const fixture = ['qingyu', 'verify', 'fixture'].join('-')
  const semanticKey = `semantic-${fixture}`

  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
    theme: 'dark',
    semanticTrigger: { enabled: true, provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'text-embedding-3-small', apiKey: semanticKey, threshold: 0.3, maxResults: 3 },
  }, null, 2))
  writeFileSync(join(configDir, 'mcp-servers.json'), JSON.stringify([
    { id: 'm1', name: 'filesystem', transport: 'stdio', command: 'D:/tools/mcp.exe', env: { API_KEY: `env-${fixture}`, DEBUG: 'true' }, enabled: true, autoStart: false },
  ], null, 2))
  mkdirSync(join(dataDir, 'characters'), { recursive: true })
  writeFileSync(join(dataDir, 'characters', 'char1.json'), JSON.stringify({ id: 'char1', name: '测试角色' }))
  writeFileSync(join(dataDir, 'characters', 'char1.png'), Buffer.from('fake-png'))
  mkdirSync(join(dataDir, 'chats', 'char1'), { recursive: true })
  writeFileSync(join(dataDir, 'chats', 'char1', 'sessions.json'), JSON.stringify([{ id: 's1' }]))
  writeFileSync(join(dataDir, 'chats', 'char1', 's1.jsonl'), JSON.stringify({ id: 'm1', content: 'hi' }) + '\n')

  const { createBackupV2, restoreBackupV2 } = await loadRealBackup(dir, dir)
  const zipPath = join(dir, 'test.zip')
  const result = createBackupV2(zipPath)
  console.log(`已用真实实现生成测试 zip: ${zipPath}（counts=${JSON.stringify(result.counts)}）`)

  await verifyZip(zipPath)

  // 导出内容断言：不含明文凭据
  const exported = new AdmZip(zipPath)
  for (const entry of exported.getEntries()) {
    const text = entry.getData().toString('utf-8')
    assert(!text.includes(semanticKey), `包内条目 ${entry.entryName} 含 semanticTrigger.apiKey 明文`)
    assert(!text.includes(`env-${fixture}`), `包内条目 ${entry.entryName} 含 MCP env 明文`)
  }
  const exportedSettings = JSON.parse(exported.getEntries().find((e) => e.entryName === 'config/settings.json').getData().toString('utf-8'))
  assert(exportedSettings.semanticTrigger.apiKey === undefined, 'settings.json 未剥离 semanticTrigger.apiKey')
  const exportedMcp = JSON.parse(exported.getEntries().find((e) => e.entryName === 'config/mcp-servers.json').getData().toString('utf-8'))
  assert(exportedMcp[0].env.API_KEY === '', 'MCP env 敏感值未置空')
  console.log('✅ 导出内容检查：无明文凭据（settings / MCP env）')

  // 清空后导入
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  const restored = restoreBackupV2(zipPath)
  assert(restored.counts.characters === 2, '恢复计数与 manifest 不一致')

  const expectFiles = [
    ['characters/char1.json', 'characters/char1.json'],
    ['characters/char1.png', 'characters/char1.png'],
    ['chats/char1/sessions.json', 'chats/char1/sessions.json'],
    ['chats/char1/s1.jsonl', 'chats/char1/s1.jsonl'],
  ]
  for (const [zipEntry, dataRel] of expectFiles) {
    const path = join(dataDir, dataRel)
    assert(existsSync(path), `恢复后缺少文件 ${dataRel}`)
    const original = new AdmZip(zipPath).getEntries().find((e) => e.entryName === zipEntry)
    assert(original, `zip 内缺少条目 ${zipEntry}`)
    assert(readFileSync(path).equals(original.getData()), `恢复内容不一致 ${dataRel}`)
  }
  const restoredSettings = readFileSync(join(dataDir, 'config', 'settings.json'), 'utf-8')
  assert(!restoredSettings.includes(semanticKey), '恢复后的 settings.json 出现明文凭据')
  console.log('✅ 往返比对：文件与导出前一致')

  // 恶意 zip：目录穿越条目必须整包拒绝且不产生目录外文件
  const evilZipPath = join(dir, 'evil.zip')
  const evil = new AdmZip()
  evil.addFile('placeholder', Buffer.from('{"pwned":true}'))
  evil.getEntry('placeholder').entryName = 'characters/../../../../../../QingYu-pwned.json'
  const evilBuf = Buffer.from('{"pwned":true}')
  evil.addFile('manifest.json', Buffer.from(JSON.stringify({
    version: 2, appVersion: 'evil', createdAt: Date.now(), counts: {}, excluded: [], totalBytes: 0,
    hashes: { 'characters/../../../../../../QingYu-pwned.json': sha256(evilBuf) },
  })))
  evil.writeZip(evilZipPath)
  let rejected = false
  try { restoreBackupV2(evilZipPath) } catch { rejected = true }
  assert(rejected, '目录穿越条目未被拒绝')
  const escaped = join(dataDir, 'characters', '../../../../../../QingYu-pwned.json')
  assert(!existsSync(escaped), '目录穿越产生了目录外文件')
  console.log('✅ 恶意包检查：目录穿越条目被拒绝，未产生目录外文件')

  rmSync(dir, { recursive: true, force: true })
  console.log('\n✅ 自检完成：真实实现导出→导入往返一致，安全断言全部通过')
}

const arg = process.argv[2]
if (!arg || arg === '--help' || arg === '-h') {
  console.log('用法: node scripts/verify-backup.mjs <zipPath> | --self-test')
  process.exit(0)
}
if (arg === '--self-test') await selfTest()
else await verifyZip(arg)
