/**
 * 用户人设注入真机效果评测（Persona Injection Effect Bench）
 *
 * 要回答的问题：注入文本本身写对了（`src/store/__tests__/personaInjection.test.ts` 等已覆盖），
 * 但**真实模型是否照着注入的身份与性格回应**？这部分此前没有任何覆盖。
 *
 * 本基准走生产组装链路，不重写组装逻辑：
 *   mainContextProvider.fetchBuildData（按**会话 personaId** 解析身份，不读 settings 旧镜像）
 *     → contextService.build → shared/chat-core/contextBuilder.buildContext
 *     → 真实 provider adapter（仅省略 IPC 传输层与流式 UI 回传）
 *
 * 四组对照（同一角色卡 / 同一条用户消息 / 同一温度与采样数）：
 *   off       关闭注入：仅用户名经叙事提示出现 → 用于分离"仅名字"与"身份+性格"两层效果
 *   system    默认注入：position=system，含描述与性格（生产默认）
 *   separate  独立 system 消息注入：position=separate
 *   counter   反事实身份：system 位置注入另一套中性身份 → 检验模型读的是**内容**而非"有没有区块"
 *
 * 隔离：settings/credentials/Local State 复制到临时 userData，绝不写真实配置；
 *       结束时校验源文件哈希未变，并删除隔离副本中的凭据文件。
 *
 * 环境变量：
 *   PERSONA_BENCH_SAMPLES      每组采样次数（默认 3）
 *   PERSONA_BENCH_TEMPERATURE  采样温度（默认 0.8，与内置默认预设一致）
 *   PERSONA_BENCH_JUDGE        'off' 关闭 LLM 评分（默认开启）
 *   PERSONA_BENCH_SOURCE       真实配置目录（默认 %APPDATA%/qingyu）
 *   PERSONA_BENCH_JUDGE_MODEL  评分用模型（默认与主对话同模型）
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 隔离运行时与判分 JSON 为异构结构 */
import { app } from 'electron'
import { join, relative, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { initLogger, LogLevel } from '../electron/services/logger'
import { resolveGenerationTaskBudget } from '../shared/generationTaskBudget'
import type { ChatParams, Persona, PersonaInjectionConfig, Settings } from '../shared/types'

const output = resolve('output/persona-injection-model')
mkdirSync(output, { recursive: true })
const isolated = mkdtempSync(join(output, 'user-data-'))
mkdirSync(join(isolated, 'data', 'config'), { recursive: true })

/** 真实配置目录：只读取，绝不写入（结束时用哈希自证）。 */
const source = process.env.PERSONA_BENCH_SOURCE || join(app.getPath('appData'), 'qingyu')
const copied = ['data/config/settings.json', 'data/config/credentials.json', 'Local State']
const sourceHashes = new Map(
  copied
    .filter(file => existsSync(join(source, file)))
    .map(file => [file, createHash('sha256').update(readFileSync(join(source, file))).digest('hex')]),
)
for (const file of copied) if (existsSync(join(source, file))) copyFileSync(join(source, file), join(isolated, file))
app.setPath('userData', isolated)

const samples = Math.max(1, Math.min(9, Number(process.env.PERSONA_BENCH_SAMPLES || 3)))
const temperature = Number(process.env.PERSONA_BENCH_TEMPERATURE || 0.8)
const judgeEnabled = process.env.PERSONA_BENCH_JUDGE !== 'off'
/** dry=1：只组装上下文并校验断言，不发真实请求（零 token 成本，用于验证夹具与打包）。 */
const dryRun = process.env.PERSONA_BENCH_DRY === '1'
/**
 * 控制变量：推理档位固定 off。
 * deepseek-v4.1-flash 是推理模型，实测 400 token 预算会被推理吃光并返回空正文
 * （即仓库已记录的 REASONING_BUDGET_EXHAUSTED 现象）。若各组推理长度不同，会把
 * "身份体现程度"的差异混入"推理占用预算"的差异，因此固定关推理、给足正文额度。
 */
const reasoningLevel = 'off' as const
const mainHardCap = 1000
const judgeHardCap = 800

const scope = { characterId: 'bench-character', sessionId: 'bench-session' }
/**
 * 身份探针：直接要求角色**评价用户这个人**，把"模型到底知不知道这个用户是谁"逼到台面上。
 * 中性、非露骨：只测身份与性格是否被体现，不测露骨情节生成。
 * 注意：探针本身不得透露任何身份线索，否则 off 组会凭空拿到身份信息，对照失效。
 */
const userMessage = '（把酒钱按在柜台上，没有急着坐下）先别倒酒。你阅人无数——说说看，我这个人，你看出什么来了？别用场面话打发我。'

const characterFixture = {
  id: scope.characterId,
  name: '柳青娘',
  avatar: '',
  description: '深夜小酒肆的掌柜。说话带三分笑意，习惯用反问把话头递回去。',
  personality: '从容，口风紧，不轻易交底。',
  scenario: '雪夜，酒肆将打烊，屋里只剩一盏灯。',
  firstMessage: '',
  exampleDialog: '',
  tags: [],
  lorebookId: null,
  boundLorebookIds: [],
  creator: 'persona-injection-bench',
  createdAt: 1,
  updatedAt: 1,
  alternateGreetings: [],
}

/**
 * 反事实对照身份：**与真实身份同名**，只改描述与性格。
 * 同名是关键——把"名字"这一变量固定住（名字在所有组都经叙事提示出现），
 * 于是 system 组与 counter 组的差异**只能**来自描述与性格的内容，对照才干净。
 */
let controlPersona: Persona = {
  id: 'bench-persona-control',
  name: '待填',
  description: '性别:男。旧书店的常客，作息颠倒，喜欢在深夜读绝版书，说话轻声，从不与人争执。',
  persona: '温和守礼，与人保持距离，话少但不冷。',
  avatar: '',
  createdAt: 1,
  updatedAt: 1,
}

type Arm = {
  id: 'off' | 'system' | 'separate' | 'counter'
  label: string
  sessionPersonaId: string
  injection: PersonaInjectionConfig
  /** 该组应当注入的身份（用于判分基准） */
  expected: { name: string; description: string; persona: string } | null
  /** 组装断言：系统提示中是否应出现【用户人设】 */
  expectPersonaBlock: boolean
  /** separate 组：人设块必须出现在首条 system 消息之外 */
  expectOutsideFirstSystem?: boolean
}

let realPersona: Persona = controlPersona
let arms: Arm[] = []

app.whenReady().then(async () => {
  initLogger(isolated, LogLevel.WARN, { console: false })
  let exitCode = 0
  try {
    const { readChatSettings, resolveChatProfile } = await import('../electron/services/chatConnection')
    const { getAdapter } = await import('../electron/services/ai')
    const { contextService } = await import('../electron/chat/contextService')
    const { DIRS, writeJson } = await import('../electron/services/storage')
    const { chatData } = await import('../electron/features/chat/chatData')
    const { stripAllThinking } = await import('../shared/thoughtMarkup')

    // ---------- 1. 身份素材：真实身份取自用户配置（只读），对照身份为脚本内中性构造 ----------
    const storedPersonas = JSON.parse(readFileSync(join(source, 'data', 'config', 'personas.json'), 'utf-8')) as Persona[]
    const storedSettings = JSON.parse(readFileSync(join(source, 'data', 'config', 'settings.json'), 'utf-8')) as Settings
    const active = storedPersonas.find(item => item.id === storedSettings.activePersonaId)
      ?? storedPersonas.find(item => item.id === storedSettings.defaultPersonaId)
      ?? storedPersonas[0]
    if (!active) throw new Error('真实配置中没有可用身份，无法评测注入效果')
    realPersona = active
    controlPersona = { ...controlPersona, name: realPersona.name }
    writeJson(join(DIRS.config(), 'personas.json'), [realPersona, controlPersona])

    arms = [
      {
        id: 'off',
        label: '关闭注入（仅用户名经叙事提示出现）',
        sessionPersonaId: realPersona.id,
        injection: { enabled: false, position: 'system', includeDescription: true, includePersona: true },
        expected: null,
        expectPersonaBlock: false,
      },
      {
        id: 'system',
        label: '默认注入 position=system（含描述与性格）',
        sessionPersonaId: realPersona.id,
        injection: { enabled: true, position: 'system', includeDescription: true, includePersona: true },
        expected: { name: realPersona.name, description: realPersona.description, persona: realPersona.persona },
        expectPersonaBlock: true,
      },
      {
        id: 'separate',
        label: '独立 system 消息注入 position=separate',
        sessionPersonaId: realPersona.id,
        injection: { enabled: true, position: 'separate', includeDescription: true, includePersona: true },
        expected: { name: realPersona.name, description: realPersona.description, persona: realPersona.persona },
        expectPersonaBlock: true,
        expectOutsideFirstSystem: true,
      },
      {
        id: 'counter',
        label: '反事实身份（同名，只换描述与性格，system 注入）',
        sessionPersonaId: controlPersona.id,
        injection: { enabled: true, position: 'system', includeDescription: true, includePersona: true },
        expected: { name: controlPersona.name, description: controlPersona.description, persona: controlPersona.persona },
        expectPersonaBlock: true,
      },
    ]
    // 可选：只跑指定组（逗号分隔），用于重跑单组或快速自检。
    const onlyArms = (process.env.PERSONA_BENCH_ARMS || '').split(',').map(item => item.trim()).filter(Boolean)
    if (onlyArms.length) {
      arms = arms.filter(arm => onlyArms.includes(arm.id))
      if (!arms.length) throw new Error(`PERSONA_BENCH_ARMS 未匹配任何组：${onlyArms.join(',')}`)
    }

    // ---------- 2. 夹具落盘 ----------
    writeJson(join(DIRS.characters(), `${scope.characterId}.json`), characterFixture)

    const settings = readChatSettings()
    const profile = resolveChatProfile(settings)
    if (!profile) throw new Error('当前聊天连接不可用（activeProfileId 无法解析）')
    if (!profile.apiKey && profile.provider !== 'ollama') throw new Error('当前聊天连接缺少可用凭据')

    const report: Record<string, any> = {
      startedAt: new Date().toISOString(),
      isolated: relative(process.cwd(), isolated),
      source,
      connection: { name: profile.name, provider: profile.provider, model: profile.model, baseUrlHost: safeHost(profile.baseUrl) },
      temperature,
      topP: 0.95,
      mainHardCap,
      judgeHardCap,
      reasoningLevel,
      samples,
      judgeEnabled,
      dryRun,
      character: characterFixture,
      userMessage,
      identity: {
        realPersona: { id: realPersona.id, name: realPersona.name, descriptionLength: realPersona.description.length, personaLength: realPersona.persona.length },
        controlPersona: { id: controlPersona.id, name: controlPersona.name },
      },
      arms: [] as any[],
      failures: [] as string[],
    }
    const persist = () => writeFileSync(join(output, 'model-report.json'), JSON.stringify(report, null, 2))
    persist()

    const adapter = getAdapter(profile.provider)
    const chat = async (params: ChatParams): Promise<{ text: string; completion: any }> => {
      let text = ''
      const completion = await adapter.chat(params, chunk => { text += chunk }, new AbortController().signal, () => {})
      return { text, completion }
    }
    const writeSettingsFor = (arm: Arm) => {
      const raw = JSON.parse(readFileSync(join(isolated, 'data', 'config', 'settings.json'), 'utf-8')) as Settings
      raw.personaInjection = arm.injection
      raw.activeModel = profile.model
      writeFileSync(join(isolated, 'data', 'config', 'settings.json'), JSON.stringify(raw, null, 2), 'utf-8')
    }
    const writeSessionFor = (arm: Arm) => {
      writeJson(join(DIRS.chats(), scope.characterId, 'sessions.json'), [{
        id: scope.sessionId,
        characterId: scope.characterId,
        title: '人设注入评测',
        narrativeMode: 'immersive',
        personaId: arm.sessionPersonaId,
        memoryEnabled: false,
        messageCount: 1,
        createdAt: 1,
        updatedAt: 1,
      }])
    }

    // 会话与历史：全组共享同一条用户消息，各次采样都是同样输入的单轮请求（历史里只留这一条）。
    writeSessionFor(arms[0])
    await chatData.saveMessageLocked(scope.characterId, {
      id: 'bench-user-message',
      ...scope,
      role: 'user',
      content: userMessage,
      images: [],
      isEditing: false,
      timestamp: 1,
    })

    // ---------- 3. 逐组：先断言组装，再真机采样 ----------
    for (const arm of arms) {
      const record: Record<string, any> = { id: arm.id, label: arm.label, injection: arm.injection, sessionPersonaId: arm.sessionPersonaId, expected: arm.expected, context: null, samples: [] as any[] }
      report.arms.push(record)
      writeSettingsFor(arm)
      writeSessionFor(arm)

      const context = await contextService.build({ ...scope, content: userMessage, clientKind: 'desktop' })
      const messages = context.messages.map(item => ({ role: item.role, content: item.content, keepSeparate: (item as any).keepSeparate === true }))
      const blockIndexes = messages.map((item, index) => (item.content.includes('【用户人设】') ? index : -1)).filter(index => index >= 0)
      const assertion = {
        personaBlockPresent: blockIndexes.length > 0,
        personaBlockIndexes: blockIndexes,
        firstSystemHasBlock: messages[0]?.role === 'system' && messages[0].content.includes('【用户人设】'),
        usernameInPrompt: messages.some(item => item.content.includes(`与 ${arm.expected?.name ?? realPersona.name} 互动`) || item.content.includes(arm.expected?.name ?? realPersona.name)),
        descriptionIncluded: !!arm.expected?.description && messages.some(item => item.content.includes(arm.expected!.description)),
        personaIncluded: !!arm.expected?.persona && messages.some(item => item.content.includes(arm.expected!.persona)),
        systemMessageCount: messages.filter(item => item.role === 'system').length,
        contextFingerprint: context.fingerprint,
      }
      const assertionFailures: string[] = []
      if (assertion.personaBlockPresent !== arm.expectPersonaBlock) assertionFailures.push(`${arm.id}: 人设块存在性期望 ${arm.expectPersonaBlock} 实际 ${assertion.personaBlockPresent}`)
      if (arm.expectOutsideFirstSystem && blockIndexes.includes(0)) assertionFailures.push(`${arm.id}: separate 模式下人设块不应出现在首条 system 消息内`)
      if (arm.expected && !assertion.descriptionIncluded) assertionFailures.push(`${arm.id}: 期望注入的描述未出现在上下文中`)
      if (arm.expected && !assertion.personaIncluded) assertionFailures.push(`${arm.id}: 期望注入的性格未出现在上下文中`)
      record.context = { messages, assertion, assertionFailures, requestMaxTokens: context.requestMaxTokens }
      report.failures.push(...assertionFailures)
      persist()

      for (let index = 0; index < samples; index += 1) {
        if (dryRun) break
        const budget = resolveGenerationTaskBudget({ task: 'main', model: profile.model, userHardCap: mainHardCap, reasoningLevel })
        record.requestBudget = { maxTokens: budget.requestMaxTokens, gate: budget.reasoningGate.knob, level: budget.reasoningGate.level }
        const params: ChatParams = {
          requestId: randomUUID(),
          messages: messages.map(item => ({ role: item.role, content: item.content })),
          provider: profile.provider,
          apiKey: profile.apiKey,
          baseUrl: profile.baseUrl,
          model: profile.model,
          temperature,
          topP: 0.95,
          maxTokens: budget.requestMaxTokens,
          reasoningGate: budget.reasoningGate,
          frequencyPenalty: 0,
          presencePenalty: 0,
          stream: true,
        }
        const startedAt = Date.now()
        const attempts: string[] = []
        let produced: { text: string; completion: any } | null = null
        // 上游偶发空完成（adapter 抛"模型未返回任何内容"）属瞬时故障，重试两次；
        // 只有"重试后仍无正文"才计入失败，避免把网络抖动误报成注入无效。
        for (let attempt = 0; attempt < 3 && !produced; attempt += 1) {
          try {
            produced = await chat(params)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            attempts.push(message)
            if (!/未返回任何内容|empty|timeout|network|fetch failed|429|50[0-9]/i.test(message) || attempt === 2) break
            await new Promise(resolveWait => setTimeout(resolveWait, 1500))
          }
        }
        try {
          if (!produced) throw new Error(attempts.at(-1) || '未知错误')
          const { text, completion } = produced
          const body = stripAllThinking(text).trim()
          const sample: Record<string, any> = {
            index,
            attempts: attempts.length + 1,
            retriedErrors: attempts,
            latencyMs: Date.now() - startedAt,
            finishReason: completion?.finishReason,
            usage: completion?.usage,
            body,
            raw: text,
            checks: lexicalChecks(body),
          }
          if (judgeEnabled) sample.judge = await judgeWithRetry(adapter, profile, arm, body, params.requestId, index % 2 === 1)
          record.samples.push(sample)
        } catch (error) {
          const failure = `${arm.id}#${index}: ${error instanceof Error ? error.message : String(error)}`
          report.failures.push(failure)
          record.samples.push({ index, latencyMs: Date.now() - startedAt, error: failure, retriedErrors: attempts })
        }
        persist()
      }
      const ok = record.samples.filter((item: any) => typeof item.body === 'string' && item.body.length > 0).length
      if (!dryRun && ok < samples) report.failures.push(`${arm.id}: 仅 ${ok}/${samples} 次采样产出正文`)
      persist()
    }

    report.finishedAt = new Date().toISOString()
    report.summary = summarize(report.arms)
    persist()
  } catch (error) {
    exitCode = 1
    writeFileSync(join(output, 'failure.log'), error instanceof Error ? error.stack || error.message : String(error))
  } finally {
    for (const file of copied) if (existsSync(join(isolated, file))) unlinkSync(join(isolated, file))
    const unchanged = [...sourceHashes].every(([file, hash]) => existsSync(join(source, file)) && createHash('sha256').update(readFileSync(join(source, file))).digest('hex') === hash)
    writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ isolated: relative(process.cwd(), isolated), credentialsRemoved: copied.every(file => !existsSync(join(isolated, file))), sourceConfigurationUnchanged: unchanged }, null, 2))
    if (!unchanged) exitCode = 1
    if (!exitCode && existsSync(join(output, 'failure.log'))) unlinkSync(join(output, 'failure.log'))
    app.exit(exitCode)
  }
})

