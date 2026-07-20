import type { CommandDef } from '../registry'

/** 清空当前对话 */
export const clearCommand: CommandDef = {
  name: 'clear',
  aliases: ['cls', '清空'],
  description: '清空当前对话',
  usage: '/clear',
  execute: async (_args, ctx) => {
    try {
      await ctx.clearChat()
      ctx.notify('对话已清空')
    } catch (e) {
      ctx.notify(`清空对话失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
