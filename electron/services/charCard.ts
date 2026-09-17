import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DIRS, readJson, readJsonAsync, serializeJson, writeExportFile } from './storage'
import type { Character, RegexRule, QuickReply, QuickReplyStore } from '../../shared/types'
import type { CanonicalLorebookDocumentV2 } from '../../shared/lorebook/domain/v2'
import { validateCanonicalLorebookV2 } from '../../shared/lorebook/domain/validation'
import { migrateLorebookDocumentToLatest } from '../../shared/lorebook/migrations'
import { createLogger } from './logger'
import { nanoid } from 'nanoid'
import { validateCharacterCard, formatValidationErrors } from './charCardValidator'
import { readPngTextChunks, writePngTextChunk, detectMimeType } from './charCardPng'
import { downloadImageAsBase64 } from './charCardDownload'
import { importLorebookWithRegistry } from './lorebookAdapters/registry'
import { commitThroughDomain, deleteThroughDomain, writeThroughDomain, type DomainWriteFile } from '../domain/syncDomainService'

const log = createLogger('charCard')

// ===================== S2-04：域实体规范 payload =====================

/**
 * 角色实体 payload（shared/contracts/schemas/character-payload.schema.json）。
 * 只写入 schema 允许且已定义的字段；avatarBlobId 需要 blob 存储（媒体通道）支撑，
 * 当前未实现，故不下发悬空引用（S2-05 bootstrap 扫描器同样不下发）。
 */
function characterEntityPayload(character: Character): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    // name 为 schema 必填（minLength 1）；与导入归一化一致的兜底名
    name: typeof character.name === 'string' && character.name.length > 0 ? character.name : '未命名角色',
  }
  if (typeof character.description === 'string') payload.description = character.description
  if (typeof character.personality === 'string') payload.personality = character.personality
  if (typeof character.scenario === 'string') payload.scenario = character.scenario
  if (typeof character.firstMessage === 'string') payload.firstMessage = character.firstMessage
  if (typeof character.exampleDialog === 'string') payload.exampleDialog = character.exampleDialog
  if (typeof character.systemPrompt === 'string') payload.systemPrompt = character.systemPrompt
  if (typeof character.creator === 'string') payload.creator = character.creator
  const tags = stringArray(character.tags, 64)
  if (tags) payload.tags = tags
  const alternateGreetings = stringArray(character.alternateGreetings, 32)
  if (alternateGreetings) payload.alternateGreetings = alternateGreetings
  const boundLorebookIds = stringArray(character.boundLorebookIds, 32)
  if (boundLorebookIds) payload.boundLorebookIds = boundLorebookIds
  if (character.boundPresetId !== undefined) {
    payload.boundPresetId = typeof character.boundPresetId === 'string' ? character.boundPresetId : null
  }
  if (character.extensions && typeof character.extensions === 'object' && !Array.isArray(character.extensions)) {
    payload.extensions = character.extensions
  }
  return payload
}

/** schema 数组字段归一化：与 S2-05 bootstrap 扫描器一致（过滤非字符串并截断 maxItems） */
function stringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string').slice(0, max)
}

/** regex_rule 实体 payload：与 S2-05 bootstrap 扫描器一致（条目去掉 id） */
function regexRulePayload(rule: RegexRule): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...rule }
  delete payload.id
  return payload
}

/**
 * 与 lorebookDocumentStore.saveLorebookDocumentInput 相同的 canonical 归一化（只算不落盘）。
 * 角色导入内嵌世界书时文件必然不存在，因此 legacy 备份/迁移日志分支不会触发。
 */
function canonicalLorebookDocument(value: unknown, now = Date.now()): CanonicalLorebookDocumentV2 {
  const canonical = validateCanonicalLorebookV2(value)
  if (canonical.valid) return canonical.value
  return migrateLorebookDocumentToLatest(value, {
    now,
    revision: 1,
    contentHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  })
}

/** lorebook 实体 payload：与 S2-05 bootstrap 扫描器一致（文件正文去掉 id 字段） */
function lorebookEntityPayload(document: CanonicalLorebookDocumentV2): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...document }
  delete payload.id
  return payload
}