// ===================== 判分 =====================

/** 确定性词法检查：只做能靠字符串判定的事实，语义判断交给评分模型。 */
function lexicalChecks(body: string): Record<string, any> {
  const count = (literal: string) => {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matches = body.match(new RegExp(escaped, 'g'))
    return matches ? matches.length : 0
  }
  const maleAddress = ['先生', '公子', '兄台', '少爷', '大侠', '兄弟', '后生']
  const femaleAddress = ['小姐', '姑娘', '女士', '夫人', '太太', '丫头', '妹子']
  const metaPhrases = ['提示词', '系统提示', '人设', '设定要求', '指令要求', 'prompt', '我被告知', '根据输入']
  const explicitTerms = ['勃起', '生殖器', '精液', '性器', '插入', '性交', '高潮', '射精', '乳房', '阴茎', '做爱', '肉棒', '下体', '情欲']
  return {
    bodyChars: body.length,
    nameHitsReal: count(realPersona.name),
    nameHitsControl: count(controlPersona.name),
    maleAddress: maleAddress.filter(word => body.includes(word)),
    femaleAddress: femaleAddress.filter(word => body.includes(word)),
    metaHits: metaPhrases.filter(word => body.includes(word)),
    explicitHits: explicitTerms.filter(word => body.includes(word)),
    thoughtTagLeaked: body.includes('<thought>'),
  }
}

