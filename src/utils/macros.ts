/**
 * 宏系统（路线图 3.4）
 *
 * 宏注册表 + 内置宏 + expandMacros 展开器。
 * 快捷回复 / 预设 / 世界书 / 用户人设均可调用 expandMacros 获得动态内容。
 *
 * 语法：{{name}} 或 {{name:参数}}
 * 示例：{{random:早安|晚安|你好}}、{{time}}、{{lastUserMessage}}
 */

export interface MacroContext {
  userName: string
  charName: string
  originalCharName?: string
  /** 群聊名（群聊场景） */
  groupName?: string
  /** 最后一条消息内容 */
  lastMessage?: string
  /** 最后一条用户消息内容 */
  lastUserMessage?: string
}

export type MacroFn = (args: string[], ctx: MacroContext) => string

export interface MacroInfo {
  name: string
  description: string
  example: string
}

/** 宏注册表 */
const macroRegistry = new Map<string, MacroFn>()
/** 宏元数据（补全/提示用） */
const macroMeta = new Map<string, MacroInfo>()

/** 注册宏（name 不含大括号，小写） */
export function registerMacro(name: string, fn: MacroFn, info?: MacroInfo): void {
  macroRegistry.set(name.toLowerCase(), fn)
  if (info) macroMeta.set(name.toLowerCase(), info)
}

/** 注销宏 */
export function unregisterMacro(name: string): void {
  macroRegistry.delete(name.toLowerCase())
  macroMeta.delete(name.toLowerCase())
}

/** 列出全部宏（注册序） */
export function listMacros(): MacroInfo[] {
  return [...macroMeta.values()]
}

/** 判断文本是否包含宏语法 */
export function hasMacro(text: string): boolean {
  return /\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*/.test(text)
}

/** 拆分 {{name:a|b|c}} 的参数（| 分隔，转义 \| 支持字面竖线） */
function splitArgs(raw: string | undefined): string[] {
  if (!raw) return []
  const result: string[] = []
  let cur = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && raw[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      result.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  result.push(cur.trim())
  return result
}

// ===================== 内置宏 =====================

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

registerMacro('time', () => {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}, { name: 'time', description: '当前时间（HH:mm）', example: '{{time}} → 14:30' })

registerMacro('date', () => {
  const d = new Date()
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}, { name: 'date', description: '当前日期（YYYY/MM/DD）', example: '{{date}} → 2026/07/31' })

registerMacro('datetime', () => {
  const d = new Date()
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}, { name: 'datetime', description: '当前日期时间', example: '{{datetime}} → 2026/07/31 14:30' })

registerMacro('random', (args) => {
  if (args.length === 0) return ''
  return args[Math.floor(Math.random() * args.length)]
}, { name: 'random', description: '随机取一个选项（| 分隔）', example: '{{random:早安|晚安}}' })

registerMacro('newline', () => '\n', { name: 'newline', description: '换行', example: '{{newline}}' })

registerMacro('group', (_a, ctx) => ctx.groupName || '', {
  name: 'group', description: '群聊名称（单聊为空）', example: '{{group}}',
})

registerMacro('lastMessage', (_a, ctx) => ctx.lastMessage || '', {
  name: 'lastMessage', description: '最后一条消息内容', example: '{{lastMessage}}',
})

registerMacro('lastUserMessage', (_a, ctx) => ctx.lastUserMessage || '', {
  name: 'lastUserMessage', description: '最后一条用户消息内容', example: '{{lastUserMessage}}',
})

registerMacro('char', (_a, ctx) => ctx.charName, {
  name: 'char', description: '角色名', example: '{{char}}',
})

registerMacro('user', (_a, ctx) => ctx.userName, {
  name: 'user', description: '用户名', example: '{{user}}',
})

registerMacro('original', (_a, ctx) => ctx.originalCharName || ctx.charName, {
  name: 'original', description: '角色原名', example: '{{original}}',
})

registerMacro('id', () => Math.random().toString(36).slice(2, 8), {
  name: 'id', description: '随机短 ID', example: '{{id}} → a1b2c3',
})

// ===================== 展开器 =====================

/**
 * 展开文本中的所有宏。
 * 未注册的宏（如 {{unknown}}）原样保留，避免误删用户内容。
 * 参数解析：{{name:arg1|arg2}}；用 \| 可输出字面竖线。
 */
export function expandMacros(text: string, ctx: MacroContext): string {
  if (!text) return text
  if (!hasMacro(text)) return text
  return text.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\s*\}\}/g,
    (match, name: string, rawArgs?: string) => {
      const fn = macroRegistry.get(name.toLowerCase())
      if (!fn) return match
      try {
        return fn(splitArgs(rawArgs), ctx)
      } catch {
        return match
      }
    },
  )
}

/** 从消息数组构造宏上下文（便捷工厂，供 store 使用） */
export function buildMacroContext(
  messages: { role: string; content: string }[] | undefined,
  opts: { userName: string; charName: string; originalCharName?: string; groupName?: string },
): MacroContext {
  const list = messages ?? []
  const last = [...list].reverse().find((m) => m.content?.trim())
  const lastUser = [...list].reverse().find((m) => m.role === 'user' && m.content?.trim())
  return {
    userName: opts.userName,
    charName: opts.charName,
    originalCharName: opts.originalCharName,
    groupName: opts.groupName,
    lastMessage: last?.content || '',
    lastUserMessage: lastUser?.content || '',
  }
}
