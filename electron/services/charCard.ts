import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, writeJson, readJson, readJsonAsync } from './storage'
import type { Character, Lorebook, LoreEntry, RegexRule, QuickReply, QuickReplyStore } from '../../shared/types'
import { createLogger } from './logger'
import { nanoid } from 'nanoid'
import { validateCharacterCard, formatValidationErrors } from './charCardValidator'
import { readPngTextChunks, writePngTextChunk, detectMimeType } from './charCardPng'
import { downloadImageAsBase64 } from './charCardDownload'

const log = createLogger('charCard')

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

  // 确定头像来源：优先级 传入参数 > JSON 中的图片字段
  let finalAvatar = avatarBase64 ?? ''
  if (!finalAvatar) {
    // 检查 JSON 中的图片字段
    const imageUrl =
      data.cover ?? data.avatar ?? data.image ?? data.image_url ??
      data.thumbnail ?? data.portrait ??
      parsedTop.cover ?? parsedTop.avatar ?? parsedTop.image ?? parsedTop.image_url ??
      null

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

  // 记录原始图片 URL（用于重新加载封面）
  const rawImageUrl = (!finalAvatar)
    ? (data.avatar ?? data.image ?? data.image_url ?? '')
    : ''
  const importImageUrl = (typeof rawImageUrl === 'string' && !rawImageUrl.startsWith('data:')
    && (rawImageUrl.startsWith('http://') || rawImageUrl.startsWith('https://')))
    ? rawImageUrl : undefined

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
    tags: data.tags ?? [],
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
  if (charBook && charBook.entries && Array.isArray(charBook.entries) && charBook.entries.length > 0) {
    try {
      const lorebookId = nanoid()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries: LoreEntry[] = charBook.entries.map((e: Record<string, any>, i: number) => ({
        id: e.uid?.toString() ?? nanoid(),
        keywords: Array.isArray(e.key) ? e.key.filter(Boolean) : (e.key ? String(e.key).split(',').map((s: string) => s.trim()).filter(Boolean) : []),
        content: e.content ?? '',
        position: e.position === 'before' || e.position === 0 ? 'before_char'
          : e.position === 'after' || e.position === 1 ? 'after_char'
          : e.position === 'depth' || e.position === 'at_depth' || e.position === 2 ? 'at_depth'
          : 'at_end',
        depth: typeof e.depth === 'number' ? Math.max(0, e.depth) : 0,
        order: e.order ?? i,
        probability: typeof e.probability === 'number' ? Math.max(0, Math.min(100, e.probability)) : 100,
        enabled: e.disable ? false : (e.enabled !== undefined ? e.enabled : true),
      }))

      const lorebook: Lorebook = {
        id: lorebookId,
        name: charBook.name ?? `${character.name}的世界书`,
        description: charBook.description ?? '',
        entries,
        enabled: true,
        scanDepth: charBook.scan_depth ?? 4,
      }

      const lorebookDir = DIRS.lorebooks()
      mkdirSync(lorebookDir, { recursive: true })
      writeJson(join(lorebookDir, `${lorebookId}.json`), lorebook)
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
  writeFileSync(savePath, newBuffer)
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
  writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf-8')
}

/** 保存角色头像（自动检测 MIME 类型） */
export function saveAvatar(characterId: string, base64Data: string): string {
  if (!base64Data) return ''
  const avatarDir = DIRS.characters()
  mkdirSync(avatarDir, { recursive: true })

  const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')
  const mime = detectMimeType(buffer)
  const ext = mime.split('/')[1] // png, jpeg, gif, webp
  const fileName = ext === 'jpeg' ? 'jpg' : ext

  const avatarPath = join(avatarDir, `${characterId}.${fileName}`)
  writeFileSync(avatarPath, buffer)
  return avatarPath
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

/** 保存封面 */
export function saveCover(characterId: string, base64Data: string): string {
  if (!base64Data) return ''
  const avatarDir = DIRS.characters()
  mkdirSync(avatarDir, { recursive: true })

  const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')
  const mime = detectMimeType(buffer)
  const ext = mime.split('/')[1]
  const fileName = ext === 'jpeg' ? 'jpg' : ext

  const coverPath = join(avatarDir, `${characterId}_cover.${fileName}`)
  writeFileSync(coverPath, buffer)
  return coverPath
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

/** 保存角色 */
export function saveCharacter(character: Character): void {
  const filePath = join(DIRS.characters(), `${character.id}.json`)
  mkdirSync(DIRS.characters(), { recursive: true })

  // 保存头像和封面到文件
  if (character.avatar.startsWith('data:')) {
    saveAvatar(character.id, character.avatar)
  }
  if (character.cover && character.cover.startsWith('data:')) {
    saveCover(character.id, character.cover)
  }

  // JSON 中不存 base64，只存空字符串（图片从文件读取）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { avatar: _avatar, cover: _cover, ...rest } = character
  writeJson(filePath, { ...rest, avatar: '', cover: '' })
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
  for (const char of results) {
    if (char) {
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
    const avatar = readAvatar(id)
    if (avatar) char.avatar = avatar
    const cover = readCover(id)
    if (cover) char.cover = cover
  }
  return char
}

/** 删除角色 */
export function deleteCharacter(id: string): void {
  const charDir = DIRS.characters()
  const jsonPath = join(charDir, `${id}.json`)
  if (existsSync(jsonPath)) unlinkSync(jsonPath)

  // 删除头像文件（所有扩展名）
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
    const avatarPath = join(charDir, `${id}.${ext}`)
    if (existsSync(avatarPath)) {
      try { unlinkSync(avatarPath) } catch { /* 忽略 */ }
    }
    // 也删除封面文件
    const coverPath = join(charDir, `${id}_cover.${ext}`)
    if (existsSync(coverPath)) {
      try { unlinkSync(coverPath) } catch { /* 忽略 */ }
    }
  }
}

/** 重新从 URL 加载角色封面头像 */
export async function reloadAvatarFromUrl(characterId: string, url: string, proxyUrl?: string): Promise<{ success: boolean; avatar: string; error?: string; code?: string }> {
  log.info('重新加载封面', { characterId, url: url.substring(0, 100) })
  const result = await downloadImageAsBase64(url, proxyUrl)
  if (!result.success || !result.data) {
    log.warn('重新加载封面失败', { characterId, code: result.code ?? 'UNKNOWN', error: result.error ?? '' })
    return { success: false, avatar: '', error: result.error, code: result.code }
  }
  saveAvatar(characterId, result.data)
  saveCover(characterId, result.data) // 封面同步更新
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
  if (Array.isArray(exts.regex_scripts)) {
    const rulesPath = join(DIRS.config(), 'regex', 'rules.json')
    let existing: RegexRule[] = []
    try {
      if (existsSync(rulesPath)) existing = JSON.parse(readFileSync(rulesPath, 'utf-8')) as RegexRule[]
    } catch { /* 文件损坏则从空列表开始 */ }
    const existingKeys = new Set(existing.map(r => `${r.pattern}|${r.scope}|${r.stage ?? 'text'}`))
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
      result.regexCount++
    }
    if (result.regexCount > 0) {
      try {
        mkdirSync(join(DIRS.config(), 'regex'), { recursive: true })
        writeFileSync(rulesPath, JSON.stringify(existing, null, 2), 'utf-8')
      } catch (e) {
        log.error('角色卡正则落地失败', { error: (e as Error).message })
        result.regexCount = 0
      }
    }
  }

  // ---- 快捷回复 ----
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
        writeJson(storePath, store)
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
