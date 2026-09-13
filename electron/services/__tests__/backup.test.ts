/**
 * Backup V2 服务级回归测试（P0-A 目录穿越 / P0-B 凭据泄露 / 恢复回滚）
 *
 * 通过 mock electron 的 userData 路径隔离到系统临时目录，调用真实的
 * createBackupV2 / restoreBackupV2（不使用 AdmZip 模拟）。
 *
 * 注：本文件的“密钥”均为拼接出的测试夹具值，不是任何真实凭据，
 * 用途是断言导出包内不出现这些明文。
 *
 * 环境：adm-zip 的压缩/解压依赖原生 Buffer 语义，jsdom 环境下解压结果为空，
 * 故本文件固定使用 node 环境（与 tests/ 下其他服务级测试一致）。
 *
 * @vitest-environment node
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'

vi.mock('electron', () => ({
  app: {
    getPath: () => `${process.env.TEMP ?? '/tmp'}/qingyu-backup-test`,
    getVersion: () => '0.0.0-test',
  },
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/, ''),
  },
}))

import { createBackupV2, restoreBackupV2 } from '../backup'
import { getCredential } from '../safeStorage'

const TEST_ROOT = `${process.env.TEMP ?? '/tmp'}/qingyu-backup-test`
const DATA_ROOT = join(TEST_ROOT, 'data')
const ZIP_PATH = join(TEST_ROOT, 'backup.zip')

// 测试夹具：拼接构造，避免与真实凭据格式混淆
const FIXTURE = ['qingyu', 'test', 'fixture'].join('-')
const SEMANTIC_KEY = `semantic-${FIXTURE}`
const PROFILE_KEY = `profile-${FIXTURE}`
const MCP_ENV_VALUE = `env-${FIXTURE}`
const MCP_URL_AUTH = `auth-${FIXTURE}`

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

/** 写入一份包含各类敏感信息的完整数据集 */
function seedData(): void {
  writeJsonFile(join(DATA_ROOT, 'config', 'settings.json'), {
    theme: 'dark',
    semanticTrigger: { enabled: true, provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'text-embedding-3-small', apiKey: SEMANTIC_KEY, threshold: 0.3, maxResults: 3 },
    connectionProfiles: [{ id: 'p1', name: '主连接', provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o', apiKey: PROFILE_KEY, maxContext: 128000 }],
    ttsModels: [],
    imageGenModels: [],
    visionModels: [],
  })
  writeJsonFile(join(DATA_ROOT, 'config', 'mcp-servers.json'), [
    { id: 'mcp1', name: 'filesystem', transport: 'stdio', command: 'D:/tools/mcp.exe', args: ['--root', 'D:/data'], env: { API_KEY: MCP_ENV_VALUE, DEBUG: 'true' }, enabled: true, autoStart: false },
    { id: 'mcp2', name: 'remote', transport: 'sse', url: `https://user:${MCP_URL_AUTH}@example.com/sse`, enabled: true, autoStart: false },
  ])
  writeJsonFile(join(DATA_ROOT, 'characters', 'char1.json'), { id: 'char1', name: '测试角色' })
  writeFileSync(join(DATA_ROOT, 'characters', 'char1.png'), Buffer.from('fake-png'))
  writeJsonFile(join(DATA_ROOT, 'lorebooks', 'lb1.json'), { id: 'lb1', name: '世界书' })
  writeJsonFile(join(DATA_ROOT, 'presets', 'preset1.json'), { id: 'preset1', name: '预设' })
  writeJsonFile(join(DATA_ROOT, 'chats', 'char1', 'sessions.json'), [{ id: 's1' }])
  writeFileSync(join(DATA_ROOT, 'chats', 'char1', 's1.jsonl'), JSON.stringify({ id: 'm1', content: 'hi' }) + '\n')
  writeJsonFile(join(DATA_ROOT, 'groups', 'group1', 'sessions.json'), [{ id: 'g1' }])
}

function resetRoot(): void {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(DATA_ROOT, { recursive: true })
}

beforeEach(() => {
  resetRoot()
  seedData()
})

afterEach(() => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ===================== 恶意 zip 构造辅助 =====================

interface ZipSpec {
  /** 正常条目：写入 zip 且登记哈希 */
  files: Record<string, string | Buffer>
  /** 只写 zip、不登记哈希（触发"缺哈希记录"） */
  unhashed?: Record<string, string | Buffer>
  /** 只在 manifest.hashes 中登记、不写入 zip（触发"幽灵哈希"） */
  ghost?: string
  /** 篡改某条目的登记哈希（触发哈希不一致） */
  tamper?: { path: string; hash: string }
}

function writeZip(zipPath: string, spec: ZipSpec): void {
  const zip = new AdmZip()
  const hashes: Record<string, string> = {}
  for (const [zipEntry, content] of Object.entries(spec.files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')
    hashes[zipEntry] = sha256(buf)
    addRawEntry(zip, zipEntry, buf)
  }
  for (const [zipEntry, content] of Object.entries(spec.unhashed ?? {})) {
    addRawEntry(zip, zipEntry, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'))
  }
  if (spec.ghost) hashes[spec.ghost] = sha256(Buffer.from('ghost'))
  if (spec.tamper) hashes[spec.tamper.path] = spec.tamper.hash
  const manifest = { version: 2, appVersion: '0.0.0-test', createdAt: Date.now(), counts: {}, hashes, excluded: [], totalBytes: 0 }
  addRawEntry(zip, 'manifest.json', Buffer.from(JSON.stringify(manifest), 'utf-8'))
  zip.writeZip(zipPath)
}

/**
 * 以原始条目名写入 zip。
 * adm-zip 的 addFile 会做 zipnamefix（`..` 段会被规范化掉），
 * 而攻击者用其他工具构造的包不会经过该规范化——这里通过直接改写
 * entryName 复现真实攻击载荷。
 */
function addRawEntry(zip: AdmZip, entryName: string, buf: Buffer): void {
  const placeholder = `__raw__${zip.getEntries().length}`
  zip.addFile(placeholder, buf)
  const entry = zip.getEntry(placeholder)
  if (!entry) throw new Error(`占位条目写入失败: ${placeholder}`)
  entry.entryName = entryName
}

describe('createBackupV2 导出（P0-B 凭据剥离）', () => {
  it('settings 的 semanticTrigger.apiKey 与 profile apiKey 不落包，且不再出现在 settings.json 明文里', () => {
    const result = createBackupV2(ZIP_PATH)
    expect(existsSync(ZIP_PATH)).toBe(true)

    const zip = new AdmZip(ZIP_PATH)
    const settingsEntry = zip.getEntries().find((e) => e.entryName === 'config/settings.json')
    expect(settingsEntry).toBeTruthy()
    const settingsText = settingsEntry!.getData().toString('utf-8')
    expect(settingsText).not.toContain(SEMANTIC_KEY)
    expect(settingsText).not.toContain(PROFILE_KEY)
    // 保留非敏感字段
    expect(settingsText).toContain('text-embedding-3-small')

    // 遍历包内全部条目，确认没有任何明文密钥文本
    for (const entry of zip.getEntries()) {
      const text = entry.getData().toString('utf-8')
      expect(text).not.toContain(SEMANTIC_KEY)
      expect(text).not.toContain(PROFILE_KEY)
      expect(text).not.toContain(MCP_ENV_VALUE)
      expect(text).not.toContain(MCP_URL_AUTH)
    }

    // manifest 与包内条目双向一致（由 restoreBackupV2 强校验，此处先给出计数）
    expect(result.counts.settings).toBe(1)
    expect(result.excluded.join('')).toContain('MCP')
  })

  it('MCP env 敏感键置空、非敏感键保留；URL 内嵌凭据打码', () => {
    createBackupV2(ZIP_PATH)
    const zip = new AdmZip(ZIP_PATH)
    const mcp = JSON.parse(zip.getEntries().find((e) => e.entryName === 'config/mcp-servers.json')!.getData().toString('utf-8'))
    expect(mcp[0].env.API_KEY).toBe('')
    expect(mcp[0].env.DEBUG).toBe('true')
    expect(mcp[1].url).not.toContain(MCP_URL_AUTH)
    expect(mcp[1].url).toContain('example.com')
  })
})

describe('restoreBackupV2 正常往返', () => {
  it('导出→清空→导入后数据一致，明文凭据进入 safeStorage', () => {
    createBackupV2(ZIP_PATH)
    rmSync(DATA_ROOT, { recursive: true, force: true })

    const { counts } = restoreBackupV2(ZIP_PATH)
    expect(counts.characters).toBe(2) // char1.json + char1.png

    expect(existsSync(join(DATA_ROOT, 'characters', 'char1.json'))).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'characters', 'char1.png'))).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'lorebooks', 'lb1.json'))).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'presets', 'preset1.json'))).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'chats', 'char1', 'sessions.json'))).toBe(true)
    expect(existsSync(join(DATA_ROOT, 'groups', 'group1', 'sessions.json'))).toBe(true)

    const settingsText = readFileSync(join(DATA_ROOT, 'config', 'settings.json'), 'utf-8')
    expect(settingsText).not.toContain(SEMANTIC_KEY)
    expect(settingsText).not.toContain(PROFILE_KEY)
    // 导出包本身不含凭据，恢复后 safeStorage 中也不会有对应条目
    expect(getCredential('semanticTrigger')).toBeNull()
  })

  it('导入旧版含明文 apiKey 的 settings.json 时迁移进 safeStorage', () => {
    writeZip(ZIP_PATH, {
      files: {
        'config/settings.json': JSON.stringify({
          theme: 'dark',
          semanticTrigger: { enabled: true, provider: 'openai', baseUrl: '', model: 'm', apiKey: SEMANTIC_KEY, threshold: 0.3, maxResults: 3 },
          connectionProfiles: [{ id: 'p1', name: '主连接', provider: 'openai', baseUrl: '', model: 'gpt-4o', apiKey: PROFILE_KEY, maxContext: 128000 }],
        }),
      },
    })
    restoreBackupV2(ZIP_PATH)

    const settingsText = readFileSync(join(DATA_ROOT, 'config', 'settings.json'), 'utf-8')
    expect(settingsText).not.toContain(SEMANTIC_KEY)
    expect(settingsText).not.toContain(PROFILE_KEY)
    expect(getCredential('semanticTrigger')).toBe(SEMANTIC_KEY)
    expect(getCredential('profile-p1')).toBe(PROFILE_KEY)
  })
})

