import type { Character } from '../../shared/types'

/**
 * 变量替换工具
 * 将 {{user}} 替换为用户名，{{char}} 替换为角色名，{{original}} 替换为角色原名
 */
export function replaceVariables(
  text: string,
  userName: string,
  charName: string,
  originalCharName?: string,
): string {
  if (!text) return text
  // BUG-26 修复：调用方可能传入 undefined（如未配置用户名），
  // 空值回退为空串，避免输出字面量 "undefined"
  const user = userName ?? ''
  const char = charName ?? ''
  const original = originalCharName ?? char
  return text
    .replace(/\{\{user\}\}/gi, user)
    .replace(/\{\{char\}\}/gi, char)
    .replace(/\{\{original\}\}/gi, original)
}

/**
 * 获取角色显示名称
 * 有翻译时显示「中文名 (English Name)」，无翻译时只显示原名
 * 用于聊天界面等需要双语显示的场景
 */
export function getDisplayName(character: Character | null | undefined): string {
  if (!character) return ''
  const original = character.name
  const translated = character.translatedContent?.name
  if (translated && translated !== original) {
    return `${translated} (${original})`
  }
  return original
}
