import type { CommandDef } from '../registry'
import type { Character } from '../../../shared/types'
import type { ActiveImageGenProfile } from '../../store/useSettingsStore'
import { extractTaggedResult } from '../../components/chat/aiInputHelper'

type GenMode = 'now' | 'character' | 'face' | 'background'
type PromptStyle = 'natural' | 'tags'

function parseMode(args: string[]): { mode: GenMode; prompt: string } {
  let mode: GenMode = 'now'
  const promptParts: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      const candidate = args[i + 1] as GenMode
      if (['now', 'character', 'face', 'background'].includes(candidate)) mode = candidate
      i++
    } else {
      promptParts.push(args[i])
    }
  }
  return { mode, prompt: promptParts.join(' ').trim() }
}

/** 根据配置名称、模型和工作流内容自动判断，不增加用户配置项。 */
function resolvePromptStyle(config: ActiveImageGenProfile | null): PromptStyle {
  if (!config) return 'tags'
  const fingerprint = [config.name, config.model, config.workflowName, config.workflow]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return config.provider === 'openai' || /z[_ -]?image|flux/.test(fingerprint) ? 'natural' : 'tags'
}

function modeSubject(mode: GenMode): string {
  switch (mode) {
    case 'character':
      return 'Create a full-body character portrait focused on appearance, clothing, pose, and distinctive accessories.'
    case 'face':
      return 'Create a close-up facial portrait focused on facial features, hair, expression, skin, and portrait lighting.'
    case 'background':
      return 'Describe only the environment, time, weather, lighting, atmosphere, and composition. Do not include people.'
    default:
      return 'Depict the most visually important moment in the current scene, including subjects, action, composition, environment, and lighting.'
  }
}

function buildSystemPrompt(mode: GenMode, character: Character, style: PromptStyle): string {
  if (style === 'natural') {
    return `You generate prompts for a modern text-to-image model such as Z-Image or FLUX.

Task:
- ${modeSubject(mode)}
- 使用英文自然语言写成一个简洁、流畅的段落，约 50–120 个英文单词。
- Describe concrete visual details, spatial composition, camera framing, lighting, mood, and materials.
- Do not use booru-style quality tokens such as "best quality", "masterpiece", or "highres".
- Unless the scene explicitly requires readable writing, include no captions, subtitles, labels, logos, watermarks, typography, or visible prompt text.
- Do not explain your choices or discuss the instructions.
- Put the final prompt inside exactly one <prompt>...</prompt> pair and output nothing outside it.

Character:
Name: ${character.name}
${character.description ? `Description: ${character.description}` : ''}
${character.personality ? `Personality: ${character.personality}` : ''}`
  }

  const qualityPrefix = 'best quality, masterpiece, highres,'
  const contract = '最终提示词必须且只能放在一组 <prompt>...</prompt> 标签内，标签外不要输出任何内容'
  switch (mode) {
    case 'now':
      return `你是一个图片提示词生成器。根据对话上下文，生成一段详细的图片描述。

要求：
1. 描述当前场景中最重要的视觉元素
2. 包括角色外观、服装、姿态、表情、场景、光线
3. 用英文逗号分隔的标签格式输出（如: 1girl, red dress, sitting, bedroom, sunlight）
4. 不要输出任何解释
5. 以质量标签开头: ${qualityPrefix}
6. ${contract}

角色信息:
名字: ${character.name}
${character.description ? `描述: ${character.description}` : ''}`
    case 'character':
      return `你是一个图片提示词生成器。根据角色描述，生成角色的全身外观描述。

要求：
1. 详细描述角色的发型、发色、眼睛、服装、体型、配饰
2. 用英文逗号分隔的标签格式输出
3. 不要输出任何解释
4. 以质量标签开头: ${qualityPrefix}
5. ${contract}

角色信息:
名字: ${character.name}
${character.description ? `描述: ${character.description}` : ''}
${character.personality ? `性格: ${character.personality}` : ''}`
    case 'face':
      return `你是一个图片提示词生成器。根据角色描述，生成角色的面部特写描述。

要求：
1. 详细描述角色的五官、发型、表情、肤色
2. 用英文逗号分隔的标签格式输出
3. 不要输出任何解释
4. 以质量标签开头: ${qualityPrefix}, close-up, portrait,
5. ${contract}

角色信息:
名字: ${character.name}
${character.description ? `描述: ${character.description}` : ''}`
    case 'background':
      return `你是一个图片提示词生成器。根据对话上下文，生成当前场景的背景描述。

要求：
1. 描述场景的环境、时间、天气、光线、氛围
2. 不要描述人物，只描述背景环境
3. 用英文逗号分隔的标签格式输出
4. 不要输出任何解释
5. 以质量标签开头: ${qualityPrefix}, scenery, no humans,
6. ${contract}

角色信息:
名字: ${character.name}`
  }
}

