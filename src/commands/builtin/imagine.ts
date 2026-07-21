import type { CommandDef } from '../registry'
import type { Character } from '../../../shared/types'

/** 生图模式 */
type GenMode = 'now' | 'character' | 'face' | 'background'

/** 解析 --mode 参数 */
function parseMode(args: string[]): { mode: GenMode; prompt: string } {
  let mode: GenMode = 'now'
  const promptParts: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      const m = args[i + 1] as GenMode
      if (['now', 'character', 'face', 'background'].includes(m)) {
        mode = m
      }
      i++
    } else {
      promptParts.push(args[i])
    }
  }

  return { mode, prompt: promptParts.join(' ').trim() }
}

/** 根据模式构建系统提示词 */
function buildSystemPrompt(mode: GenMode, character: Character): string {
  const qualityPrefix = 'best quality, masterpiece, highres,'

  switch (mode) {
    case 'now':
      return `你是一个图片提示词生成器。根据对话上下文，生成一段详细的图片描述。

要求：
1. 描述当前场景中最重要的视觉元素
2. 包括角色外观、服装、姿态、表情、场景、光线
3. 用英文逗号分隔的标签格式输出（如: 1girl, red dress, sitting, bedroom, sunlight）
4. 不要输出任何解释，只输出提示词标签
5. 以质量标签开头: ${qualityPrefix}

角色信息:
名字: ${character.name}
${character.description ? `描述: ${character.description}` : ''}`

    case 'character':
      return `你是一个图片提示词生成器。根据角色描述，生成角色的全身外观描述。

要求：
1. 详细描述角色的发型、发色、眼睛、服装、体型、配饰
2. 用英文逗号分隔的标签格式输出
3. 不要输出任何解释，只输出提示词标签
4. 以质量标签开头: ${qualityPrefix}

角色信息:
名字: ${character.name}
${character.description ? `描述: ${character.description}` : ''}
${character.personality ? `性格: ${character.personality}` : ''}`

    case 'face':
      return `你是一个图片提示词生成器。根据角色描述，生成角色的面部特写描述。

要求：
1. 详细描述角色的五官、发型、表情、肤色
2. 用英文逗号分隔的标签格式输出
3. 不要输出任何解释，只输出提示词标签
4. 以质量标签开头: ${qualityPrefix}, close-up, portrait,

角色信息:
名字: ${character.name}
${character.description ? `描述: ${character.description}` : ''}`

    case 'background':
      return `你是一个图片提示词生成器。根据对话上下文，生成当前场景的背景描述。

要求：
1. 描述场景的环境、时间、天气、光线、氛围
2. 不要描述人物，只描述背景环境
3. 用英文逗号分隔的标签格式输出
4. 不要输出任何解释，只输出提示词标签
5. 以质量标签开头: ${qualityPrefix}, scenery, no humans,

角色信息:
名字: ${character.name}`
  }
}

/** 根据模式返回建议尺寸 */
function getSizeForMode(mode: GenMode): string | undefined {
  switch (mode) {
    case 'face':
    case 'character':
      return '512x768' // 竖图
    case 'background':
      return '768x512' // 横图
    default:
      return undefined // 默认尺寸
  }
}

/** AI 生图命令 */
export const imagineCommand: CommandDef = {
  name: 'imagine',
  aliases: ['img', '生图', '画图'],
  description: '使用 AI 生成图片（无参数时自动结合上下文）',
  usage: '/imagine [描述] 或 /imagine --mode <now|character|face|background>',
  args: [{ name: 'prompt', description: '图片描述（可选，不填则自动生成）' }],
  execute: async (args, ctx) => {
    const { mode, prompt } = parseMode(args)

    let finalPrompt = prompt

    // 无提示词时，结合上下文智能生成
    if (!finalPrompt) {
      ctx.notify('正在分析上下文生成提示词...')

      try {
        const systemPrompt = buildSystemPrompt(mode, ctx.character)
        const recentMessages = ctx.getRecentMessages(5)
        const userContent = recentMessages.length > 0
          ? recentMessages.map(m => `${m.name}: ${m.content}`).join('\n')
          : '（暂无对话历史）'

        finalPrompt = await ctx.callAiHelper(systemPrompt, userContent, {
          temperature: 0.7,
          maxTokens: 200,
        })

        if (!finalPrompt || !finalPrompt.trim()) {
          ctx.notify('提示词生成失败，请重试')
          return
        }

        ctx.notify(`提示词: ${finalPrompt.substring(0, 60)}... 正在生成图片`)
      } catch (e) {
        ctx.notify(`提示词生成失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
    } else {
      ctx.notify('正在生成图片...')
    }

    // 调用生图 API
    try {
      const sizeOverride = getSizeForMode(mode)
      const result = await window.api.imageGen.generate(finalPrompt, sizeOverride ? { size: sizeOverride } : undefined)

      if (result.success && result.images?.length) {
        await ctx.addImageMessage(result.images, finalPrompt)
      } else {
        ctx.notify(`生图失败: ${result.error || '未知错误'}`)
      }
    } catch (e) {
      ctx.notify(`生图失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