/** 从 PNG 文件导入角色卡 */
export async function importCharacterFromPng(filePath: string, proxyUrl?: string): Promise<Character> {
  const buffer = readFileSync(filePath)
  const chunks = readPngTextChunks(buffer)
  // 优先读取 v2 的 chara 字段，fallback 到 v3 的 ccv3 字段
  const charaBase64 = chunks['chara'] || chunks['ccv3']
  if (!charaBase64) {
    throw new Error('该 PNG 文件不包含角色卡数据（未找到 chara 或 ccv3 字段）')
  }

  let charaJson: string
  try {
    charaJson = Buffer.from(charaBase64, 'base64').toString('utf-8')
  } catch {
    throw new Error('角色卡 base64 解码失败')
  }

  const parsed = JSON.parse(charaJson)
  // 头像直接用 PNG 文件的 base64
  const avatarBase64 = `data:image/png;base64,${buffer.toString('base64')}`
  const character = await normalizeCharacter(parsed, avatarBase64, proxyUrl)
  log.info('PNG 角色卡导入成功', { name: character.name, path: filePath.substring(0, 80) })
  return character
}

/** 从 JSON 文件导入角色卡 */
export async function importCharacterFromJson(filePath: string, proxyUrl?: string): Promise<Character> {
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(raw)

  // 检测 SillyTavern 世界书格式：有 entries + scan_depth 且无 spec/data 包装
  if (
    parsed.entries &&
    (Array.isArray(parsed.entries) ? parsed.entries.length > 0 : Object.keys(parsed.entries).length > 0) &&
    typeof parsed.scan_depth === 'number' &&
    !parsed.spec &&
    !parsed.data
  ) {
    const entryCount = Array.isArray(parsed.entries) ? parsed.entries.length : Object.keys(parsed.entries).length
    throw new Error(
      `这个文件是世界书（Lorebook），包含 ${entryCount} 条条目，不是角色卡。\n请在世界书页面使用"导入 JSON"功能导入。`
    )
  }

  const character = await normalizeCharacter(parsed, undefined, proxyUrl)
  log.info('JSON 角色卡导入成功', { name: character.name, path: filePath.substring(0, 80), hasAvatar: !!character.avatar })
  return character
}

