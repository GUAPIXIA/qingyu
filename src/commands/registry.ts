/**
 * 斜杠命令注册中心
 */
import type { Character } from '../../shared/types'

/** 命令执行上下文：暴露 store 方法和当前角色给命令 */
export interface CommandContext {
  character: Character
  /** 发送普通消息 */
  sendMessage: (content: string, images: string[]) => Promise<void>
  /** 清空当前对话 */
  clearChat: () => Promise<void>
  /** 重新生成最后一条 AI 消息 */
  regenerateLastMessage: () => Promise<void>
  /** 触发长记忆总结 */
  triggerMemorySummary: () => Promise<void>
  /** 导出当前对话 */
  exportChat: (format: 'md' | 'json') => Promise<void>
  /** 切换候选回复（direction: -1 上一个, 1 下一个） */
  swipeMessage: (direction: number) => Promise<void>
  /** 显示提示信息（在输入框上方短暂显示） */
  notify: (msg: string) => void
  /** 切换角色 */
  switchCharacter: (nameOrId: string) => Promise<boolean>
  /** 切换预设 */
  switchPreset: (nameOrId: string) => Promise<boolean>
  /** 切换用户人设 */
  switchPersona: (nameOrId: string) => Promise<boolean>
  /** 切换世界书 */
  toggleLorebook: (nameOrId: string) => Promise<boolean>
  /** 获取当前 Token 用量 */
  getTokenUsage: () => { total: number; max: number }
}

export interface CommandArgDef {
  name: string
  required?: boolean
  description?: string
  /** 补全选项 */
  complete?: (input: string, ctx: CommandContext) => string[] | Promise<string[]>
}

export interface CommandDef {
  /** 命令名（不含 /） */
  name: string
  /** 别名 */
  aliases?: string[]
  /** 简短描述 */
  description: string
  /** 用法示例 */
  usage: string
  /** 参数定义 */
  args?: CommandArgDef[]
  /** 执行函数 */
  execute: (args: string[], ctx: CommandContext) => Promise<void>
}

const registry = new Map<string, CommandDef>()

/** 注册命令 */
export function registerCommand(cmd: CommandDef): void {
  registry.set(cmd.name.toLowerCase(), cmd)
  cmd.aliases?.forEach(alias => registry.set(alias.toLowerCase(), cmd))
}

/** 查找命令 */
export function findCommand(name: string): CommandDef | undefined {
  return registry.get(name.toLowerCase())
}

/** 列出所有命令（去重，不含别名） */
export function listCommands(): CommandDef[] {
  const seen = new Set<string>()
  const result: CommandDef[] = []
  for (const cmd of registry.values()) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name)
      result.push(cmd)
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** 重置注册表（测试用） */
export function resetCommands(): void {
  registry.clear()
}
