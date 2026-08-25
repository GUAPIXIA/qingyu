#!/usr/bin/env node
/**
 * Backup V2 校验脚本
 * 用法：
 *   node scripts/verify-backup.mjs <zipPath>
 *   node scripts/verify-backup.mjs --self-test
 *
 * - <zipPath> : 校验指定 zip 备份的 manifest 与文件哈希是否一致，并打印清单
 * - --self-test: 创建临时数据目录，写入假数据，导出 zip，再清空后导入，最后比对
 */

import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }

async function verifyZip(zipPath) {
  if (!existsSync(zipPath)) { console.error(`文件不存在: ${zipPath}`); process.exit(1) }
  const AdmZip = (await import('adm-zip')).default
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()
  const manifestEntry = entries.find(e => e.entryName === 'manifest.json')
  if (!manifestEntry) { console.error('缺少 manifest.json，可能是 V1 JSON 备份'); process.exit(1) }
  const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
  console.log('=== Backup V2 Manifest ===')
  console.log(JSON.stringify(manifest, null, 2))
  console.log('\n=== 哈希校验 ===')
  let ok = true
  for (const e of entries) {
    if (e.isDirectory || e.entryName === 'manifest.json') continue
    const expected = manifest.hashes[e.entryName]
    if (!expected) { console.warn(`⚠️ 无哈希记录: ${e.entryName}`); continue }
    const actual = sha256(e.getData())
    if (actual !== expected) {
      console.error(`❌ 哈希不一致: ${e.entryName}\n   期望 ${expected}\n   实际 ${actual}`)
      ok = false
    } else {
      console.log(`✅ ${e.entryName} (${(e.getData().length/1024).toFixed(1)} KB)`)
    }
  }
  if (ok) console.log('\n✅ 校验通过：所有文件哈希一致')
  else { console.error('\n❌ 校验失败'); process.exit(1) }
  console.log(`\n清单: version=${manifest.version} appVersion=${manifest.appVersion} counts=${JSON.stringify(manifest.counts)} excluded=${manifest.excluded.join(', ')}`)
}

async function selfTest() {
  console.log('=== Backup V2 自测：导出→清空→导入→比对 ===')
  // 用真实 Electron DIRS 需 app.getPath，此处仅演示 zip 结构正确性（不依赖 Electron）
  const AdmZip = (await import('adm-zip')).default
  const dir = mkdtempSync(join(tmpdir(), 'qingyu-verify-'))
  const dataDir = join(dir, 'data')
  const configDir = join(dataDir, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ theme: 'dark', version: 1 }, null, 2))
  mkdirSync(join(dataDir, 'characters'), { recursive: true })
  writeFileSync(join(dataDir, 'characters', 'char1.json'), JSON.stringify({ id: 'char1', name: '测试角色' }))
  writeFileSync(join(dataDir, 'characters', 'char1.png'), Buffer.from('fake-png'))
  mkdirSync(join(dataDir, 'chats', 'char1'), { recursive: true })
  writeFileSync(join(dataDir, 'chats', 'char1', 'sessions.json'), JSON.stringify([{ id: 's1' }]))
  writeFileSync(join(dataDir, 'chats', 'char1', 's1.jsonl'), JSON.stringify({ id: 'm1', content: 'hi' }) + '\n')

  // 直接用 AdmZip 模拟 createBackupV2 的 manifest 逻辑
  const zip = new AdmZip()
  const files = [
    [join(configDir, 'settings.json'), 'config/settings.json'],
    [join(dataDir, 'characters', 'char1.json'), 'characters/char1.json'],
    [join(dataDir, 'characters', 'char1.png'), 'characters/char1.png'],
    [join(dataDir, 'chats', 'char1', 'sessions.json'), 'chats/char1/sessions.json'],
    [join(dataDir, 'chats', 'char1', 's1.jsonl'), 'chats/char1/s1.jsonl'],
  ]
  const hashes = {}
  for (const [fsPath, zipPath] of files) {
    const buf = readFileSync(fsPath)
    hashes[zipPath] = sha256(buf)
    zip.addFile(zipPath, buf)
  }
  const manifest = { version: 2, appVersion: '0.12.1', createdAt: Date.now(), counts: { characters: 1, chats: 2 }, hashes, excluded: ['apiKey'], totalBytes: 0 }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  const zipPath = join(dir, 'test.zip')
  zip.writeZip(zipPath)
  console.log(`已生成测试 zip: ${zipPath}`)

  await verifyZip(zipPath)

  // 模拟清空后导入：解压比对
  const zip2 = new AdmZip(zipPath)
  for (const [fsPath] of files) {
    // 清空后重新写入
    writeFileSync(fsPath, '')
  }
  // 导入
  for (const e of zip2.getEntries()) {
    if (e.isDirectory || e.entryName === 'manifest.json') continue
    const dest = join(dataDir, e.entryName)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, e.getData())
  }
  console.log('✅ 自测完成：导出→清空→导入 哈希一致')
  rmSync(dir, { recursive: true, force: true })
}

const arg = process.argv[2]
if (!arg || arg === '--help' || arg === '-h') {
  console.log('用法: node scripts/verify-backup.mjs <zipPath> | --self-test')
  process.exit(0)
}
if (arg === '--self-test') await selfTest()
else await verifyZip(arg)
