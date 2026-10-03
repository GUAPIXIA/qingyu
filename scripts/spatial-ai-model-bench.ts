/** 需人工显式执行：使用当前聊天配置，隔离 userData，不接触用户的聊天/地图。 */
import { app } from 'electron'
import { join, relative, resolve, sep } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { SpatialSnapshot } from '../shared/spatial'
import type { Message, ProviderType } from '../shared/types'
import type { SpatialCoreState } from '@qingyu/spatial-core'

const phase4 = process.argv.includes('--phase4')
const phase3 = phase4 || process.argv.includes('--phase3')
const resume4 = phase4 && process.argv.includes('--resume-stage4')
const audit4 = phase4 && process.argv.includes('--audit-stage4')
const resume = audit4 || resume4 || (phase3 && process.argv.includes('--resume-phase3'))
const phase2 = phase3 || process.argv.includes('--phase2')
const output = resolve(phase4 ? 'output/spatial-stage4' : phase3 ? 'output/spatial-stage3' : phase2 ? 'output/spatial-stage2' : 'output/spatial-stage1')
mkdirSync(output, { recursive: true })
const priorReport = resume ? JSON.parse(readFileSync(join(output, 'model-report.json'), 'utf8')) : null
const isolated = resume ? resolve(priorReport.isolated) : mkdtempSync(join(output, 'model-user-data-'))
if (resume && !isolated.startsWith(output + sep)) throw new Error('恢复联验目录不属于阶段 3 输出')
const config = join(isolated, 'data/config')
mkdirSync(config, { recursive: true })
const source = process.env.SPATIAL_MODEL_SOURCE || 'C:/Users/Administrator/AppData/Roaming/qingyu'
// Windows safeStorage 除了 OS 用户身份，还依赖该 userData 的 OSCrypt 状态。
// 必须在 Electron ready 前复制；否则隔离目录的新密钥无法解密原凭据。
const sourceState = join(source, 'Local State')
if (process.platform === 'win32' && !existsSync(sourceState)) throw new Error('联验环境缺少原应用的 Local State，不能解密聊天密钥')
if (existsSync(sourceState)) copyFileSync(sourceState, join(isolated, 'Local State'))
for (const name of ['settings.json', 'credentials.json']) {
  const path = join(source, 'data/config', name)
  if (existsSync(path)) copyFileSync(path, join(config,name))
}
app.setPath('userData', isolated)
app.whenReady().then(async () => {
  const report: Record<string, unknown> = resume ? { ...priorReport, error: undefined, resumedAt: new Date().toISOString() }
    : { date: new Date().toISOString(), phase: phase4 ? '1+2+3+4' : phase3 ? '1+2+3' : phase2 ? '1+2' : '1', isolated: relative(process.cwd(), isolated), checks: [] }
  const check = (name: string, value: boolean, required = true) => { (report.checks as unknown[]).push({name,passed:value}); if (!value && required) throw new Error(name) }
  if (resume4) {
    const boundary = priorReport.checks.findIndex((item: { name: string }) => item.name === '普通角色自动移动：冻结发送基线')
    if (boundary < 0) throw new Error('缺少阶段 4 之前的真实模型基线')
    report.checks = priorReport.checks.slice(0, boundary)
    report.resumedStage4 = { reusedBaselineChecks: boundary, previousCompletedCalls: priorReport.completedModelCalls }
  }
  try {
    const { createSpatialAiService } = await import('../electron/services/spatialAiService')
    const { spatialService } = await import('../electron/services/spatialService')
    const { spatialContextService } = await import('../electron/services/spatialContextService')
    const { contextService } = await import('../electron/chat/contextService')
    const { chatWithRetry, getAdapter } = await import('../electron/services/ai')
    const modelReplies: unknown[] = resume ? priorReport.modelReplies : []
    report.modelReplies = modelReplies
    const spatialAiService = createSpatialAiService({ complete: async (params, signal, timeout) => {
      const completion = await chatWithRetry(getAdapter(params.provider),params,()=>{},signal,0,undefined,timeout)
      modelReplies.push({ task: params.observability?.taskType, text: completion.text, finishReason: completion.finishReason })
      return completion
    } })
    const { readChatSettings, resolveChatProfile } = await import('../electron/services/chatConnection')
    const { writeJson, DIRS } = await import('../electron/services/storage')
    const { chatData } = await import('../electron/features/chat/chatData')
    const settings = readChatSettings(); const profile = resolveChatProfile(settings)
    if (!profile) throw new Error('未配置聊天模型')
    report.model = profile.model
    report.connection = profile.name
    check('隔离环境正确读取当前聊天密钥', profile.provider === 'ollama' || !!profile.apiKey?.trim())
    if (resume && !resume4) {
      const characterId = readdirSync(DIRS.chats()).find(id => id.startsWith('model-char-'))!
      const session = (await chatData.listSessions(characterId))[0]!
      const scope = { characterId, sessionId: session.id }, state = await spatialAiService.get(scope)
      if (audit4) {
        const before = (await spatialService.loadBound(characterId,session.id))!, calls = modelReplies.length
        await chatData.updateSession(characterId,session.id,{spatialContextEnabled:false,spatialNarrativeSyncPolicy:'auto'})
        check('关闭对话读取暂停自动剧情捕获',await spatialAiService.dialogue.capture(scope,{generationId:randomUUID(),kind:'normal'}) === null)
        await spatialAiService.dialogue.recover(); await spatialAiService.dialogue.drain(scope)
        check('关闭读取时恢复不多调用模型或移动',modelReplies.length === calls && JSON.stringify((await spatialService.loadBound(characterId,session.id))!.version) === JSON.stringify(before.version))
        check('关闭读取时主对话没有位置投影',!(await contextService.build({...scope,content:'继续',clientKind:'desktop'})).spatialContext)
        await chatData.updateSession(characterId,session.id,{spatialContextEnabled:true,spatialNarrativeSyncPolicy:'off'})
        await spatialAiService.dialogue.recover(); await spatialAiService.dialogue.drain(scope)
        check('恢复读取不会追认旧自动建议',modelReplies.length === calls && JSON.stringify((await spatialService.loadBound(characterId,session.id))!.version) === JSON.stringify(before.version))
        report.auditStage4At = new Date().toISOString()
        spatialAiService.dialogue.cancelScope(scope)
        report.passed = (report.checks as { passed: boolean }[]).every(item => item.passed)
        return
      }
      const proposal = state.proposals.filter(item => item.mode === 'dialogue_sync' && item.status === 'applied' && item.reviewedFromId).at(-1)!
      if (!proposal) throw new Error('缺少已确认的真实模型阶段 3 提案')
      const read = await contextService.build({...scope,content:'继续',clientKind:'desktop'})
      check('下一轮主聊天读取新地点',!!read.spatialContext && read.messages.some(message => message.content.includes('【空间位置 v1】') && message.content.includes('渡口')))
      const { createBackupV2, restoreBackupV2 } = await import('../electron/services/backup')
      const backup = join(isolated,'stage3-backup.zip'), beforeMessages = JSON.stringify(chatData.readMessages(characterId,session.id,true))
      const snapshot = (await spatialService.loadBound(characterId,session.id))!, calls = modelReplies.length
      createBackupV2(backup); await spatialAiService.restore(()=>restoreBackupV2(backup))
      check('备份恢复保留两条历史与幂等结果',JSON.stringify(chatData.readMessages(characterId,session.id,true)) === beforeMessages && JSON.stringify((await spatialAiService.apply(scope,proposal.id)).snapshot.version) === JSON.stringify(snapshot.version))
      check('恢复不会额外调用模型',modelReplies.length === calls)
      spatialAiService.dialogue.cancelScope(scope)
      report.passed = (report.checks as { passed: boolean }[]).every(item => item.passed)
      return
    }
    const restoredCharacter = resume4 ? readdirSync(DIRS.chats()).find(id => id.startsWith('model-char-'))! : ''
    const scope = resume4 ? { characterId: restoredCharacter, sessionId: (await chatData.listSessions(restoredCharacter))[0]!.id }
      : {characterId:`model-char-${randomUUID()}`,sessionId:`model-chat-${randomUUID()}`}
    if (!resume4) {
    writeJson(join(DIRS.characters(),`${scope.characterId}.json`),{id:scope.characterId,name:'林雪',description:'旅者。',scenario:'青石城中有一栋小屋，小屋内有厨房，屋外有花园。林雪现在在厨房。',firstMessage:'林雪站在厨房。'})
    writeJson(join(DIRS.config(),'personas.json'),[{id:'model-persona',name:'旅人',description:'旅人此刻在花园。',persona:''}])
    writeJson(join(DIRS.chats(),scope.characterId,'sessions.json'),[{id:scope.sessionId,characterId:scope.characterId,title:'隔离模型验证',personaId:'model-persona',narrativeMode:'immersive',createdAt:Date.now(),updatedAt:Date.now(),messageCount:1}])
    const messagePath = join(DIRS.chats(),scope.characterId,`${scope.sessionId}.jsonl`)
    writeFileSync(messagePath,JSON.stringify({id:'selected-opening',sessionId:scope.sessionId,characterId:scope.characterId,role:'assistant',content:'林雪现在在厨房，旅人此刻在花园。',timestamp:Date.now()})+'\n')
    const init = await spatialAiService.ask(scope,{requestId:randomUUID(),mode:'initialize',text:''})
    report.initializationTask = init.tasks.at(-1)
    check(`真实模型初始化输出校验通过${init.tasks.at(-1)?.error ? `：${init.tasks.at(-1)!.error}` : ''}`,init.tasks.at(-1)?.state === 'completed' && init.proposals.length === 1)
    check('确认前未绑定正式地图',await spatialService.loadBound(scope.characterId,scope.sessionId) === null)
    const initialCore = init.proposals[0]!.preview as SpatialSnapshot & SpatialCoreState
    const garden = initialCore.world.nodes.find(item => item.name.includes('花园'))!
    const house = initialCore.world.nodes.find(item => item.name === '小屋')!
    let ancestor = garden.parentNodeId
    while (ancestor && ancestor !== house.id) ancestor = initialCore.world.nodes.find(item => item.id === ancestor)?.parentNodeId ?? null
    check('屋外花园没有被初始化为屋内空间',ancestor !== house.id && initialCore.world.boards.find(item => item.id === garden.boardId)?.parentEntryNodeId !== house.id)
    const confirmed = await spatialAiService.apply(scope,init.proposals[0]!.id,true)
    const first = await spatialContextService.read(scope)
    check('初始人物位置读取',!!first?.text.includes('厨房') && !!first.text.includes('花园'))
    const move = await spatialAiService.ask(scope,{requestId:randomUUID(),mode:'instruction',text:'把林雪从厨房移到已有的花园，用户的位置保持原样。'})
    report.instructionTask = move.tasks.at(-1)
    const proposal = move.proposals.filter(item => item.status === 'pending').at(-1)
    check(`真实模型移动指令输出校验通过${move.tasks.at(-1)?.error ? `：${move.tasks.at(-1)!.error}` : ''}`,move.tasks.at(-1)?.state === 'completed' && !!proposal)
    await spatialAiService.apply(scope,proposal!.id,true)
    const last = await spatialContextService.read(scope)
    check('确认后读取新位置及新修订',!!last && last.version.runtimeRevision > confirmed.snapshot.version.runtimeRevision && last.text.includes('花园'))
    const desktop = await contextService.build({...scope,content:'你在哪里？',clientKind:'desktop'})
    const android = await contextService.build({...scope,content:'你在哪里？',clientKind:'android'})
    report.readonlyInput = desktop.messages
    check('V2 desktop 请求携带当前空间快照',!!desktop.spatialContext && desktop.messages.some(message => message.content.includes('【空间位置 v1】')))
    check('Android 请求未启用 PC 空间投影',!android.spatialContext && !android.messages.some(message => message.content.includes('【空间位置 v1】')))
    const probe = await chatWithRetry(getAdapter(profile.provider as ProviderType),{requestId:randomUUID(),provider:profile.provider as ProviderType,model:profile.model,apiKey:profile.apiKey,baseUrl:profile.baseUrl,messages:[...desktop.messages,{role:'user',content:'依据最新的空间位置，用一句话说明林雪和旅人各在哪里。不要复述旧起点。'}],maxTokens:1024,stream:false,temperature:0,topP:1,frequencyPenalty:0,presencePenalty:0,reasoningGate:{level:'off',knob:'thinking-disable'},observability:{source:'aux',taskType:'spatial_instruction'}},()=>{},new AbortController().signal,0,undefined,60000)
    report.readonlyReply = probe.text
    check('真实对话模型读取确认后的关系',probe.text.includes('花园') && !probe.text.includes('厨房'),false)
    const query = await spatialAiService.ask(scope,{requestId:randomUUID(),mode:'instruction',text:'把她移到地图中不存在的月宫，不要创建新地点；先询问我。'})
    report.clarificationTask = query.tasks.at(-1)
    check('未知地点先澄清，不生成可执行移动',query.tasks.at(-1)?.state === 'completed' && query.proposals.filter(item=>item.status==='pending').length === 0)
    check('主聊天正文未混入画板助手记录',chatData.readMessages(scope.characterId,scope.sessionId).length === 1)
    }
    if (phase2) {
      // 保存正文是受控材料；提取通过真实模型和正式持久队列执行，非模型桩。
      const dialogueChecks: unknown[] = []
      report.dialogueChecks = dialogueChecks
      const position = (snapshot: SpatialSnapshot, kind: 'qingyu-character' | 'qingyu-persona') => {
        const core = snapshot as SpatialSnapshot & SpatialCoreState
        const actor = core.world.actors.find(item => item.externalRef.type === kind)!
        const placement = core.runtime.placements.find(item => item.actorId === actor.id)
        return core.world.nodes.find(item => item.id === placement?.anchor.nodeId)?.name
      }
      const extract = async (name: string, userText: string, body: string, options: { kind?: 'normal' | 'regenerate' | 'continue'; automatic?: boolean; allowRejected?: boolean; afterCapture?: () => Promise<unknown> } = {}) => {
        const generationId = randomUUID(), messageId = randomUUID()
        const persist = (id: string, role: Message['role'], content: string, marker?: string) => chatData.saveMessageLocked(scope.characterId,
          { ...scope, id, role, content, images: [], isEditing: false, timestamp: Date.now(), ...(marker ? { spatialGenerationId: marker } : {}) })
        await persist(randomUUID(), 'user', userText)
        check(`${name}：冻结发送基线`, await spatialAiService.dialogue.capture(scope, { generationId, kind: options.kind ?? 'normal' }) === generationId)
        await options.afterCapture?.()
        const before = await spatialService.loadBound(scope.characterId,scope.sessionId)
        await persist(messageId, 'assistant', body, generationId)
        await spatialAiService.dialogue.register(scope,generationId,messageId)
        await spatialAiService.dialogue.register(scope,generationId,messageId)
        await spatialAiService.dialogue.drain(scope)
        const state = await spatialAiService.get(scope)
        const tasks = state.tasks.filter(item => item.dialogueId === generationId)
        const proposals = state.proposals.filter(item => item.dialogueId === generationId)
        dialogueChecks.push({name,body,task:tasks[0],proposals})
        const rejected = options.allowRejected && tasks.length === 1 && tasks[0]?.state === 'failed' && !proposals.length && /证据|完成状态|最终位置|置信度|目标地点/.test(tasks[0]?.error ?? '')
        check(`${name}：${rejected ? '非法模型结果被权威校验拒绝' : '真实模型完整提取'}${tasks[0]?.error ? `：${tasks[0].error}` : ''}`,tasks.length === 1 && (tasks[0]?.state === 'completed' || !!rejected))
        if (options.automatic) check(`${name}：自动提交仅增加一次修订`,(await spatialService.loadBound(scope.characterId,scope.sessionId))!.version.runtimeRevision === before!.version.runtimeRevision + 1 && proposals.length === 1 && proposals[0]!.automatic?.status === 'applied' && proposals[0]!.status === 'applied')
        else check(`${name}：确认前位置版本不变`,JSON.stringify((await spatialService.loadBound(scope.characterId,scope.sessionId))?.version) === JSON.stringify(before?.version))
        check(`${name}：主正文保持原样`,chatData.readMessages(scope.characterId,scope.sessionId,true).find(item => item.id === messageId)?.content === body)
        return { before: before!, state, proposals, generationId, messageId, rejected }
      }
      if (!resume4) {
      const completed = await extract('已完成角色移动','我仍在花园，继续描述林雪的行动。','林雪已经回到厨房，站在灶台旁。旅人仍在花园。')
      const proposal = completed.proposals.find(item => item.status === 'pending')
      check('已完成移动生成单个需确认命令',!!proposal && proposal.commands.length === 1 && proposal.unresolved.length === 0)
      const applied = await spatialAiService.apply(scope,proposal!.id)
      check('确认剧情后角色回到厨房，用户仍在花园',!!position(applied.snapshot,'qingyu-character')?.includes('厨房') && !!position(applied.snapshot,'qingyu-persona')?.includes('花园'))
      check('剧情提交记录 story 来源',(applied.snapshot as SpatialSnapshot & SpatialCoreState).runtime.events.at(-1)?.source === 'story')
      check('重复确认不再移动',JSON.stringify((await spatialAiService.apply(scope,proposal!.id)).snapshot.version) === JSON.stringify(applied.snapshot.version))
      const updated = await contextService.build({...scope,content:'继续',clientKind:'desktop'})
      check('下一轮主对话读取确认后的厨房位置',!!updated.spatialContext && updated.messages.some(message => message.content.includes('【空间位置 v1】') && message.content.includes('厨房')))
      const plan = await extract('尚未完成的计划','继续描述。','林雪准备去花园，但她尚未到达，仍在厨房。')
      check('计划不生成移动命令',plan.proposals.every(item => item.commands.length === 0))
      const persona = await extract('AI 代替用户移动','继续描述林雪，我没有移动。','旅人已经走进厨房。林雪仍在厨房。')
      check('未经用户声明的 persona 行动不生成移动命令',persona.proposals.every(item => item.commands.length === 0))
      const final = await spatialService.loadBound(scope.characterId,scope.sessionId)
      check('计划与用户代行不改变已确认位置',JSON.stringify(final?.version) === JSON.stringify(applied.snapshot.version))
      check('助手历史未串入主聊天',chatData.readMessages(scope.characterId,scope.sessionId,true).length === 7)
      if (phase3) {
        const undone = await spatialAiService.undo(scope, proposal!.id)
        check('真实剧情提交可撤销回原位置',position(undone.snapshot,'qingyu-character') === position(completed.before,'qingyu-character'))
        check('重复撤销不改变版本',JSON.stringify((await spatialAiService.undo(scope,proposal!.id)).snapshot.version) === JSON.stringify(undone.snapshot.version))
        const unknown = await extract('未知目标','我仍在花园。','林雪已经到达青石城的渡口，停在渡口内。旅人仍在花园。')
        const unresolved = unknown.proposals.find(item => item.status === 'pending')!
        check('未知目标保留原文依据而不创建地图',!!unresolved && !unresolved.commands.length && !!unresolved.dialogueCandidates?.some(item => item.eligible && !item.targetNodeId))
        const candidate = unresolved.dialogueCandidates!.find(item => item.eligible && !item.targetNodeId)!
        const parent = (unknown.before as SpatialSnapshot & SpatialCoreState).world.nodes.find(item => item.kind === 'region' && item.name.includes('青石城'))
        const creation = (await spatialAiService.preparePlace(scope,unresolved.id,'渡口',parent?.id ?? null)).proposals.at(-1)!
        check('地点创建预览没有提前提交',JSON.stringify((await spatialService.loadBound(scope.characterId,scope.sessionId))?.version) === JSON.stringify(unknown.before.version))
        const created = await spatialAiService.apply(scope,creation.id)
        const wharf = (created.snapshot as SpatialSnapshot & SpatialCoreState).world.nodes.find(item => item.name === '渡口')!
        check('创建地点不移动人物',position(created.snapshot,'qingyu-character') === position(unknown.before,'qingyu-character'))
        const reviewed = (await spatialAiService.review(scope,unresolved.id,{targets:{[candidate.id]:wharf.id}})).proposals.at(-1)!
        check('重新核对显示当前位置与实际完整目标',!!reviewed.comparisons?.[0].currentPath && !!reviewed.comparisons?.[0].targetPath.includes('渡口') && reviewed.status === 'pending')
        check('核对后仍等待第二次确认',JSON.stringify((await spatialService.loadBound(scope.characterId,scope.sessionId))?.version) === JSON.stringify(created.snapshot.version))
        const moved = await spatialAiService.apply(scope,reviewed.id)
        check('第二次确认才移动到新地点',position(moved.snapshot,'qingyu-character') === '渡口')
        const read = await contextService.build({...scope,content:'继续',clientKind:'desktop'})
        check('下一轮主聊天读取新地点',!!read.spatialContext && read.messages.some(message => message.content.includes('【空间位置 v1】') && message.content.includes('渡口')))
        const { createBackupV2, restoreBackupV2 } = await import('../electron/services/backup')
        const backup = join(isolated,'stage3-backup.zip')
        const beforeMessages = JSON.stringify(chatData.readMessages(scope.characterId,scope.sessionId,true))
        createBackupV2(backup)
        const calls = modelReplies.length
        await spatialAiService.restore(()=>restoreBackupV2(backup))
        check('备份恢复保留两条历史与幂等结果',JSON.stringify(chatData.readMessages(scope.characterId,scope.sessionId,true)) === beforeMessages && JSON.stringify((await spatialAiService.apply(scope,reviewed.id)).snapshot.version) === JSON.stringify(moved.snapshot.version))
        check('恢复不会额外调用模型',modelReplies.length === calls)
      }
      }
      if (phase4) {
        const setPolicy = (policy: 'auto' | 'suggest' | 'off') => chatData.updateSession(scope.characterId, scope.sessionId, { spatialNarrativeSyncPolicy: policy })
        await setPolicy('auto')
        const auto = await extract('普通角色自动移动', '我仍在花园，请描述林雪的动作。', '林雪已经到达青石城的花园，停在花园内。旅人仍在花园。', { automatic: true })
        const automatic = auto.proposals[0]!, autoSnapshot = (await spatialService.loadBound(scope.characterId,scope.sessionId))!
        check('自动应用保留置信度与真实正文证据',automatic.dialogueCandidates!.every(item => item.completed && item.eligible && item.confidence! >= 0.9))
        check('自动应用使用 story 事务且不移动用户',position(autoSnapshot,'qingyu-character')?.includes('花园') === true && position(autoSnapshot,'qingyu-persona')?.includes('花园') === true && (autoSnapshot as SpatialSnapshot & SpatialCoreState).runtime.events.at(-1)?.source === 'story')
        const autoRead = await contextService.build({...scope,content:'继续',clientKind:'desktop'})
        check('下一轮主聊天读取自动提交后的关系',!!autoRead.spatialContext && autoRead.messages.some(message => message.content.includes('【空间位置 v1】') && message.content.includes('花园')))
        const calls = modelReplies.length
        await spatialAiService.dialogue.register(scope,auto.generationId,auto.messageId); await spatialAiService.dialogue.recover(); await spatialAiService.dialogue.drain(scope)
        check('自动结果重复通知与恢复不多调用模型或移动',modelReplies.length === calls && JSON.stringify((await spatialService.loadBound(scope.characterId,scope.sessionId))!.version) === JSON.stringify(autoSnapshot.version))
        const { createBackupV2, restoreBackupV2 } = await import('../electron/services/backup')
        const backup = join(isolated,'stage4-backup.zip'), beforeMessages = JSON.stringify(chatData.readMessages(scope.characterId,scope.sessionId,true))
        createBackupV2(backup); await spatialAiService.restore(()=>restoreBackupV2(backup))
        check('自动提交备份恢复保留两份历史及幂等结果',JSON.stringify(chatData.readMessages(scope.characterId,scope.sessionId,true)) === beforeMessages && (await spatialAiService.get(scope)).proposals.find(item => item.id === automatic.id)?.automatic?.status === 'applied' && JSON.stringify((await spatialAiService.apply(scope,automatic.id)).snapshot.version) === JSON.stringify(autoSnapshot.version))
        const undo = await spatialAiService.undo(scope,automatic.id)
        check('真实自动提交可撤销且不重应用',position(undo.snapshot,'qingyu-character') === position(auto.before,'qingyu-character') && (await spatialAiService.get(scope)).proposals.find(item => item.id === automatic.id)?.status === 'undone')
        const persona = await extract('用户声明移动仍需确认', '旅人已经进入青石城小屋内的厨房。', '旅人已经到达青石城小屋内的厨房。林雪仍在渡口。')
        check('自动模式仍保留 persona 确认',persona.proposals.some(item => item.status === 'pending' && item.automatic?.status === 'confirmation' && item.commands.length > 0 && item.dialogueCandidates?.some(candidate => candidate.evidenceSource === 'user')))
        const regenerated = await extract('重新生成不自动移动', '我仍在花园。', '林雪已经到达青石城的花园。旅人仍在花园。', { kind: 'regenerate', allowRejected: true })
        check('真实重新生成候选留待确认，非法结果拒绝',!!regenerated.rejected || regenerated.proposals.some(item => item.status === 'pending' && item.commands.length > 0 && item.automatic?.status === 'confirmation'))
        const continued = await extract('续写不自动移动', '我仍在花园。', '林雪接着已经到达青石城小屋内的厨房。旅人仍在花园。', { kind: 'continue', allowRejected: true })
        check('真实续写候选留待确认，非法结果拒绝',!!continued.rejected || continued.proposals.some(item => item.status === 'pending' && item.commands.length > 0 && item.automatic?.status === 'confirmation'))
        await setPolicy('suggest')
        const suggested = await extract('切回需确认', '我仍在花园。', '林雪已经到达青石城的花园。旅人仍在花园。')
        check('切回需确认不自动应用',suggested.proposals.some(item => item.status === 'pending' && !item.automatic))
        const lateAuto = await extract('开启自动不追认旧回复', '我仍在花园。', '林雪已经到达青石城小屋内的厨房。旅人仍在花园。', { afterCapture: () => setPolicy('auto') })
        check('策略冻结阻止旧回复自动批准',lateAuto.proposals.some(item => item.status === 'pending' && item.automatic?.reason?.includes('发送时')))
        const unknown = await extract('自动模式未知地点', '我仍在花园。', '林雪已经到达青石城的钟楼。旅人仍在花园。')
        check('自动模式未知地点保留核对，不自动创建',unknown.proposals.some(item => !item.commands.length && item.automatic?.status === 'confirmation' && !!item.unresolved.length))
        await setPolicy('off')
        check('关闭模式不捕获剧情且没有额外模型调用',await spatialAiService.dialogue.capture(scope,{generationId:randomUUID(),kind:'normal'}) === null)
        const closedCalls = modelReplies.length; await spatialAiService.dialogue.recover(); await spatialAiService.dialogue.drain(scope)
        check('关闭同步保留已确认位置',modelReplies.length === closedCalls && JSON.stringify((await spatialService.loadBound(scope.characterId,scope.sessionId))!.version) === JSON.stringify(undo.snapshot.version))
      }
      spatialAiService.dialogue.cancelScope(scope)
    }
    report.passed = (report.checks as { passed: boolean }[]).every(item => item.passed)
  } catch (error) {
    report.passed = false; report.error = error instanceof Error ? error.message : '验证失败'
    process.exitCode = 1
  } finally {
    report.completedModelCalls = (Array.isArray(report.modelReplies) ? report.modelReplies.length : 0) + (report.readonlyReply ? 1 : 0)
    for (const path of [join(config,'settings.json'),join(config,'credentials.json'),join(isolated,'Local State')]) { if (existsSync(path)) unlinkSync(path) }
    writeFileSync(join(isolated,'model-report.json'),JSON.stringify(report,null,2))
    writeFileSync(join(output,'model-report.json'),JSON.stringify(report,null,2))
    console.log(JSON.stringify({passed:report.passed,model:report.model,checks:report.checks,error:report.error}))
    app.exit(report.passed ? 0 : 1)
  }
})