/** 将各种格式归一化为 Character */
async function normalizeCharacter(parsed: unknown, avatarBase64?: string, proxyUrl?: string): Promise<Character> {
  // 导入时校验角色卡基本结构（拦截损坏/非法卡）
  const validation = validateCharacterCard(parsed)
  if (!validation.ok) {
    throw new Error(`角色卡校验失败：${formatValidationErrors(validation)}`)
  }
  // 角色卡数据：V2/V3 为 data 包裹，裸卡为顶层；导入时字段类型不做强校验（由校验器把关）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = ((parsed as { data?: Record<string, unknown> }).data ?? parsed) as Record<string, any>
  // 裸卡顶层字段（V1/裸格式）：与 data 同级访问
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsedTop = parsed as Record<string, any>
  const now = Date.now()

  // 图片候选字段：data 包裹优先，其次裸卡顶层。
  // 覆盖 cover/thumbnail/portrait 等社区卡常见字段，下载与「重新加载封面」共用同一来源。
  const imageUrlCandidate = (
    data.cover ?? data.avatar ?? data.image ?? data.image_url ??
    data.thumbnail ?? data.portrait ??
    parsedTop.cover ?? parsedTop.avatar ?? parsedTop.image ?? parsedTop.image_url ??
    parsedTop.thumbnail ?? parsedTop.portrait ??
    null
  ) as unknown

  // 确定头像来源：优先级 传入参数 > JSON 中的图片字段
  let finalAvatar = avatarBase64 ?? ''
  if (!finalAvatar) {
    // 检查 JSON 中的图片字段
    const imageUrl = imageUrlCandidate

    if (imageUrl) {
      if (typeof imageUrl === 'string') {
        if (imageUrl.startsWith('data:image/')) {
          // 已经是 data URL
          finalAvatar = imageUrl
        } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
          // URL -> 下载
          const result = await downloadImageAsBase64(imageUrl, proxyUrl)
          if (result.success && result.data) {
            finalAvatar = result.data
            log.info('角色卡封面下载成功', { name: data.name, url: imageUrl.substring(0, 100) })
          } else {
            log.warn('角色卡封面下载失败', {
              name: data.name,
              url: imageUrl.substring(0, 100),
              code: result.code ?? 'UNKNOWN',
              error: result.error ?? '',
              statusCode: result.statusCode ?? null,
            })
          }
        } else if (/^[A-Za-z0-9+/=]{100,}$/.test(imageUrl.trim())) {
          // 纯 base64（无 data:image 前缀），自动检测类型并补全
          try {
            const buffer = Buffer.from(imageUrl.trim(), 'base64')
            const mime = detectMimeType(buffer)
            finalAvatar = `data:${mime};base64,${imageUrl.trim()}`
          } catch {
            log.warn('角色卡封面 base64 解析失败', { name: data.name })
          }
        }
      }
    }
  }

  // V2/V3 兼容：完整提取所有字段
  let firstMes = data.first_mes ?? data.firstMessage ?? ''
  const altGreetings: string[] = []
  if (Array.isArray(data.alternate_greetings)) {
    for (const g of data.alternate_greetings) {
      if (typeof g === 'string' && g.trim()) altGreetings.push(g)
    }
  }
  if (!firstMes && altGreetings.length > 0) {
    firstMes = altGreetings[0]
  }

  // 群聊专用开场白
  const groupGreetings: string[] = []
  if (Array.isArray(data.group_only_greetings)) {
    for (const g of data.group_only_greetings) {
      if (typeof g === 'string' && g.trim()) groupGreetings.push(g)
    }
  }

  // 记录原始图片 URL（用于重新加载封面）：与上面下载共用同一候选字段，
  // 避免仅识别 avatar/image 而漏掉 cover/thumbnail/portrait，导致重加载按钮不出现。
  const rawImageUrl = (!finalAvatar) ? imageUrlCandidate : ''
  const importImageUrl = (typeof rawImageUrl === 'string' && !rawImageUrl.startsWith('data:')
    && (rawImageUrl.startsWith('http://') || rawImageUrl.startsWith('https://')))
    ? rawImageUrl : undefined

  // tags 归一化：兼容字符串、数组、缺失等脏格式（部分社区卡 tags 为 "a、b、c" 字符串）
  const rawTags = data.tags ?? parsedTop.tags ?? []
  let normalizedTags: string[] = []
  if (Array.isArray(rawTags)) {
    normalizedTags = rawTags.filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0).map((t: string) => t.trim())
  } else if (typeof rawTags === 'string') {
    normalizedTags = rawTags.split(/[,，、\n]+/).map((s: string) => s.trim()).filter((s: string) => s.length > 0)
  }

  const character: Character = {
    id: nanoid(),
    name: data.name ?? parsedTop.name ?? '未命名角色',
    avatar: finalAvatar,
    cover: finalAvatar, // 封面与头像初始同源，后续可单独更换
    description: data.description ?? '',
    personality: data.personality ?? '',
    scenario: data.scenario ?? '',
    firstMessage: firstMes,
    exampleDialog: data.mes_example ?? data.exampleDialog ?? '',
    tags: normalizedTags,
    lorebookId: data.character_book?.id ?? null,
    creator: data.creator ?? '',
    createdAt: now,
    updatedAt: now,
    alternateGreetings: altGreetings,
    systemPrompt: data.system_prompt ?? '',
    postHistoryInstructions: data.post_history_instructions ?? '',
    creatorNotes: data.creator_notes ?? '',
    characterVersion: data.character_version ?? '',
    groupOnlyGreetings: groupGreetings,
    extensions: data.extensions ?? undefined,
    translatedContent: data.extensions?.translatedContent ?? undefined,
    _importImageUrl: importImageUrl,
  }

  // 自动提取内嵌世界书
  const charBook = data.character_book
  if (charBook && charBook.entries) {
    try {
      const lorebookId = nanoid()
      const imported = importLorebookWithRegistry(charBook, {
        id: lorebookId,
        fallbackName: `${character.name}的世界书`,
        file: { fileName: 'embedded-character_book.json', extension: 'json' },
      })

      const lorebookDir = DIRS.lorebooks()
      mkdirSync(lorebookDir, { recursive: true })
      // 内嵌世界书属于 lorebook 域：经 lorebook 域事务提交（角色导入不再绕过 journal）。
      // 新建文件时 lorebookDocumentStore 的 legacy 备份/迁移日志分支本就不触发，
      // 这里复用同一 canonical 归一化，保证落盘字节与该旧入口一致。
      const lorebookPath = join(lorebookDir, `${lorebookId}.json`)
      const document = canonicalLorebookDocument(imported.document)
      writeThroughDomain({
        domain: 'lorebook',
        entityType: 'lorebook',
        entityId: lorebookId,
        payload: lorebookEntityPayload(document),
        schemaVersion: 1,
        files: [{ path: lorebookPath, content: JSON.stringify(document, null, 2) }],
      })
      character.lorebookId = lorebookId
    } catch {
      // 提取失败不阻断角色导入
    }
  }

  // 世界书匹配已从导入流程移除（原自动绑定为静默副作用，且对中文失效）。
  // 改为导入后由 IPC 层调用 lorebookMatcher.suggestLorebooks 返回候选，
  // 前端弹窗让用户确认绑定（见 electron/ipc/character.ts）

  return character
}