describe('restoreBackupV2 拒绝目录穿越（P0-A）', () => {
  const traversalCases: Array<[string, string]> = [
    ['相对上跳', 'characters/../../outside.json'],
    ['Windows 反斜杠变体', 'characters/..\\..\\outside.json'],
    ['盘符前缀', 'characters/C:/outside.json'],
    ['绝对路径', '/outside.json'],
    ['当前目录段', 'characters/./outside.json'],
    ['深层上跳', 'characters/a/../../../outside.json'],
    ['报告实测载荷', 'characters/../../../../../../QingYu-pwned.json'],
  ]

  for (const [label, evilPath] of traversalCases) {
    it(`拒绝 ${label}：${evilPath}`, () => {
      writeZip(ZIP_PATH, { files: { [evilPath]: '{"pwned":true}' } })
      expect(() => restoreBackupV2(ZIP_PATH)).toThrow(/非法|越出目标目录/)
    })
  }

  it('拒绝路径穿越后不产生目录外文件', () => {
    writeZip(ZIP_PATH, { files: { 'characters/../../outside.json': '{"pwned":true}' } })
    expect(() => restoreBackupV2(ZIP_PATH)).toThrow()
    expect(existsSync(join(TEST_ROOT, 'outside.json'))).toBe(false)
    expect(existsSync(join(DATA_ROOT, 'outside.json'))).toBe(false)

    // 报告实测载荷：解析后的逃逸目标也不应出现
    const escaped = join(DATA_ROOT, 'characters', '../../../../../../QingYu-pwned.json')
    writeZip(ZIP_PATH, { files: { 'characters/../../../../../../QingYu-pwned.json': '{"pwned":true}' } })
    expect(() => restoreBackupV2(ZIP_PATH)).toThrow()
    expect(existsSync(escaped)).toBe(false)
  })

  it('拒绝非法顶层 id（文件名即 id）', () => {
    writeZip(ZIP_PATH, { files: { 'characters/bad.id.json': '{"id":"bad.id"}' } })
    expect(() => restoreBackupV2(ZIP_PATH)).toThrow(/非法字符/)
  })

  it('拒绝未知前缀条目', () => {
    writeZip(ZIP_PATH, { files: { 'unknown-dir/x.json': '{}' } })
    expect(() => restoreBackupV2(ZIP_PATH)).toThrow(/未知条目/)
  })
})

