/** 使用当前聊天连接进行隔离联验；不改动用户会话、群聊或画板。 */
import { app } from 'electron'
import { join, relative, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { SpatialCoreState } from '@qingyu/spatial-core'
import type { SpatialSnapshot } from '../shared/spatial'
import type { AICompletion, ChatParams, GroupChat } from '../shared/types'

const output = resolve('output/spatial-group-stage1')
mkdirSync(output, { recursive: true })
const isolated = mkdtempSync(join(output, 'model-user-data-')), config = join(isolated, 'data/config')
mkdirSync(config, { recursive: true })
const source = process.env.SPATIAL_MODEL_SOURCE || 'C:/Users/Administrator/AppData/Roaming/qingyu'
if (process.platform === 'win32' && !existsSync(join(source, 'Local State'))) throw new Error('联验环境缺少原应用 Local State')
for (const name of ['settings.json','credentials.json']) if (existsSync(join(source,'data/config',name))) copyFileSync(join(source,'data/config',name),join(config,name))
if (existsSync(join(source,'Local State'))) copyFileSync(join(source,'Local State'),join(isolated,'Local State'))
app.setPath('userData', isolated)
app.whenReady().then(async () => {
  const report: { passed: boolean; model?: string; connection?: string; checks: Array<{ name: string; passed: boolean }>; replies: Array<{ task: string; model: string; text: string; finishReason: string }>; error?: string; isolated: string } = { passed: false, checks: [], replies: [], isolated: relative(process.cwd(),isolated) }
  const check = (name: string, passed: boolean) => { report.checks.push({ name, passed }); if (!passed) throw new Error(name) }
  try {
    const { createSpatialGroupAiService } = await import('../electron/services/spatialGroupAiService')
    const { spatialService } = await import('../electron/services/spatialService')
    const { spatialContextService } = await import('../electron/services/spatialContextService')
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
    const frozen = JSON.stringify(confirmed.snapshot), readonlyRequests: Array<{ mode: string; params: ChatParams }> = []
    const plan = resolveGenerationTaskBudget({ task: 'spatial_instruction', model: profile.model, userHardCap: 600, reasoningLevel: 'off' })
    for (const chatMode of ['mention','polling','free'] as const) for (const narrativeMode of ['immersive','omniscient'] as const) {
      group = {...group,chatMode}; await groupData.saveGroup(group); await groupData.updateSession(scope.groupId,scope.sessionId,{ narrativeMode })
      const projection = await spatialContextService.readGroup(scope,chatMode === 'free' ? undefined : 'char-a')
      check(`${chatMode}/${narrativeMode}读取当前位置范围`, !!projection && projection.text.includes('茶馆') && (!projection.text.includes('渡口') || narrativeMode === 'omniscient' || chatMode === 'free'))
      readonlyRequests.push({ mode: `${chatMode}/${narrativeMode}`, params: { requestId: randomUUID(), provider: profile.provider as ChatParams['provider'], model: profile.model, baseUrl: profile.baseUrl, apiKey: profile.apiKey, stream: false, temperature: 0.2, topP: 1, maxTokens: plan.requestMaxTokens, frequencyPenalty: 0, presencePenalty: 0,
        reasoningGate: {level: plan.reasoningGate.level,knob: plan.reasoningGate.knob,tokens: plan.reasoningGate.gateTokens}, messages: [
          {role:'system',content:`你正在进行青石城夜谈群聊。成员有林雪、阿远、小岚。当前发言模式 ${chatMode}，叙事模式 ${narrativeMode}。${projection!.text}`},
          {role:'user',content:chatMode === 'free' ? '请用一两句话描述当前成员的位置与交流场景，不安排任何移动。' : '林雪现在在哪里？只描述她当前所在地点，不安排移动、不采用旧设定。'},
        ] } })
    }
    const readonlyResults = await Promise.all(readonlyRequests.map(async item=>({mode:item.mode,reply:await complete(item.params,new AbortController().signal,60000)})))
    for (const {mode,reply} of readonlyResults) check(`${mode}真实只读回复采用已确认地点`, reply.finishReason === 'stop' && reply.text.includes('茶馆') && !/"operations"|"move_actor"/.test(reply.text))
    check('六种正文只读请求不写回画板', JSON.stringify(await spatialService.loadGroupBound(scope.groupId,scope.sessionId)) === frozen)
    const second = await ai.get({...scope,sessionId:'second-session'}); check('群聊会话助手隔离',second.id !== applied.state.id && second.messages.length === 0)
    const backup = join(isolated,'group-stage1.zip'); createBackupV2(backup); ai.suspendRestore()
    try { restoreBackupV2(backup) } finally { ai.resumeRestore() }
    check('正式画板和独立助手可备份恢复',JSON.stringify(await spatialService.loadGroupBound(scope.groupId,scope.sessionId)) === frozen && (await ai.get(scope)).proposals.find(item=>item.id === moved.proposals.at(-1)!.id)?.status === 'applied')
    group = {...group, memberIds: group.memberIds.filter(id=>id !== 'char-b')}; await groupData.saveGroup(group)
    check('移出成员不再进入正文空间投影',!(await spatialContextService.readGroup(scope))?.text.includes('阿远'))
    check('主聊天历史未被画板助手污染',groupData.readMessages(scope.groupId,scope.sessionId).length === 0)
    report.passed = true
  } catch (error) { report.error = error instanceof Error ? error.message : String(error) }
  finally {
    for (const path of [join(config,'settings.json'),join(config,'credentials.json'),join(isolated,'Local State')]) if (existsSync(path)) unlinkSync(path)
    writeFileSync(join(output,'model-report.json'),JSON.stringify(report,null,2))
    console.log(JSON.stringify({passed:report.passed,model:report.model,completedModelCalls:report.replies.length,checks:report.checks.length,error:report.error}))
    app.exit(report.passed ? 0 : 1)
  }
})
