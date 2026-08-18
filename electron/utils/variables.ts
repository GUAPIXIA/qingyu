/**
 * 变量替换工具（electron 主进程版本）
 * 与 src/utils/variables.ts 中的 replaceVariables 保持一致。
 * 此处独立定义，避免 electron/ 跨层导入 src/ 代码。
 */

export function replaceVariables(
  text: string,
  userName: string,
  charName: string,
  originalCharName?: string,
): string {
  if (!text) return text
  const user = userName ?? ''
  const char = charName ?? ''
  const original = originalCharName ?? char
  return text
    .replace(/\{\{user\}\}/gi, user)
    .replace(/\{\{char\}\}/gi, char)
    .replace(/\{\{original\}\}/gi, original)
}