/** 导出角色卡为 PNG */
export function exportCharacterToPng(character: Character, savePath: string): void {
  let pngBuffer: Buffer
  if (character.avatar.startsWith('data:image/png;base64,')) {
    pngBuffer = Buffer.from(character.avatar.split(',')[1], 'base64')
  } else if (character.avatar.startsWith('data:image/')) {
    // 非 PNG 图片，创建 1x1 透明 PNG 作为基底
    pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
  } else {
    pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
  }

  const charaJson = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      first_mes: character.firstMessage,
      alternate_greetings: character.alternateGreetings,
      mes_example: character.exampleDialog,
      system_prompt: character.systemPrompt || '',
      post_history_instructions: character.postHistoryInstructions || '',
      creator_notes: character.creatorNotes || '',
      character_version: character.characterVersion || '',
      group_only_greetings: character.groupOnlyGreetings || [],
      tags: character.tags,
      creator: character.creator,
      extensions: {
        ...(character.extensions || {}),
        ...(character.translatedContent ? { translatedContent: character.translatedContent } : {}),
      },
    },
  })
  const charaBase64 = Buffer.from(charaJson).toString('base64')

  const newBuffer = writePngTextChunk(pngBuffer, 'chara', charaBase64)
  writeExportFile(savePath, newBuffer)
}

/** 导出角色卡为 JSON */
export function exportCharacterToJson(character: Character, savePath: string): void {
  const data = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      first_mes: character.firstMessage,
      alternate_greetings: character.alternateGreetings,
      mes_example: character.exampleDialog,
      system_prompt: character.systemPrompt || '',
      post_history_instructions: character.postHistoryInstructions || '',
      creator_notes: character.creatorNotes || '',
      character_version: character.characterVersion || '',
      group_only_greetings: character.groupOnlyGreetings || [],
      tags: character.tags,
      creator: character.creator,
      extensions: {
        ...(character.extensions || {}),
        ...(character.translatedContent ? { translatedContent: character.translatedContent } : {}),
      },
    },
  }
  writeExportFile(savePath, JSON.stringify(data, null, 2))
}

/** 从 data URL 解析图片二进制（非 data URL 或解码失败返回 null） */
function decodeImageDataUrl(dataUrl: string | undefined): Buffer | null {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return null
  const commaIdx = dataUrl.indexOf(',')
  if (commaIdx < 0) return null
  try {
    const buffer = Buffer.from(dataUrl.slice(commaIdx + 1), 'base64')
    return buffer.length > 0 ? buffer : null
  } catch {
    return null
  }
}

/** 解析封面的文件扩展名（无法解析时返回 null） */
export function getCoverExtension(character: Character): string | null {
  const buffer = decodeImageDataUrl(character.cover || character.avatar)
  if (!buffer) return null
  const ext = detectMimeType(buffer).split('/')[1]
  return ext === 'jpeg' ? 'jpg' : ext
}

