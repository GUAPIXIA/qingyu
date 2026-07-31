import type { CommandDef } from '../registry'

/** AI 续写对话 */
export const continueCommand: CommandDef = {
  name: 'continue',
  aliases: ['cont', 'c'],
  description: 'AI 续写对话（无参数时直接续写最后一条 AI 回复）',
  usage: '/continue [提示文本]',
  args: [
    {
      name: 'text',
      required: false,
      description: '续写提示（提供时作为用户消息发送）',
    },
  ],
  execute: async (args, ctx) => {
    try {
      const text = args.join(' ').trim()
      if (text) {
        // 带提示文本：作为普通用户消息发送
        await ctx.sendMessage(text, [])
      } else {
        // 无参数：与"继续续写"按钮同路径，直接续写最后一条 AI 回复
        await ctx.continueLastMessage()
      }
    } catch (e) {
      ctx.notify(`续写失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
