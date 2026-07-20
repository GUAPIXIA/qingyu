import type { CommandDef } from '../registry'

/** 重新生成最后一条 AI 回复 */
export const regenerateCommand: CommandDef = {
  name: 'regenerate',
  aliases: ['regen', 'r'],
  description: '重新生成最后一条 AI 回复',
  usage: '/regenerate',
  execute: async (_args, ctx) => {
    try {
      await ctx.regenerateLastMessage()
    } catch (e) {
      ctx.notify(`重新生成失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