/** 导出角色封面为独立图片文件 */
export function exportCharacterCover(character: Character, savePath: string): void {
  const buffer = decodeImageDataUrl(character.cover || character.avatar)
  if (!buffer) throw new Error('该角色没有可导出的封面图片')
  writeExportFile(savePath, buffer)
}

/**
 * 角色头像/封面媒体文件（属于角色聚合）：只计算目标路径与字节，
 * 落盘由角色域事务连同角色 JSON 一起提交。
 */
interface CharacterMediaFile {
  path: string
  buffer: Buffer
}

/**
 * 媒体文件以 Buffer 放入事务 files：
 * DomainWriteFile.content 声明为 string|null，而 Node 的 writeFileSync 对 Buffer 参数
 * 忽略 encoding、按原始字节写入（事务内 stageTransaction / applyFilesDirectly 均如此），
 * 因此二进制媒体可以逐字节保真地随角色实体一起提交。
 */
function mediaWriteFile(media: CharacterMediaFile): DomainWriteFile {
  return { path: media.path, content: media.buffer as unknown as string }
}

/** 解码 data URL 头像/封面字节（空或不可解码返回 null） */
function decodeImageBase64(base64Data: string): Buffer | null {
  if (!base64Data) return null
  const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')
  return buffer.length > 0 ? buffer : null
}

/** 头像（suffix ''）或封面（suffix '_cover'）媒体文件；扩展名按检测到的真实格式决定 */
function imageMediaFile(characterId: string, suffix: string, base64Data: string): CharacterMediaFile | null {
  const buffer = decodeImageBase64(base64Data)
  if (!buffer) return null
  const ext = detectMimeType(buffer).split('/')[1] // png, jpeg, gif, webp
  const fileName = ext === 'jpeg' ? 'jpg' : ext
  return { path: join(DIRS.characters(), `${characterId}${suffix}.${fileName}`), buffer }
}

/** 读取角色头像 base64（自动检测 MIME 类型） */
export function readAvatar(characterId: string): string | null {
  const avatarDir = DIRS.characters()
  // 尝试所有可能的扩展名
  const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp']
  for (const ext of extensions) {
    const avatarPath = join(avatarDir, `${characterId}.${ext}`)
    if (existsSync(avatarPath)) {
      try {
        const buffer = readFileSync(avatarPath)
        const mime = detectMimeType(buffer)
        return `data:${mime};base64,${buffer.toString('base64')}`
      } catch {
        continue
      }
    }
  }
  return null
}

