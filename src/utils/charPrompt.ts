/**
 * 角色画像提示词构建器：根据角色设定生成 AI 封面提示词
 *
 * 返回 null 表示缺少最小信息（name 与 description 均为空），UI 应引导用户回 Step 1 补充。
 */

const HAIR_COLORS: Array<[RegExp, string]> = [
  [/银发|银色|白发|白毛|银白|银丝/, 'silver hair, white hair'],
  [/金发|金色/, 'blonde hair'],
  [/黑发|乌黑|青丝|墨发|黑色/, 'black hair'],
  [/红发|赤发|火红/, 'red hair'],
  [/蓝发|蓝色/, 'blue hair'],
  [/紫发|紫色/, 'purple hair'],
  [/粉发|粉色/, 'pink hair'],
  [/绿发|绿色/, 'green hair'],
  [/棕发|褐发|茶发|棕色|褐色/, 'brown hair'],
  [/灰发|银灰|灰色/, 'gray hair'],
  [/青发|青色/, 'teal hair'],
]

const EYE_COLORS: Array<[RegExp, string]> = [
  [/异色瞳|双色瞳|鸳鸯瞳/, 'heterochromia'],
  [/蓝眼|蓝色眼睛|碧眼|湛蓝/, 'blue eyes'],
  [/红眼|红色眼睛|赤瞳|猩红/, 'red eyes'],
  [/绿眼|翠绿/, 'green eyes'],
  [/金眼|金色眼睛/, 'golden eyes'],
  [/紫眼|紫色眼睛/, 'purple eyes'],
  [/银瞳|银色眼睛/, 'silver eyes'],
  [/黑瞳|黑色眼睛|墨色/, 'dark eyes'],
]

const SCENES: Array<[RegExp, string]> = [
  [/赛博朋克|霓虹|义体|黑客/, 'cyberpunk, neon lights, futuristic city'],
  [/都市|城市|街道|天台|高楼/, 'cityscape, urban'],
  [/森林|丛林|树林|密林/, 'forest, nature'],
  [/太空|宇宙|星球|星舰|星际/, 'space, stars, nebula'],
  [/海边|沙滩|海洋|大海|海岸/, 'beach, ocean'],
  [/古风|古代|武侠|仙侠|汉服|宫廷/, 'ancient chinese, hanfu, traditional art'],
  [/学校|教室|校园|学园/, 'school, classroom'],
  [/城堡|宫殿|中世纪|骑士/, 'castle, medieval'],
  [/酒吧|夜店|俱乐部/, 'bar, nightclub'],
  [/雪|冬天|雪山|冰雪/, 'snow, winter'],
  [/花园|花海|花田|花房/, 'flower field, garden'],
  [/和风|神社|日式/, 'japanese style, shrine'],
]

/** 从描述推断性别标签：女 → 1girl，男 → 1boy，无法判断返回空串 */
export function inferGenderTag(description: string): string {
  if (!description) return ''
  if (/女|girl|woman|female|她/.test(description)) return '1girl'
  if (/男|boy|man|male|他/.test(description)) return '1boy'
  return ''
}

/** 提取发色/瞳色等视觉关键词（各取第一个命中） */
export function extractVisualKeywords(description: string): string {
  const found: string[] = []
  for (const [re, tag] of HAIR_COLORS) {
    if (re.test(description)) {
      found.push(tag)
      break
    }
  }
  for (const [re, tag] of EYE_COLORS) {
    if (re.test(description)) {
      found.push(tag)
      break
    }
  }
  return found.join(', ')
}

/** 从场景设定提取背景关键词 */
export function extractSceneKeywords(scenario: string): string {
  if (!scenario) return ''
  for (const [re, tag] of SCENES) {
    if (re.test(scenario)) return tag
  }
  return ''
}

/**
 * 构建封面提示词（SD WebUI 标签式）。
 * 末尾固定追加主体居中约束——DALL-E 1024² 裁 3:4 会损失左右各约 12.5% 内容，
 * 主体不居中会导致头像/封面裁掉人脸。
 */
export function buildCoverPrompt(draft: {
  name: string
  description: string
  scenario: string
  tags: string[]
}): string | null {
  if (!draft.name && !draft.description) return null
  const parts: string[] = [
    'best quality, masterpiece, highres,',
    inferGenderTag(draft.description),
    extractVisualKeywords(draft.description),
    draft.description.slice(0, 100),
    draft.scenario ? `background: ${extractSceneKeywords(draft.scenario)}` : '',
    'portrait, upper body, subject centered, looking at viewer',
    ...(draft.tags || []),
  ]
  return parts.filter(Boolean).join(', ')
}
