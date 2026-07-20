import type { CommandDef } from '../registry'

/** 切换对话角色 */
export const characterCommand: CommandDef = {
  name: 'character',
  aliases: ['char', 'ch'],
  description: '切换对话角色',
  usage: '/character [角色名]',
  args: [
    {
      name: 'name',
      required: true,
      description: '角色名称或 ID',
    },
  ],
  execute: async (args, ctx) => {
    try {
      if (!args[0]) {
        ctx.notify('请指定角色名称')
        return
      }
      const ok = await ctx.switchCharacter(args[0])
      ctx.notify(ok ? '已切换角色' : '未找到该角色')
    } catch (e) {
      ctx.notify(`切换角色失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
