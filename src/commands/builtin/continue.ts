import type { CommandDef } from '../registry'

/** AI 续写对话 */
export const continueCommand: CommandDef = {
  name: 'continue',
  aliases: ['cont', 'c'],
  description: 'AI 续写对话',
  usage: '/continue [提示文本]',
  args: [
    {
      name: 'text',
      required: false,
      description: '续写提示',
    },
  ],
  execute: async (args, ctx) => {
    try {
      await ctx.sendMessage(args.join(' ') || '请继续', [])
    } catch (e) {
      ctx.notify(`续写失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
