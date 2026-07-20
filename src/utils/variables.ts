/**
 * 变量替换工具
 * 将 {{user}} 替换为用户名，{{char}} 替换为角色名
 */
export function replaceVariables(text: string, userName: string, charName: string): string {
  if (!text) return text
  return text
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, charName)
}
