/** 使用当前聊天连接进行隔离联验；不改动用户会话、群聊或画板。 */
import { app, BrowserWindow } from 'electron'
import { join, relative, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { initLogger, LogLevel } from '../electron/services/logger'
import type { SpatialCoreState } from '@qingyu/spatial-core'
import type { SpatialSnapshot } from '../shared/spatial'
import type { AICompletion, ChatParams, GroupChat } from '../shared/types'

const output = resolve('output/spatial-group-stage2')
mkdirSync(output, { recursive: true })
const isolated = mkdtempSync(join(output, 'model-user-data-')), config = join(isolated, 'data/config')
mkdirSync(config, { recursive: true })
const source = process.env.SPATIAL_MODEL_SOURCE || 'C:/Users/Administrator/AppData/Roaming/qingyu'
if (process.platform === 'win32' && !existsSync(join(source, 'Local State'))) throw new Error('联验环境缺少原应用 Local State')
for (const name of ['settings.json','credentials.json']) if (existsSync(join(source,'data/config',name))) copyFileSync(join(source,'data/config',name),join(config,name))
if (existsSync(join(source,'Local State'))) copyFileSync(join(source,'Local State'),join(isolated,'Local State'))
app.setPath('userData', isolated)
app.whenReady().then(async () => {
  initLogger(isolated, LogLevel.DEBUG, { console: false })
  const host = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  host.webContents.on('console-message', () => {})
  await host.loadURL('data:text/html,<script>setInterval(()=>console.log("bench-heartbeat"),100)</script>')
  const report: { passed: boolean; model?: string; connection?: string; checks: Array<{ name: string; passed: boolean }>; replies: Array<{ task: string; model: string; text: string; finishReason: string }>; error?: string; isolated: string } = { passed: false, checks: [], replies: [], isolated: relative(process.cwd(),isolated) }
  const check = (name: string, passed: boolean) => { report.checks.push({ name, passed }); if (!passed) throw new Error(name) }
  try {
    const { createSpatialGroupAiService } = await import('../electron/services/spatialGroupAiService')
    const { spatialService } = await import('../electron/features/spatial/commitService')
    const { spatialContextService } = await import('../electron/features/spatial/contextService')
    const { groupData } = await import('../electron/ipc/group')
    const { DIRS, writeJson } = await import('../electron/services/storage')
    const { readChatSettings, resolveChatProfile } = await import('../electron/services/chatConnection')
    const { chatWithRetry, getAdapter } = await import('../electron/services/ai')
    const { createBackupV2, restoreBackupV2 } = await import('../electron/services/backup')
    const { resolveGenerationTaskBudget } = await import('../shared/generationTaskBudget')
    const profile = resolveChatProfile(readChatSettings())
    if (!profile) throw new Error('未配置聊天模型')
    report.model = profile.model; report.connection = profile.name
    check('隔离环境可读取当前聊天连接', profile.provider === 'ollama' || !!profile.apiKey?.trim())
    const complete = async (params: ChatParams, signal: AbortSignal, timeout: number): Promise<AICompletion> => {
      check('所有请求沿用当前有效连接和模型', params.model === profile.model && params.baseUrl === profile.baseUrl && params.provider === profile.provider && params.apiKey === profile.apiKey)
      const completion = await chatWithRetry(getAdapter(params.provider),params,()=>{},signal,0,undefined,timeout)
      report.replies.push({ task: params.observability?.taskType ?? 'readonly', model: params.model, text: completion.text, finishReason: completion.finishReason })
      return completion
    }
    const ai = createSpatialGroupAiService({ complete }), scope = { kind: 'group' as const, groupId: 'bench-group', sessionId: 'bench-session' }
    const members = [['char-a','林雪'],['char-b','阿远'],['char-c','小岚']]
    for (const [id,name] of members) writeJson(join(DIRS.characters(),`${id}.json`), { id, name, description: `${name}是青石城的旅者`, scenario: '青石城的茶馆和渡口都是城内地点。', firstMessage: '未选中的城外开场', boundLorebookIds: [], createdAt: 1, updatedAt: 1 })
    writeJson(join(DIRS.config(),'personas.json'), [])
    let group: GroupChat = { id: scope.groupId, name: '青石城夜谈', memberIds: members.map(([id])=>id), chatMode: 'polling', currentSpeakerIndex: 0, autoMode: false, maxRounds: 1, speakerInterval: 100, presetId: null, lorebookIds: [], systemPrompt: '三位成员在青石城茶馆相会。', createdAt: 1, updatedAt: 1 }
    writeJson(join(DIRS.groups(),'index.json'), [group])
    writeJson(join(DIRS.groups(),scope.groupId,'sessions.json'), [scope.sessionId,'second-session'].map(id=>({ id, groupId: scope.groupId, title: '联验', messageCount: 0, personaId: null, narrativeMode: 'immersive', createdAt: 1, updatedAt: 1 })))
    const state = await ai.ask(scope,{ requestId: randomUUID(), mode: 'initialize', text: '创建青石城区域。茶馆和渡口都是青石城内的地点。林雪、阿远和小岚目前都在茶馆内，具体点位未知，不定义距离。' })
    check('真实模型初始化成功', state.tasks.at(-1)?.state === 'completed' && !!state.proposals[0]?.preview)
    check('初始化确认前保持未绑定', await spatialService.loadGroupBound(scope.groupId,scope.sessionId) === null)
    const applied = await ai.apply(scope,state.proposals[0].id, true)
    const core = applied.snapshot as SpatialSnapshot & SpatialCoreState
    check('初始化正式登记三位成员且起点明确', core.runtime.placements.length === 3 && core.world.nodes.some(node=>node.name === '茶馆') && core.world.nodes.some(node=>node.name === '渡口'))
    const moved = await ai.ask(scope,{ requestId: randomUUID(), mode: 'instruction', text: '把阿远移动到青石城的渡口内，具体点位未知。林雪与小岚的位置保持不变。' })
    check('真实模型群成员移动提案成功', moved.tasks.at(-1)?.state === 'completed' && moved.proposals.at(-1)?.commands.length === 1)
    check('移动确认前版本保持', (await spatialService.loadGroupBound(scope.groupId,scope.sessionId))?.version.runtimeRevision === applied.snapshot.version.runtimeRevision)
    const confirmed = await ai.apply(scope,moved.proposals.at(-1)!.id,true)
    const position = (snapshot: SpatialSnapshot, id: string) => { const {world,runtime} = snapshot as SpatialSnapshot & SpatialCoreState; const actor = world.actors.find(actor=>actor.externalRef.id === id)!; const placement = runtime.placements.find(item=>item.actorId === actor.id); return world.nodes.find(node=>node.id === placement?.anchor.nodeId)?.name }
    check('确认仅改变指定成员位置', position(confirmed.snapshot,'char-b') === '渡口' && position(confirmed.snapshot,'char-a') === '茶馆' && position(confirmed.snapshot,'char-c') === '茶馆')
    const { registerAIIPC } = await import('../electron/services/ai')
    const { registerGroupIPC } = await import('../electron/ipc/group')
    const { splitFreeReply } = await import('../shared/chat-core/groupFreeSplit')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) }
    registerAIIPC(ipc as unknown as Parameters<typeof registerAIIPC>[0]); registerGroupIPC(ipc as unknown as Parameters<typeof registerGroupIPC>[0])
    let latest = confirmed.snapshot
    const bodyPlan = resolveGenerationTaskBudget({ task: 'group_reply', model: profile.model, userHardCap: 1024, reasoningLevel: 'off' })
    for (const mode of ['mention','free','polling'] as const) for (const narrativeMode of ['immersive','omniscient'] as const) {
      group = {...group,chatMode:mode}; await groupData.saveGroup(group); await groupData.updateSession(scope.groupId,scope.sessionId,{narrativeMode,spatialNarrativeSyncPolicy:'suggest'})
      const burstId = randomUUID(), target = position(latest,'char-a') === '茶馆' ? '渡口' : '茶馆'
      const userMessage = {id:randomUUID(),groupId:scope.groupId,characterId:'__user__',content:`请描述林雪已经到达青石城的${target}。其他人保持原位置。`,images:[],timestamp:Date.now(),round:1,narrativeMode}
      await handlers.get('group:saveMessage')!({},scope.groupId,scope.sessionId,userMessage)
      for (let index=0;index<(mode==='polling'?2:1);index++) {
        const generationId = randomUUID(), characterId = index ? 'char-b' : 'char-a'
        check(`${mode}/${narrativeMode}发送前捕获批次`,await ai.dialogue.capture(scope,{generationId,burstId,kind:'normal',expectedVersion:latest.version,targetCharacterId:mode==='free'?undefined:characterId})===burstId)
        let body='',finishReason='unknown'
        const sender = {isDestroyed:()=>false,send:(channel:string,payload:{text?:string;finishReason?:string})=>{if(channel==='ai:chunk')body+=payload.text??'';if(channel==='ai:done')finishReason=payload.finishReason??'unknown'}}
        const params: ChatParams = { requestId:generationId, provider:profile.provider as ChatParams['provider'],model:profile.model,baseUrl:profile.baseUrl,apiKey:profile.apiKey,stream:false,temperature:0.1,topP:1,maxTokens:bodyPlan.requestMaxTokens,frequencyPenalty:0,presencePenalty:0,
          observability:{source:'group',taskType:'group_reply',sessionId:scope.sessionId},reasoningGate:{level:bodyPlan.reasoningGate.level,knob:bodyPlan.reasoningGate.knob,tokens:bodyPlan.reasoningGate.gateTokens}, messages:[{role:'system',content:'你是群聊故事叙述者。只描述用户指定已经完成的动作，其他人不移动。只写一到两句，不写指令或 JSON。'},{role:'user',content:index?'阿远仍在青石城渡口，林雪仍在刚到达的地点。只写阿远仍在渡口。':mode==='free'?`用【林雪】与【阿远】两段描述：林雪已经到达青石城的${target}；阿远仍在渡口。`:`林雪已经到达青石城的${target}。只写这个已完成动作。`}] }
        await handlers.get('ai:chat')!({sender},params)
        report.replies.push({task:'group_reply',model:profile.model,text:body,finishReason})
        check(`${mode}/${narrativeMode}正文完整成功`,finishReason==='stop'&&!!body.trim())
        const segments = mode==='free'?splitFreeReply({content:body,members:members.map(([id,name])=>({id,name})),narrativeMode}).messages:[{characterId,content:body}]
        const saved = segments.map(segment=>({id:randomUUID(),groupId:scope.groupId,characterId:segment.characterId,content:segment.content,images:[],timestamp:Date.now(),round:index+2,narrativeMode,spatialGroupGenerationId:generationId}))
        if(saved.length>1)await handlers.get('group:saveMessagesBatch')!({},scope.groupId,scope.sessionId,saved)
        else await handlers.get('group:saveMessage')!({},scope.groupId,scope.sessionId,saved[0])
        check(`${mode}/${narrativeMode}主进程签入完整检查点`,groupData.readMessages(scope.groupId,scope.sessionId).filter(message=>saved.some(item=>item.id===message.id)).every(message=>message.spatialGroupComplete===true))
        const before = report.replies.filter(reply=>reply.task==='spatial_dialogue_sync').length
        await ai.dialogue.register(scope,generationId,saved.map(message=>message.id))
        check(`${mode}/${narrativeMode}交还用户前不提取`,report.replies.filter(reply=>reply.task==='spatial_dialogue_sync').length===before)
      }
      const beforeCalls = report.replies.filter(reply=>reply.task==='spatial_dialogue_sync').length
      await ai.dialogue.close(scope,burstId); await ai.dialogue.drain(scope)
      const current = await ai.get(scope), task = current.tasks.filter(item=>item.mode==='dialogue_sync').at(-1), proposal = current.proposals.filter(item=>item.dialogueId===burstId).at(-1)
      check(`${mode}/${narrativeMode}完整批次提取一次`,task?.state==='completed'&&report.replies.filter(reply=>reply.task==='spatial_dialogue_sync').length===beforeCalls+1)
      check(`${mode}/${narrativeMode}移动等待确认`,proposal?.status==='pending'&&!!proposal.commands.length&&(await spatialService.loadGroupBound(scope.groupId,scope.sessionId))?.version.runtimeRevision===latest.version.runtimeRevision)
      latest = (await ai.apply(scope,proposal!.id,true)).snapshot
      check(`${mode}/${narrativeMode}确认采用最终位置`,position(latest,'char-a')===target&&position(latest,'char-b')==='渡口')
      await ai.dialogue.close(scope,burstId); await ai.dialogue.drain(scope)
      check(`${mode}/${narrativeMode}重复通知不重提取`,report.replies.filter(reply=>reply.task==='spatial_dialogue_sync').length===beforeCalls+1)
    }
    const frozen = JSON.stringify(latest)
    const second = await ai.get({...scope,sessionId:'second-session'}); check('群聊会话助手隔离',second.id !== applied.state.id && second.messages.length === 0)
    const backup = join(isolated,'group-stage2.zip'); createBackupV2(backup); ai.suspendRestore()
    try { restoreBackupV2(backup) } finally { ai.resumeRestore() }
    check('正式画板和独立助手可备份恢复',JSON.stringify(await spatialService.loadGroupBound(scope.groupId,scope.sessionId)) === frozen && (await ai.get(scope)).proposals.find(item=>item.id === moved.proposals.at(-1)!.id)?.status === 'applied')
    group = {...group, memberIds: group.memberIds.filter(id=>id !== 'char-b')}; await groupData.saveGroup(group)
    check('移出成员不再进入正文空间投影',!(await spatialContextService.readGroup(scope))?.text.includes('阿远'))
    check('主聊天历史未被画板助手污染',groupData.readMessages(scope.groupId,scope.sessionId).every(message=>!message.content.includes('schemaVersion')&&!message.content.includes('需确认后应用')))
    report.passed = true
  } catch (error) { report.error = error instanceof Error ? error.message : String(error) }
  finally {
    host.destroy()
    for (const path of [join(config,'settings.json'),join(config,'credentials.json'),join(isolated,'Local State')]) if (existsSync(path)) unlinkSync(path)
    writeFileSync(join(output,'model-report.json'),JSON.stringify(report,null,2))
    app.exit(report.passed ? 0 : 1)
  }
})
