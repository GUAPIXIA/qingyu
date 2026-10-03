/** 对阶段2隔离联验中断批次进行显式重试，继续最后一个轮询视角；不改用户数据。 */
import { app, BrowserWindow } from 'electron'
import { join, resolve, relative } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { initLogger, LogLevel } from '../electron/services/logger'
import type { AICompletion, ChatParams, GroupMessage } from '../shared/types'
import type { SpatialSnapshot } from '../shared/spatial'
import type { SpatialCoreState } from '@qingyu/spatial-core'
const output=resolve('output/spatial-group-stage2'), isolated=resolve(process.argv[2]??'')
if(!isolated.startsWith(output+'\\')&&!isolated.startsWith(output+'/'))throw Error('补验目录必须位于阶段2隔离输出中')
const config=join(isolated,'data/config'),source=process.env.SPATIAL_MODEL_SOURCE||'C:/Users/Administrator/AppData/Roaming/qingyu'
mkdirSync(config,{recursive:true});for(const name of ['settings.json','credentials.json'])copyFileSync(join(source,'data/config',name),join(config,name));copyFileSync(join(source,'Local State'),join(isolated,'Local State'))
app.setPath('userData',isolated)
app.whenReady().then(async()=>{
  initLogger(isolated, LogLevel.DEBUG, { console: false })
  // 原生桌面有窗口；补验也保持 Chromium 消息循环活跃，避免无窗口进程的流式等待停滞。
  const host = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
  host.webContents.on('console-message',()=>{})
  await host.loadURL('data:text/html,<script>setInterval(()=>console.log("bench-heartbeat"),100)</script>')
  const previous=JSON.parse(readFileSync(join(output,'model-report.json'),'utf8'))
  copyFileSync(join(output,'model-report.json'),join(output,`model-before-resume-${Date.now()}.json`))
  const report:{passed:boolean;model?:string;connection?:string;checks:Array<{name:string;passed:boolean}>;replies:Array<{task:string;model:string;text:string;finishReason:string}>;error?:string;isolated:string;priorFailure?:string;benchmarkInterrupted?:boolean;verifiedModes?:string[]}={...previous,passed:false,error:undefined,benchmarkInterrupted:false,priorFailure:previous.error,checks:previous.checks.filter((item:{passed:boolean})=>item.passed),isolated:relative(process.cwd(),isolated)}
  const check=(name:string,passed:boolean)=>{report.checks.push({name,passed});writeFileSync(join(output,'model-progress.json'),JSON.stringify(report,null,2));if(!passed)throw Error(name)}
  try{
    const {createSpatialGroupAiService}=await import('../electron/services/spatialGroupAiService')
    const {spatialService}=await import('../electron/features/spatial/commitService')
    const {groupData,registerGroupIPC}=await import('../electron/ipc/group')
    const {readChatSettings,resolveChatProfile}=await import('../electron/services/chatConnection')
    const {chatWithRetry,getAdapter,registerAIIPC}=await import('../electron/services/ai')
    const {createBackupV2,restoreBackupV2}=await import('../electron/services/backup')
    const {resolveGenerationTaskBudget}=await import('../shared/generationTaskBudget')
    const profile=resolveChatProfile(readChatSettings())!
    check('补验继续沿用原连接模型',profile.model===report.model&&profile.name===report.connection)
    const complete=async(params:ChatParams,signal:AbortSignal,timeout:number):Promise<AICompletion>=>{
      check('补验功能请求沿用当前有效连接模型',params.model===profile.model&&params.baseUrl===profile.baseUrl&&params.provider===profile.provider&&params.apiKey===profile.apiKey)
      const completion=await chatWithRetry(getAdapter(params.provider),params,()=>{},signal,0,undefined,timeout)
      report.replies.push({task:params.observability?.taskType??'aux',model:params.model,text:completion.text,finishReason:completion.finishReason});return completion
    }
    const ai=createSpatialGroupAiService({complete}),scope={kind:'group' as const,groupId:'bench-group',sessionId:'bench-session'}
    const before=await ai.get(scope),failed=before.tasks.filter(item=>item.mode==='dialogue_sync'&&item.state==='failed').at(-1)!
    const recovered = before.proposals.find(item=>item.dialogueId===failed.dialogueId&&item.status==='applied')
    let latest=(await spatialService.loadGroupBound(scope.groupId,scope.sessionId))!
    let current=before,proposal=recovered!
    if(!recovered){
      check('首次失败没有待确认移动',!!failed&&!before.proposals.some(item=>item.dialogueId===failed.dialogueId))
      await ai.dialogue.retry(scope,failed.id);await ai.dialogue.drain(scope)
      current=await ai.get(scope);proposal=current.proposals.find(item=>item.dialogueId===failed.dialogueId)!
      check('轮询沉浸显式重试成功且仍需确认',current.tasks.at(-1)?.state==='completed'&&proposal?.status==='pending'&&proposal.commands.length>0&&(await spatialService.loadGroupBound(scope.groupId,scope.sessionId))?.version.runtimeRevision===latest.version.runtimeRevision)
      latest=(await ai.apply(scope,proposal.id,true)).snapshot
    }else check('补验恢复此前已确认的轮询沉浸重试结果',before.tasks.some(item=>item.dialogueId===failed.dialogueId&&item.state==='completed'))
    const position=(snapshot:SpatialSnapshot,id:string)=>{const {world,runtime}=snapshot as SpatialSnapshot&SpatialCoreState;const actor=world.actors.find(item=>item.externalRef.id===id)!;return world.nodes.find(node=>node.id===runtime.placements.find(item=>item.actorId===actor.id)?.anchor.nodeId)?.name}
    check('轮询沉浸确认采用最终位置',position(latest,'char-a')==='渡口'&&position(latest,'char-b')==='渡口')
    const handlers=new Map<string,(...args:unknown[])=>unknown>(),ipc={handle:(channel:string,handler:(...args:unknown[])=>unknown)=>handlers.set(channel,handler)}
    registerAIIPC(ipc as unknown as Parameters<typeof registerAIIPC>[0]);registerGroupIPC(ipc as unknown as Parameters<typeof registerGroupIPC>[0])
    await groupData.updateSession(scope.groupId,scope.sessionId,{narrativeMode:'omniscient'})
    const user:GroupMessage={id:randomUUID(),groupId:scope.groupId,characterId:'__user__',content:'请描述林雪已经回到青石城茶馆。阿远仍在渡口。',images:[],timestamp:Date.now(),round:1,narrativeMode:'omniscient'}
    await handlers.get('group:saveMessage')!({},scope.groupId,scope.sessionId,user)
    for(const batch of before.groupDialogueBatches??[])if(!batch.closed)await ai.dialogue.close(scope,batch.id)
    const burstId=randomUUID(),plan=resolveGenerationTaskBudget({task:'group_reply',model:profile.model,userHardCap:1024,reasoningLevel:'off'})
    for(const [characterId,content]of[['char-a','只写一个完整句子：林雪已经回到了青石城的茶馆。其他人不移动。'],['char-b','只写一个完整句子：阿远仍在青石城的渡口。']]){
      const generationId=randomUUID();check('轮询全知发送前捕获',await ai.dialogue.capture(scope,{generationId,burstId,kind:'normal',expectedVersion:latest.version,targetCharacterId:characterId})===burstId)
      let body='',reason='unknown'
      const sender={isDestroyed:()=>false,send:(channel:string,payload:{text?:string;finishReason?:string})=>{if(channel==='ai:chunk')body+=payload.text??'';if(channel==='ai:done')reason=payload.finishReason??'unknown'}}
      const params:ChatParams={requestId:generationId,provider:profile.provider as ChatParams['provider'],model:profile.model,baseUrl:profile.baseUrl,apiKey:profile.apiKey,stream:false,temperature:0.1,topP:1,maxTokens:plan.requestMaxTokens,frequencyPenalty:0,presencePenalty:0,messages:[{role:'system',content:'你是群聊故事叙述者，精确描述指定的已完成动作。'}, {role:'user',content}],observability:{source:'group',taskType:'group_reply',sessionId:scope.sessionId},reasoningGate:{level:plan.reasoningGate.level,knob:plan.reasoningGate.knob,tokens:plan.reasoningGate.gateTokens}}
      let watchdog!:ReturnType<typeof setTimeout>
      const expired=new Promise<never>((_resolve,reject)=>{watchdog=setTimeout(()=>{void handlers.get('ai:cancel')!({},generationId,'timeout');reject(Error('补验正文请求超时'))},90000)})
      try{await Promise.race([handlers.get('ai:chat')!({sender},params),expired])}finally{clearTimeout(watchdog)}
      report.replies.push({task:'group_reply',model:profile.model,text:body,finishReason:reason});check('轮询全知正文完整成功',reason==='stop'&&body.length>0)
      const message:GroupMessage={id:randomUUID(),groupId:scope.groupId,characterId,content:body,images:[],timestamp:Date.now(),round:2,narrativeMode:'omniscient',spatialGroupGenerationId:generationId}
      await handlers.get('group:saveMessage')!({},scope.groupId,scope.sessionId,message);await ai.dialogue.register(scope,generationId,[message.id])
    }
    const calls=report.replies.filter(item=>item.task==='spatial_dialogue_sync').length
    await ai.dialogue.close(scope,burstId);await ai.dialogue.drain(scope);current=await ai.get(scope);proposal=current.proposals.find(item=>item.dialogueId===burstId)!
    check('轮询全知整批只提取一次',current.tasks.at(-1)?.state==='completed'&&report.replies.filter(item=>item.task==='spatial_dialogue_sync').length===calls+1)
    check('轮询全知仍需确认',proposal?.status==='pending'&&proposal.commands.length>0&&(await spatialService.loadGroupBound(scope.groupId,scope.sessionId))?.version.runtimeRevision===latest.version.runtimeRevision)
    latest=(await ai.apply(scope,proposal.id,true)).snapshot;check('轮询全知确认采用最终位置',position(latest,'char-a')==='茶馆'&&position(latest,'char-b')==='渡口')
    await ai.dialogue.close(scope,burstId);await ai.dialogue.drain(scope);check('轮询重复通知不重复提取',report.replies.filter(item=>item.task==='spatial_dialogue_sync').length===calls+1)
    const frozen=JSON.stringify(latest),backup=join(isolated,'group-stage2.zip');createBackupV2(backup);ai.suspendRestore();try{restoreBackupV2(backup)}finally{ai.resumeRestore()}
    await ai.dialogue.recover();await ai.dialogue.drain(scope);check('群聊批次备份恢复不重发模型且保留位置',JSON.stringify(await spatialService.loadGroupBound(scope.groupId,scope.sessionId))===frozen&&report.replies.filter(item=>item.task==='spatial_dialogue_sync').length===calls+1)
    check('群聊助手未写入主聊天历史',groupData.readMessages(scope.groupId,scope.sessionId).every(message=>!message.content.includes('schemaVersion')&&!message.content.includes('需确认后应用')))
    report.verifiedModes=['mention/immersive','mention/omniscient','free/immersive','free/omniscient','polling/immersive','polling/omniscient'];report.passed=true
  }catch(error){report.error=error instanceof Error?error.message:String(error)}finally{
    host.destroy()
    for(const path of[join(config,'settings.json'),join(config,'credentials.json'),join(isolated,'Local State')])if(existsSync(path))unlinkSync(path)
    writeFileSync(join(output,'model-report.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1)
  }
})
