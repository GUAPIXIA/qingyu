import type { CommandDef } from '../registry'

/** 要求 AI 在回复前先输出计划大纲 */
export const planCommand: CommandDef = {
  name: 'plan',
  aliases: ['p'],
  description: '要求 AI 回复前在 thought 标签中输出对话计划',
  usage: '/plan [提示文本]',
  args: [
    {
      name: 'text',
      required: false,
      description: '可选提示文本',
    },
  ],
  execute: async (args, ctx) => {
    const userText = args.join(' ') || '请继续'
    const prompt = `${userText}\n\n（请在 <thought> 标签中先输出你的对话计划和大纲，然后再正式回复）`
    try {
      await ctx.sendMessage(prompt, [])
    } catch (e) {
      ctx.notify(`发送失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
