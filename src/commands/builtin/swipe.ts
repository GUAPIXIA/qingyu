import type { CommandDef } from '../registry'

/** 切换最后一条 AI 回复的候选 */
export const swipeCommand: CommandDef = {
  name: 'swipe',
  aliases: ['s'],
  description: '切换最后一条 AI 回复的候选',
  usage: '/swipe [left|right]',
  args: [
    {
      name: 'direction',
      required: false,
      description: '方向',
      complete: () => ['left', 'right'],
    },
  ],
  execute: async (args, ctx) => {
    try {
      const dir = args[0]
      if (dir === 'left' || dir === 'l') {
        await ctx.swipeMessage(-1)
      } else {
        // right、r 或无参数默认向右切换
        await ctx.swipeMessage(1)
      }
    } catch (e) {
      ctx.notify(`切换候选失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
