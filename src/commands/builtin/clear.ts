import type { CommandDef } from '../registry'
import { confirm } from '../../store/useConfirmStore'

/** 清空当前对话 */
export const clearCommand: CommandDef = {
  name: 'clear',
  aliases: ['cls', '清空'],
  description: '清空对话与长记忆',
  usage: '/clear',
  execute: async (_args, ctx) => {
    // UEX-P1-04：/clear 连带清空长记忆，执行前经全局确认通道二次确认
    const ok = await confirm({
      title: '清空对话',
      message: '将清空本会话对话与长记忆（含自动摘要与记忆事实），不可撤销。',
      confirmText: '清空',
      danger: true,
    })
    if (!ok) {
      // UEX-P1-04：取消不动任何数据，仅轻提示
      ctx.notify('已取消清空')
      return
    }
    try {
      await ctx.clearChat()
      ctx.notify('对话与长记忆已清空')
    } catch (e) {
      ctx.notify(`清空对话失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
