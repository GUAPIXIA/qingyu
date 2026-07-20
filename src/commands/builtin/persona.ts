import type { CommandDef } from '../registry'

/** 切换用户人设 */
export const personaCommand: CommandDef = {
  name: 'persona',
  aliases: ['user', 'u'],
  description: '切换用户人设',
  usage: '/persona [人设名]',
  args: [
    {
      name: 'name',
      required: true,
      description: '人设名称或 ID',
    },
  ],
  execute: async (args, ctx) => {
    try {
      if (!args[0]) {
        ctx.notify('请指定人设名称')
        return
      }
      const ok = await ctx.switchPersona(args[0])
      ctx.notify(ok ? '已切换人设' : '未找到该人设')
    } catch (e) {
      ctx.notify(`切换人设失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
