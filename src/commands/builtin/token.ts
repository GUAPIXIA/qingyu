import type { CommandDef } from '../registry'

/** 显示当前 Token 用量 */
export const tokenCommand: CommandDef = {
  name: 'token',
  aliases: ['tokens', 't'],
  description: '显示当前 Token 用量',
  usage: '/token',
  execute: async (_args, ctx) => {
    try {
      const { total, max } = ctx.getTokenUsage()
      const percent = max > 0 ? Math.round((total / max) * 100) : 0
      ctx.notify(`Token 用量: ${total} / ${max} (${percent}%)`)
    } catch (e) {
      ctx.notify(`获取 Token 用量失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
