import type { CommandDef } from '../registry'

/** 切换预设 */
export const presetCommand: CommandDef = {
  name: 'preset',
  aliases: ['ps'],
  description: '切换预设',
  usage: '/preset [预设名]',
  args: [
    {
      name: 'name',
      required: true,
      description: '预设名称或 ID',
    },
  ],
  execute: async (args, ctx) => {
    try {
      if (!args[0]) {
        ctx.notify('请指定预设名称')
        return
      }
      const ok = await ctx.switchPreset(args[0])
      ctx.notify(ok ? '已切换预设' : '未找到该预设')
    } catch (e) {
      ctx.notify(`切换预设失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
