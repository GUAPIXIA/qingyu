import type { CommandDef } from '../registry'

/** 触发长记忆总结 */
export const summaryCommand: CommandDef = {
  name: 'summary',
  aliases: ['summarize'],
  description: '触发长记忆总结',
  usage: '/summary',
  execute: async (_args, ctx) => {
    try {
      await ctx.triggerMemorySummary()
      ctx.notify('长记忆总结已完成')
    } catch (e) {
      ctx.notify(`长记忆总结失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
