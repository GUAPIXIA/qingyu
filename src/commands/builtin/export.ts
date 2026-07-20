import type { CommandDef } from '../registry'

/** 导出当前对话 */
export const exportCommand: CommandDef = {
  name: 'export',
  aliases: ['exp'],
  description: '导出当前对话',
  usage: '/export [md|json]',
  args: [
    {
      name: 'format',
      required: false,
      description: '导出格式',
      complete: () => ['md', 'json'],
    },
  ],
  execute: async (args, ctx) => {
    try {
      const format = (args[0] as 'md' | 'json') || 'md'
      await ctx.exportChat(format)
      ctx.notify(`对话已导出为 ${format}`)
    } catch (e) {
      ctx.notify(`导出失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
