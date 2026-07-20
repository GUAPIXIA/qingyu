import type { CommandDef } from '../registry'

/** 切换世界书激活状态 */
export const lorebookCommand: CommandDef = {
  name: 'lorebook',
  aliases: ['lb', 'l'],
  description: '切换世界书激活状态',
  usage: '/lorebook [世界书名]',
  args: [
    {
      name: 'name',
      required: true,
      description: '世界书名称或 ID',
    },
  ],
  execute: async (args, ctx) => {
    try {
      if (!args[0]) {
        ctx.notify('请指定世界书名称')
        return
      }
      const ok = await ctx.toggleLorebook(args[0])
      ctx.notify(ok ? '已切换世界书状态' : '未找到该世界书')
    } catch (e) {
      ctx.notify(`切换世界书失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