/** LLM 判分：**盲测**——只给候选身份与回复，不告诉它本轮注入了哪一条；只给分，不产出情节。 */
async function judgeOne(
  adapter: any,
  profile: { provider: any; apiKey: string; baseUrl: string; model: string },
  arm: Arm,
  body: string,
  requestId: string,
  /** A/B 位置翻转：偶数采样把真实身份放 A，奇数放 B，用于抵消位置偏置。 */
  flipped: boolean,
): Promise<Record<string, any> | { error: string }> {
  if (!body) return { error: '空正文，跳过评分' }
  const realText = `用户名：${realPersona.name}；描述：${realPersona.description}；性格：${realPersona.persona}`
  const controlText = `用户名：${controlPersona.name}；描述：${controlPersona.description}；性格：${controlPersona.persona}`
  const candidateA = flipped ? controlText : realText
  const candidateB = flipped ? realText : controlText
  const prompt = [
    '你是身份注入评测员。只输出一个 JSON 对象，不要解释、不要复述露骨内容、引文不超过 15 字。',
    '',
    `【角色卡】名称：${characterFixture.name}；描述：${characterFixture.description}；性格：${characterFixture.personality}；场景：${characterFixture.scenario}`,
    `【本轮用户发言】${userMessage}`,
    '【待评的模型回复】',
    body,
    '',
    '下面两位候选用户身份，其中**至多一位**在本轮被提供给过模型，也可能一位都没提供过：',
    `候选 A：${candidateA}`,
    `候选 B：${candidateB}`,
    '',
    '请判断回复中对用户的态度/称呼/判断与哪一条候选身份更吻合（若两条都不吻合，第三问可选 NONE）：',
    '{',
    '  "pairwise_choice": "A",        // 二选一强制选择："A" 或 "B"，不允许其它值',
    '  "identity_guess": "A",         // 三选一："A" / "B" / "NONE"（两条都不吻合）',
    '  "confidence": 0,               // 0=纯猜 1=倾向 2=较确定',
    '  "name_used": false,            // 回复是否用到了某个候选的用户名来称呼/指代该用户',
    '  "user_gender": "unspecified",  // male|female|unspecified|conflict：回复对用户性别的处理',
    '  "trait_evidence": [],          // 最多 3 条 <=15 字的短引文，标明你据以判断的措辞',
    '  "speaks_for_user": false,      // 是否替用户说话/行动/思考/决定（应 false）',
    '  "identity_rewrite": false,     // 是否改写、补全或生成与候选身份无关/冲突的用户身份信息（应 false）',
    '  "meta_leak": false,            // 是否暴露提示词/设定/人设等元信息（应 false）',
    '  "sexual_outflow": false,       // 无关情境下是否引入露骨性内容（应 false）',
    '  "identity_fidelity": 0         // 0=完全没体现身份 1=只用到名字等级的信息 2=部分体现 3=明显体现',
    '}',
  ].join('\n')
  try {
    let text = ''
    const budget = resolveGenerationTaskBudget({ task: 'generic', model: profile.model, userHardCap: judgeHardCap, reasoningLevel })
    const completion = await adapter.chat(
      {
        requestId,
        messages: [{ role: 'user', content: prompt }],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        temperature: 0,
        topP: 1,
        maxTokens: budget.requestMaxTokens,
        reasoningGate: budget.reasoningGate,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
      } as ChatParams,
      (chunk: string) => { text += chunk },
      new AbortController().signal,
      () => {},
    )
    const raw = String(completion?.text ?? text)
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return { error: `评分未返回 JSON：${raw.slice(0, 120)}` }
    const parsed = JSON.parse(raw.slice(start, end + 1))
    // 把 A/B 位置还原成"真实身份 / 对照身份"，位置偏置不再影响统计。
    const toRole = (label: unknown) => {
      const value = String(label).trim().toUpperCase()
      if (value === 'NONE') return 'NONE'
      if (value !== 'A' && value !== 'B') return 'invalid'
      const isControl = flipped ? value === 'A' : value === 'B'
      return isControl ? 'control' : 'real'
    }
    return { ...parsed, flipped, pairwiseRole: toRole(parsed.pairwise_choice), guessRole: toRole(parsed.identity_guess) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** 评分调用重试：空完成/超时属瞬时故障，最多再试两次。 */
async function judgeWithRetry(
  adapter: any,
  profile: { provider: any; apiKey: string; baseUrl: string; model: string },
  arm: Arm,
  body: string,
  requestId: string,
  flipped: boolean,
): Promise<Record<string, any>> {
  let last: Record<string, any> = { error: '未执行' }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await judgeOne(adapter, profile, arm, body, requestId, flipped)
    if (!last.error) return { ...last, attempts: attempt + 1 }
    if (!/未返回任何内容|timeout|network|fetch failed|429|50[0-9]|空正文/i.test(String(last.error))) break
    await new Promise(resolveWait => setTimeout(resolveWait, 1500))
  }
  return last
}

function summarize(arms: any[]): Record<string, any> {
  const rows = arms.map(arm => {
    const done = arm.samples.filter((item: any) => typeof item.body === 'string' && item.body)
    const judges = done.map((item: any) => item.judge).filter((item: any) => item && !item.error)
    const rate = (pick: (judge: any) => boolean) => judges.length ? Number((judges.filter((judge: any) => pick(judge)).length / judges.length).toFixed(2)) : null
    const avg = (pick: (judge: any) => number) => judges.length ? Number((judges.reduce((sum: number, judge: any) => sum + (Number(pick(judge)) || 0), 0) / judges.length).toFixed(2)) : null
    /** 该组"正确应被识别为哪条身份"：off 组没有注入，任何倾向都只是判分噪声。 */
    const expectedRole = arm.id === 'counter' ? 'control' : arm.id === 'off' ? null : 'real'
    const pairwise = judges.map((judge: any) => judge.pairwiseRole)
    const guess = judges.map((judge: any) => judge.guessRole)
    const countOf = (list: string[], value: string) => list.filter(item => item === value).length
    return {
      id: arm.id,
      label: arm.label,
      samples: arm.samples.length,
      completed: done.length,
      judgeErrors: done.length - judges.length,
      avgChars: done.length ? Math.round(done.reduce((sum: number, item: any) => sum + item.body.length, 0) / done.length) : 0,
      /** 主指标：盲测二选一是否挑中真正注入的那条身份（off 组为无效应，期望≈0.5）。 */
      expectedRole,
      pairwiseReal: countOf(pairwise, 'real'),
      pairwiseControl: countOf(pairwise, 'control'),
      pairwiseInvalid: countOf(pairwise, 'invalid'),
      pairwiseAccuracy: expectedRole ? Number((countOf(pairwise, expectedRole) / (judges.length || 1)).toFixed(2)) : null,
      /** 次指标：三选一（含 NONE）。off 组若判分有效，应显著偏向 NONE。 */
      guessReal: countOf(guess, 'real'),
      guessControl: countOf(guess, 'control'),
      guessNone: countOf(guess, 'NONE'),
      guessAccuracy: expectedRole ? Number((countOf(guess, expectedRole) / (judges.length || 1)).toFixed(2)) : null,
      judgeNoneRate: judges.length ? Number((countOf(guess, 'NONE') / judges.length).toFixed(2)) : null,
      nameUsedRate: rate(judge => judge.name_used === true),
      avgIdentityFidelity: avg(judge => judge.identity_fidelity),
      genderConflictRate: rate(judge => judge.user_gender === 'conflict' || judge.user_gender === 'female'),
      // 护栏：注入本该压住的越界行为，越低越好
      speaksForUserRate: rate(judge => judge.speaks_for_user === true),
      identityRewriteRate: rate(judge => judge.identity_rewrite === true),
      metaLeakRate: rate(judge => judge.meta_leak === true),
      sexualOutflowRate: rate(judge => judge.sexual_outflow === true),
      /** 确定性词法计数（不经判分模型）：真实身份名/对照身份名在回复正文中的出现次数合计。 */
      lex: {
        realNameHits: done.reduce((sum: number, item: any) => sum + item.checks.nameHitsReal, 0),
        controlNameHits: done.reduce((sum: number, item: any) => sum + item.checks.nameHitsControl, 0),
        explicitHitSamples: done.filter((item: any) => item.checks.explicitHits.length > 0).length,
        metaHitSamples: done.filter((item: any) => item.checks.metaHits.length > 0).length,
        thoughtLeakSamples: done.filter((item: any) => item.checks.thoughtTagLeaked).length,
      },
    }
  })
  return { arms: rows }
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return 'unknown'
  }
}
