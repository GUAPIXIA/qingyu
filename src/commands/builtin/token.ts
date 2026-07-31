import type { CommandDef } from '../registry'

/** 显示当前字符用量 */
export const tokenCommand: CommandDef = {
  name: 'token',
  aliases: ['tokens', 't', 'chars', 'c'],
  description: '显示当前对话字符用量',
  usage: '/token',
  execute: async (_args, ctx) => {
    try {
      const { total } = ctx.getTokenUsage()
      ctx.notify(`当前对话字符数: ${total}`)
    } catch (e) {
      ctx.notify(`获取字符用量失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