describe('restoreBackupV2 manifest 双向校验（P0-A）', () => {
  it('拒绝无哈希记录的条目', () => {
    writeZip(ZIP_PATH, {
      files: { 'characters/char1.json': '{"id":"char1"}' },
      unhashed: { 'characters/evil.json': '{"id":"evil"}' },
    })
    expect(() => restoreBackupV2(ZIP_PATH)).toThrow(/缺少哈希记录/)
  })

  it('拒绝 manifest 记录但包内缺失的条目（幽灵哈希）', () => {
    writeZip(ZIP_PATH, {
      files: { 'characters/char1.json': '{"id":"char1"}' },
      ghost: 'characters/missing.json',
    })
    expect(() => restoreBackupV2(ZIP_PATH)).toThrow(/在压缩包中缺失/)
  })

  it('拒绝哈希不一致的条目', () => {
    writeZip(ZIP_PATH, {
      files: { 'characters/char1.json': '{"id":"char1"}' },
      tamper: { path: 'characters/char1.json', hash: 'deadbeef' },
    })
    expect(() => restoreBackupV2(ZIP_PATH)).toThrow(/哈希不一致/)
  })

  it('拒绝缺少 manifest.json 的包', () => {
    const zip = new AdmZip()
    zip.addFile('characters/char1.json', Buffer.from('{}'))
    zip.writeZip(ZIP_PATH)
    expect(() => restoreBackupV2(ZIP_PATH)).toThrow(/缺少 manifest\.json/)
  })
})

describe('restoreBackupV2 失败注入与完整回滚（P1-01）', () => {
  it('写入中途失败时恢复被覆盖文件并删除本次新建文件', () => {
    // 备份包含：新建角色文件 + 覆盖既有会话文件
    writeZip(ZIP_PATH, {
      files: {
        'characters/newchar.json': '{"id":"newchar"}',
        'chats/char1/sessions.json': '[{"id":"s2"}]',
      },
    })
    const sessionsPath = join(DATA_ROOT, 'chats', 'char1', 'sessions.json')
    const originalSessions = readFileSync(sessionsPath, 'utf-8')
    // 注入失败：目标临时文件路径被目录占据，writeFileSync(tmp) 必然失败
    mkdirSync(`${sessionsPath}.tmp`, { recursive: true })

    expect(() => restoreBackupV2(ZIP_PATH)).toThrow()

    // 被覆盖文件恢复原内容
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(originalSessions)
    // 本次新建文件被删除
    expect(existsSync(join(DATA_ROOT, 'characters', 'newchar.json'))).toBe(false)
    // 不残留临时文件
    expect(readdirSync(join(DATA_ROOT, 'characters')).some((f) => f.endsWith('.tmp'))).toBe(false)
  })
})