function isUsableImagePrompt(raw: string): boolean {
  const value = raw.trim()
  return value.length >= 8
    && !/^(?:we need|need final|let['’]s|should we|the user|i need|analysis\b|okay,?\s+(?:we|the task))/i.test(value)
}

function getSizeForMode(mode: GenMode): string | undefined {
  if (mode === 'face' || mode === 'character') return '512x768'
  if (mode === 'background') return '768x512'
  return undefined
}

export const imagineCommand: CommandDef = {
  name: 'imagine',
  aliases: ['img', '生图', '画图'],
  description: '使用 AI 生成图片（无参数时自动结合上下文）',
  usage: '/imagine [描述] 或 /imagine --mode <now|character|face|background>',
  args: [{ name: 'prompt', description: '图片描述（可选，不填则自动生成）' }],
  execute: async (args, ctx) => {
    const { mode, prompt } = parseMode(args)
    const jobId = ctx.beginImageGeneration(prompt ? 'generating' : 'prompting')
    if (!jobId) {
      ctx.notify('当前会话已有生图任务正在进行')
      return
    }

    try {
      let finalPrompt = prompt
      if (!finalPrompt) {
        const style = resolvePromptStyle(ctx.getActiveImageGen())
        const systemPrompt = buildSystemPrompt(mode, ctx.character, style)
        const recentMessages = ctx.getRecentMessages(5)
        const userContent = recentMessages.length > 0
          ? recentMessages.map(m => `${m.name}: ${m.content}`).join('\n')
          : '（暂无对话历史）'

        for (let attempt = 0; attempt < 2 && !finalPrompt; attempt++) {
          const attemptPrompt = attempt === 0
            ? systemPrompt
            : `${systemPrompt}\n\nThe previous response was invalid. Return only one <prompt>...</prompt> result with no analysis or commentary.`
          const raw = await ctx.callAiHelper(attemptPrompt, userContent, {
            temperature: attempt === 0 ? 0.5 : 0.2,
            maxTokens: style === 'natural' ? 800 : 500,
            reasoningMode: 'disabled',
          })
          const candidate = extractTaggedResult(raw, 'prompt')
          if (isUsableImagePrompt(candidate)) finalPrompt = candidate
        }

        if (!finalPrompt) {
          ctx.notify('提示词生成失败，请重试')
          return
        }
        ctx.notify(`提示词: ${finalPrompt.slice(0, 80)}${finalPrompt.length > 80 ? '...' : ''} 正在生成图片`)
      }

      ctx.updateImageGeneration(jobId, 'generating')
      const sizeOverride = getSizeForMode(mode)
      const result = await window.api.imageGen.generate(finalPrompt, sizeOverride ? { size: sizeOverride } : undefined)
      if (result.success && result.images?.length) {
        await ctx.addImageMessage(result.images, finalPrompt)
      } else {
        ctx.notify(`生图失败: ${result.error || '未知错误'}`)
      }
    } catch (error) {
      ctx.notify(`生图失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      ctx.finishImageGeneration(jobId)
    }
  },
}