/** 读取封面 base64 */
export function readCover(characterId: string): string | null {
  const avatarDir = DIRS.characters()
  const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp']
  for (const ext of extensions) {
    const coverPath = join(avatarDir, `${characterId}_cover.${ext}`)
    if (existsSync(coverPath)) {
      try {
        const buffer = readFileSync(coverPath)
        const mime = detectMimeType(buffer)
        return `data:${mime};base64,${buffer.toString('base64')}`
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * S2-04 角色域写入口（原 saveCharacter 的实现收口）。
 * 角色 JSON 与其头像/封面媒体在同一字符域事务内提交；flag 关闭时退化为原子直写（与旧行为一致）。
 * 这是角色聚合唯一的落盘入口：IPC 的保存/导入/批量导入/绑定世界书/重加载封面均经此提交。
 */
export function saveCharacterThroughDomain(character: Character): void {
  const characterDir = DIRS.characters()
  mkdirSync(characterDir, { recursive: true })
  const filePath = join(characterDir, `${character.id}.json`)

  // JSON 中不存 base64，只存空字符串（图片从文件读取）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { avatar: _avatar, cover: _cover, ...rest } = character
  const files: DomainWriteFile[] = [
    { path: filePath, content: serializeJson({ ...rest, avatar: '', cover: '' }) },
  ]
  // 头像/封面媒体文件同属角色聚合：与 JSON 在同一事务内落盘
  const avatarMedia = typeof character.avatar === 'string' && character.avatar.startsWith('data:')
    ? imageMediaFile(character.id, '', character.avatar)
    : null
  if (avatarMedia) files.push(mediaWriteFile(avatarMedia))
  const coverMedia = typeof character.cover === 'string' && character.cover.startsWith('data:')
    ? imageMediaFile(character.id, '_cover', character.cover)
    : null
  if (coverMedia) files.push(mediaWriteFile(coverMedia))

  writeThroughDomain({
    domain: 'character',
    entityType: 'character',
    entityId: character.id,
    payload: characterEntityPayload(character),
    schemaVersion: 1,
    files,
  })
}

/** 归一化已落盘的脏 tags（字符串 → 数组），并在必要时回写修复 */
function normalizeStoredTags(char: Character): boolean {
  const raw: unknown = (char as unknown as Record<string, unknown>).tags
  if (Array.isArray(raw)) return false
  let fixed: string[] = []
  if (typeof raw === 'string') {
    fixed = (raw as string).split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean)
  }
  // 非数组非字符串 → 兜底空数组
  ;(char as unknown as Record<string, unknown>).tags = fixed
  return true
}

/** tags 脏数据回写修复：经角色域事务提交，避免绕过 journal */
function repairStoredCharacter(char: Character, filePath: string, entityId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 剥离头像字段，仅保留 rest 写入
  const { avatar: _a, cover: _c, ...rest } = char as unknown as Character & { avatar?: string; cover?: string }
  writeThroughDomain({
    domain: 'character',
    entityType: 'character',
    entityId,
    payload: characterEntityPayload(char),
    schemaVersion: 1,
    files: [{ path: filePath, content: serializeJson({ ...rest, avatar: '', cover: '' }) }],
  })
}

/** 读取角色列表（仅元数据，图片通过 tavern:// 协议按需加载） */
export async function listCharacters(): Promise<Character[]> {
  const charDir = DIRS.characters()
  if (!existsSync(charDir)) return []

  const files = readdirSync(charDir).filter((f) => f.endsWith('.json'))

  // 并行读取所有角色 JSON（不含图片 base64，避免 IPC 传输大量数据）
  const results = await Promise.all(
    files.map((file) => readJsonAsync<Character>(join(charDir, file), 'characters')),
  )

  const chars: Character[] = []
  for (let i = 0; i < results.length; i++) {
    const char = results[i]
    if (char) {
      if (normalizeStoredTags(char)) {
        // 脏数据回写修复（同步写回 tags 字段，图片字段已剥离）
        try {
          const entityId = typeof char.id === 'string' && char.id ? char.id : files[i].replace(/\.json$/, '')
          repairStoredCharacter(char, join(charDir, files[i]), entityId)
        } catch { /* 忽略回写失败 */ }
      }
      chars.push(char)
    }
  }

  // 按更新时间倒序
  return chars.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读取单个角色 */
export function getCharacter(id: string): Character | null {
  const filePath = join(DIRS.characters(), `${id}.json`)
  const char = readJson<Character>(filePath, 'characters')
  if (char) {
    if (normalizeStoredTags(char)) {
      try {
        repairStoredCharacter(char, filePath, id)
      } catch { /* 忽略回写失败 */ }
    }
    const avatar = readAvatar(id)
    if (avatar) char.avatar = avatar
    const cover = readCover(id)
    if (cover) char.cover = cover
  }
  return char
}

/**
 * S2-04 角色域删除入口（原 deleteCharacter 的实现收口）。
 * 删除产生 tombstone（而非裸 unlink）；角色 JSON 与头像/封面媒体文件在同一事务内删除。
 */
export function deleteCharacterThroughDomain(id: string): void {
  const charDir = DIRS.characters()
  const targets = [join(charDir, `${id}.json`)]
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
    targets.push(join(charDir, `${id}.${ext}`), join(charDir, `${id}_cover.${ext}`))
  }
  const files: DomainWriteFile[] = targets
    .filter((path) => existsSync(path))
    .map((path) => ({ path, content: null }))
  deleteThroughDomain({
    domain: 'character',
    entityType: 'character',
    entityId: id,
    files,
  })
}

/**
 * 重新从 URL 加载角色封面头像。
 * 媒体随角色实体事务提交（不再直接写文件绕过 journal）：更新角色记录后走
 * saveCharacterThroughDomain，头像与封面文件、角色 JSON 在同一事务内落盘。
 */
export async function reloadAvatarFromUrl(characterId: string, url: string, proxyUrl?: string): Promise<{ success: boolean; avatar: string; error?: string; code?: string }> {
  log.info('重新加载封面', { characterId, url: url.substring(0, 100) })
  const result = await downloadImageAsBase64(url, proxyUrl)
  if (!result.success || !result.data) {
    log.warn('重新加载封面失败', { characterId, code: result.code ?? 'UNKNOWN', error: result.error ?? '' })
    return { success: false, avatar: '', error: result.error, code: result.code }
  }
  const stored = readJson<Character>(join(DIRS.characters(), `${characterId}.json`), 'characters')
  if (!stored) {
    log.warn('重新加载封面失败：角色不存在', { characterId })
    return { success: false, avatar: '', error: '角色不存在' }
  }
  stored.avatar = result.data
  stored.cover = result.data // 封面同步更新
  saveCharacterThroughDomain(stored)
  log.info('重新加载封面成功', { characterId })
  return { success: true, avatar: result.data }
}

// ===================== 角色卡前端扩展适配（regex_scripts / quick_replies） =====================

/** 官方 SillyTavern regex_scripts 条目 → 项目 RegexRule（不支持的返回 null） */
function convertRegexScript(script: unknown): RegexRule | null {
  if (!script || typeof script !== 'object') return null
  const s = script as Record<string, unknown>
  const pattern = typeof s.findRegex === 'string' ? s.findRegex : ''
  if (!pattern) return null
  const replacement = typeof s.replaceString === 'string' ? s.replaceString : ''

  // promptOnly：仅作用在 prompt 阶段，项目无此阶段 → 跳过
  if (s.promptOnly === true) return null

  // placement → scope（ST 默认 user_input + ai_output = both）
  const placement: unknown[] = Array.isArray(s.placement) ? s.placement : []
  const hasInput = placement.length === 0 || placement.includes('user_input')
  const hasOutput = placement.length === 0 || placement.includes('ai_output')
  const scope: RegexRule['scope'] = hasInput && hasOutput ? 'both' : hasInput ? 'input' : 'output'

  // markdownOnly：仅 output 有 markdown 阶段（input 规则实际不会生效 → 跳过）
  let stage: RegexRule['stage'] = 'text'
  if (s.markdownOnly === true) {
    if (!hasOutput) return null
    stage = 'markdown'
  }

  return {
    id: nanoid(),
    name: typeof s.scriptName === 'string' && s.scriptName.trim() ? s.scriptName : '角色卡正则',
    pattern,
    replacement,
    // ST 默认大小写不敏感
    flags: 'gi',
    enabled: s.disabled !== true,
    scope,
    group: '角色卡导入',
    stage,
  }
}

/** 官方 SillyTavern quick_replies 条目 → 项目 QuickReply（不支持的返回 null） */
function convertCardQuickReply(qr: unknown, index: number): QuickReply | null {
  if (!qr || typeof qr !== 'object') return null
  const q = qr as Record<string, unknown>
  const label = typeof q.label === 'string' && q.label.trim() ? q.label : '快捷回复'
  const message = typeof q.message === 'string' ? q.message : (typeof q.content === 'string' ? q.content : '')
  if (!message) return null
  const isCommand = q.messageType === 'command' || q.messageType === 'slash'
  const hotkey = typeof q.hotkey === 'number' && q.hotkey >= 1 && q.hotkey <= 9 ? q.hotkey : undefined
  return {
    id: typeof q.id === 'string' && q.id ? q.id : nanoid(),
    label,
    content: message,
    action: isCommand ? 'command' : 'text',
    command: isCommand ? message : undefined,
    sendWithAI: true,
    hotkey,
    order: index,
    enabled: true,
  }
}

export interface CardExtrasResult {
  regexCount: number
  quickReplyCount: number
  /** 因不支持而跳过的项描述 */
  skipped: string[]
}

/**
 * 角色卡前端扩展落地（幂等，可重复导入）：
 * - extensions.regex_scripts → 正则规则库（group「角色卡导入」）
 * - extensions.quick_replies → 角色级快捷回复
 * 失败不阻断角色导入。
 */
export function importCardFrontendExtensions(character: Character): CardExtrasResult {
  const result: CardExtrasResult = { regexCount: 0, quickReplyCount: 0, skipped: [] }
  const exts = character.extensions
  if (!exts || typeof exts !== 'object') return result

  // ---- 正则脚本 ----
  // 跨域写入：正则规则属于 regex_rule 域，经该域事务提交（与 regex IPC 同一 journal 账本）
  if (Array.isArray(exts.regex_scripts)) {
    const rulesPath = join(DIRS.config(), 'regex', 'rules.json')
    let existing: RegexRule[] = []
    try {
      if (existsSync(rulesPath)) existing = JSON.parse(readFileSync(rulesPath, 'utf-8')) as RegexRule[]
    } catch { /* 文件损坏则从空列表开始 */ }
    const existingKeys = new Set(existing.map(r => `${r.pattern}|${r.scope}|${r.stage ?? 'text'}`))
    const added: RegexRule[] = []
    for (const script of exts.regex_scripts) {
      const rule = convertRegexScript(script)
      if (!rule) {
        const s = script as Record<string, unknown> | null
        if (s && typeof s.scriptName === 'string') result.skipped.push(`正则「${s.scriptName}」`)
        continue
      }
      const key = `${rule.pattern}|${rule.scope}|${rule.stage}`
      if (existingKeys.has(key)) continue // 已导入过（幂等）
      existingKeys.add(key)
      existing.push(rule)
      added.push(rule)
      result.regexCount++
    }
    if (added.length > 0) {
      try {
        mkdirSync(join(DIRS.config(), 'regex'), { recursive: true })
        commitThroughDomain({
          domain: 'regex_rule',
          entityType: 'regex_rule',
          puts: added.map((rule) => ({
            entityId: rule.id,
            payload: regexRulePayload(rule),
            schemaVersion: 1,
          })),
          deletes: [],
          files: [{ path: rulesPath, content: JSON.stringify(existing, null, 2) }],
        })
      } catch (e) {
        log.error('角色卡正则落地失败', { error: (e as Error).message })
        result.regexCount = 0
      }
    }
  }

  // ---- 快捷回复 ----
  // 跨域写入：quickReplies.json 是 quick_reply_set 域的单一容器实体，经该域事务提交
  if (Array.isArray(exts.quick_replies)) {
    const storePath = join(DIRS.config(), 'quickReplies.json')
    let store: QuickReplyStore = { global: [], byCharacter: {} }
    try {
      const raw = readJson<QuickReplyStore>(storePath)
      if (raw && Array.isArray(raw.global)) store = { global: raw.global, byCharacter: raw.byCharacter ?? {} }
    } catch { /* 重置 */ }
    const charList = store.byCharacter[character.id] ?? []
    const existingIds = new Set(charList.map(q => q.id))
    for (let i = 0; i < exts.quick_replies.length; i++) {
      const q = convertCardQuickReply(exts.quick_replies[i], i)
      if (!q) continue
      if (existingIds.has(q.id)) continue // 幂等
      existingIds.add(q.id)
      charList.push(q)
      result.quickReplyCount++
    }
    if (result.quickReplyCount > 0) {
      store.byCharacter[character.id] = charList
      try {
        writeThroughDomain({
          domain: 'quick_reply_set',
          entityType: 'quick_reply_set',
          entityId: 'quick-replies-root',
          payload: { global: store.global, byCharacter: store.byCharacter },
          schemaVersion: 1,
          files: [{ path: storePath, content: serializeJson(store) }],
        })
      } catch (e) {
        log.error('角色卡快捷回复落地失败', { error: (e as Error).message })
        result.quickReplyCount = 0
      }
    }
  }

  if (result.regexCount > 0 || result.quickReplyCount > 0 || result.skipped.length > 0) {
    log.info('角色卡前端扩展已导入', { name: character.name, ...result })
  }
  return result
}
