import type { CommandDef } from '../registry'
import { findCommand, listCommands } from '../registry'

/** 显示所有命令或某个命令的帮助 */
export const helpCommand: CommandDef = {
  name: 'help',
  aliases: ['?', 'h'],
  description: '显示所有命令或某个命令的帮助',
  usage: '/help [命令名]',
  args: [
    {
      name: 'command',
      required: false,
      description: '要查看的命令',
      complete: () => listCommands().map(c => c.name),
    },
  ],
  execute: async (args, ctx) => {
    try {
      if (args.length === 0) {
        // 显示所有命令列表
        const cmds = listCommands()
        const lines = cmds.map(c => `/${c.name} - ${c.description}`)
        ctx.notify(`可用命令:\n${lines.join('\n')}`)
        return
      }
      // 显示指定命令的详细帮助
      const cmd = findCommand(args[0])
      if (!cmd) {
        ctx.notify(`未找到命令: ${args[0]}`)
        return
      }
      const argInfo =
        cmd.args && cmd.args.length > 0
          ? `\n参数:\n${cmd.args
              .map(
                a =>
                  `  ${a.name}${a.required ? ' (必需)' : ' (可选)'}${a.description ? ' - ' + a.description : ''}`
              )
              .join('\n')}`
          : ''
      const aliasInfo = cmd.aliases && cmd.aliases.length > 0 ? `\n别名: ${cmd.aliases.join(', ')}` : ''
      ctx.notify(`${cmd.name}${aliasInfo}\n用法: ${cmd.usage}\n描述: ${cmd.description}${argInfo}`)
    } catch (e) {
      ctx.notify(`显示帮助失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
