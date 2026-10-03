// 群聊空间画板阶段 3 联验：未知地点核对、地点创建、撤销与冲突重核对。
// 公共设施（Vite/Playwright/就绪/收尾）来自 lib/browserHarness.mjs；本文件只保留 mock 与断言。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { runBrowserSession } from './lib/browserHarness.mjs'

const port = 5183
const output = resolve('output/playwright/spatial-group-stage3')
await mkdir(output, { recursive: true })
await writeFile(join(output, 'host.tsx'), `import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/index.css';
import {GroupChatPage} from '/src/pages/GroupChatPage';
import {installPreviewMock} from '/src/lib/preview';
import {useGroupChatStore} from '/src/store/useGroupChatStore';
import {useCharacterStore} from '/src/store/useCharacterStore';
import {usePersonaStore} from '/src/store/usePersonaStore';
import {createWorldWithDefaults,createEmptyRuntime,applyCommandBatch} from '@qingyu/spatial-core';
installPreviewMock();
const avatar='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" rx="30" fill="#8265b5"/><text x="30" y="39" font-size="28" fill="white" text-anchor="middle">A</text></svg>');
const characters=['char-a','char-b'].map((id,i)=>({...useCharacterStore.getState().createCharacter(),id,name:i?'大本':'Aiko',avatar,firstMessage:'',groupOnlyGreetings:[]}));
const personas=[{id:'persona-a',name:'旅人',avatar,description:'',persona:''}];
const groups=['group-a','group-b'].map(id=>({id,name:id==='group-a'?'夜谈会':'另一群',memberIds:['char-a','char-b'],currentSpeakerIndex:0,autoMode:false,chatMode:'polling',maxRounds:1,speakerInterval:100,lorebookIds:[],presetId:null,systemPrompt:'',createdAt:1,updatedAt:1}));
const sessions=Object.fromEntries(groups.map(group=>[group.id,['session-a','session-b'].map(id=>({id,groupId:group.id,title:id==='session-a'?'初次见面':'第二场',messageCount:0,createdAt:1,updatedAt:1,personaId:'persona-a'}))]));
let world=null,worldRevision=0;
const snapshots=new Map(),listeners=new Set(),enabled=new Set();
const key=(g,s)=>g+'/'+s;
const snapshot=(g,s)=>{const saved=snapshots.get(key(g,s));if(!saved)return null;return {...saved,world,version:{...saved.version,worldFingerprint:'world-'+worldRevision},activeActorIds:world.actors.filter(actor=>actor.externalRef.type==='qingyu-persona'||groups.find(item=>item.id===g).memberIds.includes(actor.externalRef.id)).map(actor=>actor.id)}};
const blank=(g,s)=>{const snap=snapshot(g,s);return !snap||(snap.runtime.placements.length===0&&snap.world.nodes.every(node=>node.tags.includes('system:offstage')))};
const host=window.host={current:()=>({groupId:useGroupChatStore.getState().currentGroup?.id,sessionId:useGroupChatStore.getState().currentSessionId}),loads:[],commits:[],aiCalls:0,hold:false,releases:[],read:(g='group-a',s='session-a')=>snapshot(g,s),switchSession:s=>useGroupChatStore.getState().switchSession(useGroupChatStore.getState().currentGroup.id,s),selectGroup:g=>useGroupChatStore.getState().selectGroup(g),mode:mode=>useGroupChatStore.setState(state=>({currentGroup:{...state.currentGroup,chatMode:mode}})),streaming:active=>useGroupChatStore.setState({isStreaming:active}),remove:id=>{groups[0].memberIds=groups[0].memberIds.filter(member=>member!==id);useGroupChatStore.setState({currentGroup:{...groups[0]}});listeners.forEach(listener=>listener({kind:'group',groupId:'group-a',sessionId:'session-a',worldId:world.id,commitId:crypto.randomUUID()}))},release:()=>{host.hold=false;host.releases.splice(0).forEach(resolve=>resolve())}};
const bind=async(g,s)=>{if(!world){world=createWorldWithDefaults('shared-world','青石城',{now:1});world.actors=[{id:'actor-a',kind:'character',displayName:'Aiko',externalRef:{type:'qingyu-character',id:'char-a'}},{id:'actor-b',kind:'character',displayName:'大本',externalRef:{type:'qingyu-character',id:'char-b'}},{id:'actor-user',kind:'persona',displayName:'旅人',externalRef:{type:'qingyu-persona',id:'persona-a'}}]}
const runtime=createEmptyRuntime(world.id,'runtime-'+g+'-'+s,1);snapshots.set(key(g,s),{world,runtime,version:{worldId:world.id,runtimeId:runtime.runtimeId,bindingEpoch:'epoch-'+g+'-'+s,runtimeRevision:0,worldFingerprint:'world-'+worldRevision}});return snapshot(g,s)};
window.api.persona.list=async()=>personas;window.api.group.list=async()=>groups;window.api.group.listSessions=async g=>sessions[g];window.api.group.listMessages=async()=>[];
Object.assign(window.api.spatial,{loadGroupBound:async(g,s)=>{host.loads.push(key(g,s));return enabled.has(key(g,s))?snapshot(g,s):null},setGroupEnabled:async(g,s,on)=>{if(!on){enabled.delete(key(g,s));return null}if(!enabled.has(key(g,s))){enabled.add(key(g,s));return bind(g,s)}return snapshot(g,s)},listWorlds:async()=>world?[{id:world.id,name:world.name,updatedAt:1}]:[],onUpdated:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},getAiSession:async()=>{host.aiCalls++;throw Error('群聊阶段0不应调用AI')},loadBound:async()=>{throw Error('群聊不应读取单聊')},applyGroupEditorBatch:async(g,s,input)=>{
host.commits.push({groupId:g,sessionId:s,input});if(host.hold)await new Promise(resolve=>host.releases.push(resolve));const before=snapshot(g,s);if(input.runtimeId!==before.version.runtimeId||input.bindingEpoch!==before.version.bindingEpoch||input.expectedRuntimeRevision!==before.version.runtimeRevision||input.expectedWorldFingerprint!==before.version.worldFingerprint)return {ok:false,code:'version_conflict',message:'版本冲突',snapshot:before};
const result=applyCommandBatch(before,{schemaVersion:1,expectedRevision:input.expectedRuntimeRevision,commands:input.commands},{source:'user',now:Date.now(),idGen:()=>crypto.randomUUID()});if(!result.ok)return result;world=result.state.world;worldRevision++;snapshots.set(key(g,s),{...result.state,version:{...before.version,runtimeRevision:result.state.runtime.revision}});return {ok:true,snapshot:snapshot(g,s),duplicate:false,receipt:{commitId:input.commitId,revisionBefore:before.runtime.revision,revisionAfter:result.state.runtime.revision,worldFingerprintAfter:'world-'+worldRevision}};
}});

const aiStates=new Map(),aiListeners=new Set();host.aiRequests=[];host.applies=0;host.draftEdits=0;
const aiState=(g,s)=>{const id=key(g,s);if(!aiStates.has(id))aiStates.set(id,{schemaVersion:1,id:'ai-'+g+'-'+s,scope:{kind:'group',groupId:g,sessionId:s},messages:[],proposals:[],tasks:[],createdAt:1,updatedAt:1});return aiStates.get(id)};
const emitAi=(g,s)=>aiListeners.forEach(listener=>listener({kind:'group',groupId:g,sessionId:s}));
const versioned=(core,g,s,draft=false)=>({...core,activeActorIds:core.world.actors.filter(actor=>actor.externalRef.type==='qingyu-persona'||groups.find(group=>group.id===g).memberIds.includes(actor.externalRef.id)).map(actor=>actor.id),version:{worldId:core.world.id,runtimeId:core.runtime.runtimeId,bindingEpoch:(draft?'draft-':'epoch-')+g+'-'+s,runtimeRevision:core.runtime.revision,worldFingerprint:(draft?'draft-':'world-')+(draft?core.runtime.revision:worldRevision)}});
Object.assign(window.api.spatial,{
getGroupAiSession:async(g,s)=>structuredClone(aiState(g,s)),onAiUpdated:listener=>{aiListeners.add(listener);return()=>aiListeners.delete(listener)},
groupInitializationSources:async(g,s)=>({sources:[{id:'group:setting',kind:'group',label:'群聊公共设定',text:'青石城有茶馆与渡口'}],members:groups.find(group=>group.id===g).memberIds.map(id=>({id,name:characters.find(character=>character.id===id).name})),loreEntries:[],sharedSessions:1,canInitialize:blank(g,s)}),
askGroupAi:async(g,s,input)=>{host.aiRequests.push({g,s,input});const state=aiState(g,s);state.messages.push({id:crypto.randomUUID(),role:'user',mode:input.mode,content:input.text||'初始化群聊',createdAt:Date.now()});const task={id:input.requestId,mode:input.mode,state:'running',model:'当前聊天模型',startedAt:Date.now()};state.tasks.push(task);emitAi(g,s);
if(host.aiHold)return await new Promise(resolve=>host.aiFinish=()=>resolve(structuredClone(state)));
let preview,commands=[];if(input.mode==='initialize'){
let worldDraft=createWorldWithDefaults('ai-world','青石城',{now:1});worldDraft.actors=structuredClone(world.actors);const runtime=createEmptyRuntime(worldDraft.id,'runtime-'+g+'-'+s,1);
const nodes=['茶馆','渡口'].map((name,i)=>({type:'create_node',payload:{id:i?'dock':'tea',boardId:worldDraft.rootBoardId,parentNodeId:null,childBoardId:null,kind:'place',name,description:'',geometry:{x:420+i*460,y:280},tags:[],iconKey:'pin',createdAt:1,updatedAt:1}}));
const places=worldDraft.actors.filter(actor=>actor.externalRef.type==='qingyu-character'&&input.memberIds.includes(actor.externalRef.id)).map(actor=>({type:'place_actor',actorId:actor.id,placement:{boardId:worldDraft.rootBoardId,anchor:{kind:'node',nodeId:'tea'},semanticPosition:{precision:'inside-only'}}}));
const result=applyCommandBatch({world:worldDraft,runtime},{schemaVersion:1,expectedRevision:0,commands:[...nodes,...places]},{source:'system',now:1,idGen:()=>crypto.randomUUID()});if(!result.ok)throw Error(result.message);preview=versioned(result.state,g,s,true);
}else{const before=snapshot(g,s),actorId='actor-a';const old=before.runtime.placements.find(placement=>placement.actorId===actorId);commands=[{type:'move_actor',actorId,from:{revision:old.revision},to:{boardId:world.rootBoardId,anchor:{kind:'node',nodeId:'dock'},semanticPosition:{precision:'inside-only'}}}]}
const proposal={id:crypto.randomUUID(),commitId:crypto.randomUUID(),mode:input.mode,status:'pending',explanation:'群聊调整等待确认',summary:[input.mode==='initialize'?'茶馆和渡口，成员起点未知则保留未放置':'Aiko → 渡口'],unresolved:[],evidence:[],sources:[],sourceOptions:{text:input.text,loreEntryIds:[]},commands,preview,baseVersion:input.mode==='initialize'?null:snapshot(g,s).version,createdAt:Date.now()};state.proposals.push(proposal);state.messages.push({id:crypto.randomUUID(),role:'assistant',mode:input.mode,content:proposal.explanation,createdAt:Date.now()});task.state='completed';emitAi(g,s);return structuredClone(state)},
editGroupDraft:async(g,s,id,input)=>{host.draftEdits++;const proposal=aiState(g,s).proposals.find(item=>item.id===id);const result=applyCommandBatch(proposal.preview,{schemaVersion:1,expectedRevision:input.expectedRuntimeRevision,commands:input.commands},{source:'user',now:Date.now(),idGen:()=>crypto.randomUUID()});if(!result.ok)return result;proposal.preview=versioned(result.state,g,s,true);return {ok:true,snapshot:proposal.preview,receipt:{commitId:input.commitId,revisionBefore:input.expectedRuntimeRevision,revisionAfter:proposal.preview.runtime.revision,worldFingerprintAfter:proposal.preview.version.worldFingerprint},duplicate:false}},
applyGroupProposal:async(g,s,id)=>{host.applies++;const state=aiState(g,s),proposal=state.proposals.find(item=>item.id===id);let core=proposal.preview;if(!core){const before=snapshot(g,s);const result=applyCommandBatch(before,{schemaVersion:1,expectedRevision:before.runtime.revision,commands:proposal.commands},{source:'user',now:Date.now(),idGen:()=>crypto.randomUUID()});if(!result.ok)throw Error(result.message);core=result.state}world=core.world;worldRevision++;snapshots.set(key(g,s),versioned(core,g,s));proposal.status='applied';emitAi(g,s);return {state:structuredClone(state),snapshot:snapshot(g,s)}},
cancelGroupAi:async(g,s)=>{const state=aiState(g,s);state.tasks.at(-1).state='cancelled';host.aiHold=false;host.aiFinish?.();emitAi(g,s);return structuredClone(state)},
discardGroupProposal:async(g,s,id)=>{const state=aiState(g,s);state.proposals.find(item=>item.id===id).status='discarded';emitAi(g,s);return structuredClone(state)},
});

host.injectDialogue=(g,s)=>{const state=aiState(g,s),core=snapshot(g,s),actor=core.world.actors[0],old=core.runtime.placements.find(item=>item.actorId===actor.id),target=core.world.nodes.find(node=>node.id==='tea');state.tasks.push({id:'story-task',mode:'dialogue_sync',state:'completed',startedAt:1});state.proposals.push({id:'story-proposal',commitId:'story-commit',mode:'dialogue_sync',status:'pending',summary:[actor.displayName+' → 茶馆'],explanation:'已保存剧情的位置建议',unresolved:[],sources:[{id:'assistant',label:'已保存正文',kind:'message',text:actor.displayName+'已经回到茶馆。'}],evidence:[{sourceId:'assistant',quote:actor.displayName+'已经回到茶馆。'}],baseVersion:core.version,commands:[{type:'move_actor',actorId:actor.id,from:{revision:old.revision},to:{boardId:target.boardId,anchor:{kind:'node',nodeId:target.id},semanticPosition:{precision:'inside-only'}}}],comparisons:[{actorName:actor.displayName,currentPath:'渡口',targetPath:'茶馆'}],createdAt:Date.now()});emitAi(g,s)};
host.injectFailure=(g,s)=>{aiState(g,s).tasks.push({id:'story-failed',mode:'dialogue_sync',state:'failed',error:'提取输出不完整',startedAt:1});emitAi(g,s)};
window.api.spatial.retryGroupDialogue=async(g,s,id)=>{host.retryOwner=[g,s,id];aiState(g,s).tasks.find(task=>task.id===id).state='completed';emitAi(g,s)};
window.api.group.updateSession=async(g,s,updates)=>{Object.assign(sessions[g].find(item=>item.id===s),updates);if('spatialContextEnabled' in updates)host.contextEnabled=updates.spatialContextEnabled;host.syncPolicy=updates.spatialNarrativeSyncPolicy};


const priorApply=window.api.spatial.applyGroupProposal;
window.api.spatial.applyGroupProposal=async(g,s,id)=>{const state=aiState(g,s),proposal=state.proposals.find(item=>item.id===id),before=snapshot(g,s);if(proposal.status==='applied')return {state:structuredClone(state),snapshot:before};if(before&&!proposal.preview){const result=applyCommandBatch(before,{schemaVersion:1,expectedRevision:before.runtime.revision,commands:proposal.commands},{source:'user',now:Date.now(),idGen:()=>crypto.randomUUID()});if(!result.ok)throw Error(result.message);proposal.inverse=result.inverse}const result=await priorApply(g,s,id);proposal.appliedVersion=result.snapshot.version;useGroupChatStore.setState(current=>current.currentGroup?.id===g?{sessions:current.sessions.map(item=>item.id===s?{...item,spatialWorldId:world.id,spatialRuntimeId:result.snapshot.version.runtimeId,spatialAiSessionId:state.id}:item)}:{});if(proposal.placeForId){const original=state.proposals.find(item=>item.id===proposal.placeForId);original.status='stale';original.canReview=true;original.staleReason='画板版本已改变，请按当前位置重新核对'}emitAi(g,s);return {state:structuredClone(state),snapshot:result.snapshot}};
window.api.spatial.groupProposalTargets=async(g,s)=>snapshot(g,s)?.world.nodes.filter(node=>!node.tags.includes('system:offstage')).map(node=>({id:node.id,boardId:node.boardId,path:'青石城 / '+node.name,canContain:node.kind==='region'}))??[];
window.api.spatial.reviewGroupProposal=async(g,s,id,input)=>{host.reviewOwner=[g,s,id,input];const state=aiState(g,s),original=state.proposals.find(item=>item.id===id),core=snapshot(g,s),candidate=original.dialogueCandidates[0],target=core.world.nodes.find(node=>node.id===(input.targets[candidate.id]??candidate.targetNodeId)),placement=core.runtime.placements.find(item=>item.actorId===candidate.actorId);if(!target)throw Error('请选择完整地点');const reviewed={...original,id:crypto.randomUUID(),commitId:crypto.randomUUID(),status:'pending',canReview:false,staleReason:undefined,replacedById:undefined,reviewedFromId:original.id,baseVersion:core.version,commands:[{type:'move_actor',actorId:candidate.actorId,from:{revision:placement.revision},to:{boardId:target.boardId,anchor:{kind:'node',nodeId:target.id},semanticPosition:{precision:'inside-only'}}}],summary:['Aiko → '+target.name],unresolved:[],dialogueCandidates:[{...candidate,targetNodeId:target.id}],comparisons:[{actorName:'Aiko',currentPath:'青石城 / '+core.world.nodes.find(node=>node.id===placement.anchor.nodeId).name,targetPath:'青石城 / '+target.name}]};original.status='stale';original.canReview=false;original.replacedById=reviewed.id;state.proposals.push(reviewed);emitAi(g,s);return structuredClone(state)};
window.api.spatial.prepareGroupPlace=async(g,s,id,name,parentId)=>{host.placeOwner=[g,s,id,name,parentId];const state=aiState(g,s),original=state.proposals.find(item=>item.id===id),nodeId=crypto.randomUUID();state.proposals.push({id:crypto.randomUUID(),commitId:crypto.randomUUID(),mode:'instruction',status:'pending',placeForId:id,summary:['创建地点：'+name+'（不移动人物）'],explanation:'手动地点创建',unresolved:[],evidence:[],sources:[],baseVersion:snapshot(g,s).version,createdAt:Date.now(),commands:[{type:'create_node',payload:{id:nodeId,kind:'place',name,parentNodeId:parentId,childBoardId:null,boardId:world.rootBoardId,description:'',tags:[],geometry:{x:400,y:520},iconKey:'pin',createdAt:1,updatedAt:1}}]});emitAi(g,s);return structuredClone(state)};
window.api.spatial.undoGroupProposal=async(g,s,id)=>{host.undoOwner=[g,s,id];const state=aiState(g,s),proposal=state.proposals.find(item=>item.id===id),before=snapshot(g,s);if(JSON.stringify(proposal.appliedVersion)!==JSON.stringify(before.version))throw Error('剧情提交后画板已有其他修改，不能覆盖当前位置');const result=applyCommandBatch(before,{schemaVersion:1,expectedRevision:before.runtime.revision,commands:[...proposal.inverse].reverse()},{source:'story',now:Date.now(),idGen:()=>crypto.randomUUID()});if(!result.ok)throw Error(result.message);world=result.state.world;worldRevision++;snapshots.set(key(g,s),versioned(result.state,g,s));proposal.status='undone';emitAi(g,s);return {state:structuredClone(state),snapshot:snapshot(g,s)}};
host.unknown=()=>{const g='group-b',s='session-b',state=aiState(g,s);state.proposals=[];state.messages=[];state.tasks=[{id:'batch-task',mode:'dialogue_sync',state:'completed',startedAt:1}];state.proposals.push({id:'unknown-story',commitId:'unknown-commit',mode:'dialogue_sync',status:'pending',summary:[],explanation:'未知地点建议',unresolved:['旧桥未收录'],evidence:[{sourceId:'assistant',quote:'Aiko 已经到达旧桥。'}],sources:[{id:'assistant',label:'已保存正文',text:'Aiko 已经到达旧桥。'}],commands:[],baseVersion:snapshot(g,s).version,dialogueCandidates:[{id:'candidate',actorId:'actor-a',targetText:'旧桥',completed:true,eligible:true,evidenceSource:'assistant',evidence:'Aiko 已经到达旧桥。',note:'',reason:'地图未收录'}],createdAt:Date.now()});emitAi(g,s)};
host.changed=()=>{const state=aiState('group-b','session-b');state.proposals.findLast(item=>item.mode==='dialogue_sync'&&item.status==='applied').sourceChanged=true;emitAi('group-b','session-b')};
host.conflict=()=>{const state=aiState('group-b','session-b'),original=state.proposals.findLast(item=>item.mode==='dialogue_sync'&&item.status==='applied'),core=snapshot('group-b','session-b');state.proposals.push({...original,id:'conflict',commitId:'conflict-commit',sourceChanged:false,status:'stale',canReview:true,staleReason:'画板版本已改变，请按当前位置重新核对',reviewedFromId:undefined,replacedById:undefined,dialogueCandidates:[{...original.dialogueCandidates[0],targetNodeId:'dock'}]});emitAi('group-b','session-b')};

useCharacterStore.setState({characters});usePersonaStore.setState({personas,loaded:true});useGroupChatStore.setState({groupChats:groups,currentGroup:groups[0],sessions:sessions['group-a'],currentSessionId:'session-a',messages:[],isStreaming:false});
document.body.style.margin='0';createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex'}}><GroupChatPage/></div>);
`)
await writeFile(join(output, 'host.html'), '<!doctype html><html><head><base href="/"></head><body><div id="root"></div><script type="module" src="/output/playwright/spatial-group-stage3/host.tsx"></script></body></html>')
const checks = []
const checked = name => checks.push(name)

await runBrowserSession({ port, run: async ({ page, errors }) => {
 try {
  await page.goto(`http://127.0.0.1:${port}/output/playwright/spatial-group-stage3/host.html`)
  // 新 UI：面板默认关闭，先开启「启用空间画布」，开启后自动创建并绑定画板（幂等）
  const open = async () => {
    await page.getByRole('button', { name: '群聊空间画板', exact: true }).click()
    const toggle = page.getByRole('switch', { name: '启用空间画布' })
    if (await toggle.isVisible().catch(() => false)) await toggle.click()
    await page.frameLocator('iframe').locator('.react-flow__pane').waitFor()
  }
  // 新 UI：AI 面板由 iframe 内「打开画板助手」触发（面板已开则跳过）
  const openAssistant = async () => {
    if (await page.getByRole('button', { name: '关闭画板助手' }).isVisible().catch(() => false)) return
    await page.frameLocator('iframe').getByRole('button', { name: '打开画板助手', exact: true }).click()
    await page.getByRole('button', { name: '关闭画板助手' }).waitFor()
  }
  // 正式世界是否仍为空白（替代旧「read 返回 null」的未绑定断言）
  const formalBlank = (g, s) => page.evaluate(([g, s]) => {
    const snap = window.host.read(g, s)
    return !snap || (snap.runtime.placements.length === 0 && snap.world.nodes.every(node => node.tags.includes('system:offstage')))
  }, [g, s])
  await page.getByRole('button', { name: '群聊空间画板', exact: true }).click()
  await page.getByRole('switch', { name: '启用空间画布' }).waitFor()
  assert.equal(await page.getByText('空间画布已关闭').count(), 1); checked('群聊页头入口与默认关闭')
  await page.getByRole('switch', { name: '启用空间画布' }).click()
  let frame = page.frameLocator('iframe')
  await frame.locator('.react-flow__pane').waitFor()
  checked('开启后自动创建并绑定画板')
  await frame.getByRole('button', { name: '角色托盘', exact: true }).click()
  await frame.getByText('Aiko', { exact: true }).waitFor()
  assert.equal(await frame.locator('.tray-item').count(), 3)
  assert.equal(await frame.locator('.tray-item img').count(), 3); checked('当前成员与用户身份头像')
  assert.equal(await frame.getByRole('button', { name: '打开画板助手', exact: true }).count(), 1)
  assert.equal(await frame.getByPlaceholder('新角色名').count(), 0); checked('群聊助手入口启用，角色创建仍由群设置管理')
  assert.equal((await page.evaluate(() => window.host.read())).runtime.placements.length, 0); checked('初始化位置未知')
  await frame.getByRole('button', { name: '放到当前画板：Aiko', exact: true }).click()
  await page.waitForFunction(() => window.host.read().runtime.placements.length === 1)
  assert.equal(await frame.getByRole('button', { name: '删除角色定义', exact: true }).count(), 0); checked('放置成员并保存，角色映射由群设置管理')
  await frame.getByRole('button', { name: '撤销', exact: true }).click()
  await page.waitForFunction(() => window.host.read().runtime.placements.length === 0)
  await frame.getByRole('button', { name: '重做', exact: true }).click()
  await page.waitForFunction(() => window.host.read().runtime.placements.length === 1); checked('手动撤销与重做落盘')
  await frame.getByRole('button', { name: '返回对话', exact: true }).click()
  await page.locator('iframe').waitFor({ state: 'detached' }); await open()
  frame = page.frameLocator('iframe'); await frame.locator('.rf-actor').waitFor()
  assert.equal((await page.evaluate(() => window.host.read())).runtime.placements.length, 1); checked('关闭重开位置保留')
  await frame.getByRole('button', { name: '角色托盘', exact: true }).click()
  await page.evaluate(() => window.host.hold = true)
  await frame.getByRole('button', { name: '放到当前画板：大本', exact: true }).click()
  await page.waitForFunction(() => window.host.releases.length === 1)
  await page.getByTitle('切换对话').click()
  await page.getByRole('button', { name: /^第二场/ }).click()
  assert.equal(await page.evaluate(() => window.host.current().sessionId), 'session-a')
  assert.equal(await page.evaluate(() => window.host.read('group-a', 'session-b')), null)
  assert.equal(await page.locator('iframe').count(), 1)
  await page.evaluate(() => window.host.release())
  await page.locator('iframe').waitFor({ state: 'detached' })
  assert.equal((await page.evaluate(() => window.host.read())).runtime.placements.length, 2); checked('切换会话等待未完成提交')
  // 同群新会话尚未启用画布：开启后自动绑定共享世界，位置为空（runtime 隔离）
  await open()
  frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: '角色托盘', exact: true }).click()
  assert.equal(await frame.locator('.rf-actor').count(), 0)
  assert.equal((await page.evaluate(() => window.host.read('group-a', 'session-b'))).runtime.placements.length, 0); checked('同群新会话共享世界且位置为空')
  await page.getByRole('button', { name: /^另一群/ }).click()
  await page.locator('iframe').waitFor({ state: 'detached' })
  await open()
  frame = page.frameLocator('iframe'); await frame.getByRole('button', { name: '角色托盘', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.host.read('group-b'))).runtime.placements.length, 0); checked('另一群共享世界且位置隔离')
  await page.getByRole('button', { name: /^夜谈会/ }).click()
  await page.locator('iframe').waitFor({ state: 'detached' }); await open()
  frame = page.frameLocator('iframe'); await frame.locator('.rf-actor').first().waitFor()
  await page.evaluate(() => window.host.remove('char-b'))
  await frame.getByRole('button', { name: '角色托盘', exact: true }).click()
  await frame.locator('.tray-item').filter({ hasText: '大本' }).waitFor({ state: 'detached' })
  assert.equal(await frame.locator('.rf-actor').count(), 1)
  assert.equal((await page.evaluate(() => window.host.read())).runtime.placements.length, 2); checked('移出成员从视图隐藏，历史位置保留')
  await page.screenshot({ path: join(output, 'group-board.png'), fullPage: true })
  await frame.getByRole('button', { name: '返回对话', exact: true }).click()
  await page.locator('iframe').waitFor({ state: 'detached' })
  for (const mode of ['mention', 'polling', 'free']) {
    await page.evaluate(mode => window.host.mode(mode), mode); await open()
    await page.frameLocator('iframe').getByRole('button', { name: '返回对话', exact: true }).click()
    await page.locator('iframe').waitFor({ state: 'detached' })
  }
  checked('点名、轮询、自由发言均可进入手动画板')
  await page.evaluate(() => window.host.streaming(true))
  assert.equal(await page.getByRole('button', { name: '群聊空间画板', exact: true }).isDisabled(), true)
  await page.evaluate(() => window.host.streaming(false)); checked('生成中禁止进入手动画板')
  assert.equal(await page.evaluate(() => window.host.aiCalls), 0)
  assert.equal(await page.evaluate(() => window.host.commits.every(item => item.groupId === 'group-a' && item.sessionId === 'session-a')), true); checked('接口归属正确且未触发模型会话')

  await page.evaluate(async()=>{await window.host.selectGroup('group-b');await window.host.switchSession('session-b')});await open();await openAssistant();
  await page.getByText('初始化来源 · 1 项').click();
  await page.getByRole('checkbox',{name:'大本 · 成员设定'}).uncheck();await page.getByRole('button',{name:'生成场景',exact:true}).click();
  frame=page.frameLocator('iframe');await frame.getByText('茶馆',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.host.aiRequests.at(-1).input.memberIds),['char-a']);
  assert.equal(await formalBlank('group-b','session-b'),true);checked('成员来源可选，生成群聊草稿不写正式世界');
  await frame.getByText('茶馆',{exact:true}).click();const name=frame.locator('.inspector .field').filter({has:frame.locator('label',{hasText:'名称（必填）'})}).locator('input').first();
  await name.fill('夜茶馆');await name.press('Tab');await page.waitForFunction(()=>window.host.draftEdits===1);
  assert.equal(await formalBlank('group-b','session-b'),true);checked('群聊初始化草稿可在画板修改');
  await page.getByRole('button',{name:'确认场景',exact:true}).click();await page.waitForFunction(()=>window.host.applies===1);frame=page.frameLocator('iframe');await frame.getByText('夜茶馆',{exact:true}).waitFor();
  checked('确认采用已修改草稿并绑定当前群会话');
  // 新 UI：同步设置在「同步设置」折叠区内，展开后可见剧情同步策略
  await page.getByText('同步设置',{exact:true}).click();
  assert.equal(await page.getByRole('combobox',{name:'剧情同步策略'}).locator('option').count(),2);await page.getByRole('combobox',{name:'剧情同步策略'}).selectOption('suggest');await page.waitForFunction(()=>window.host.syncPolicy==='suggest');checked('群聊剧情同步可选需确认且没有自动策略');
  await page.getByRole('textbox',{name:'画板助手输入'}).fill('把 Aiko 移到渡口');await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'应用',exact:true}).waitFor();assert.equal((await page.evaluate(()=>window.host.read('group-b','session-b'))).runtime.placements[0].anchor.nodeId,'tea');
  checked('独立群聊助手显式指令等待确认');
  await page.getByRole('button',{name:'应用',exact:true}).click();await page.waitForFunction(()=>window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId==='dock');checked('确认后指定成员移动生效');
  await page.getByRole('checkbox',{name:'对话读取位置'}).click();await page.waitForFunction(()=>window.host.contextEnabled===false);checked('群聊会话可关闭位置读取');
  await page.evaluate(()=>window.host.aiHold=true);await page.getByRole('textbox',{name:'画板助手输入'}).fill('先核对位置');await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'停止',exact:true}).click();await page.getByText('画板请求已停止；可修改输入后重新发送。').waitFor();checked('群聊助手可取消等待中的请求');

  await page.getByRole('checkbox',{name:'对话读取位置'}).click();await page.waitForFunction(()=>window.host.contextEnabled===true);
  await page.evaluate(()=>window.host.injectDialogue('group-b','session-b'));
  await page.getByText('剧情位置建议',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.host.read('group-b','session-b').world.nodes.find(node=>node.id===window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId).name),'渡口');checked('群聊剧情建议展示而当前位置保持');
  await page.getByRole('button',{name:'应用',exact:true}).click();await page.waitForFunction(()=>window.host.read('group-b','session-b').world.nodes.find(node=>node.id===window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId).name==='夜茶馆');checked('群聊剧情建议确认后才改变位置');assert.equal(await page.getByRole('button',{name:'撤销此次剧情更新'}).count(),1);
  await page.evaluate(()=>window.host.injectFailure('group-b','session-b'));await page.getByRole('button',{name:'重新提取本轮剧情'}).click();await page.waitForFunction(()=>window.host.retryOwner?.[2]==='story-failed');assert.deepEqual(await page.evaluate(()=>window.host.retryOwner),['group-b','session-b','story-failed']);checked('显式剧情重试归属当前群聊会话');
  await page.screenshot({path:join(output,'group-assistant.png'),fullPage:true});


  await page.evaluate(()=>window.host.unknown());
  await page.getByRole('combobox',{name:'选择已有地点：旧桥'}).waitFor();
  await page.getByRole('button',{name:'关闭画板助手'}).click();
  await page.frameLocator('iframe').getByRole('button',{name:'返回对话',exact:true}).click();await page.locator('iframe').waitFor({state:'detached'});
  await page.getByText('1 条位置建议待核对 · 继续发送将使用已确认位置').waitFor();
  assert.equal(await page.getByRole('button',{name:'应用并发送'}).count(),0);checked('聊天输入区一行群聊提示，无自动应用或单聊发送入口');
  await page.screenshot({path:join(output,'chat-notice.png'),fullPage:true});
  await page.getByRole('button',{name:'查看画板建议'}).click();await page.getByRole('combobox',{name:'选择已有地点：旧桥'}).waitFor();checked('点击聊天提示直接进入当前群聊画板助手');
  // 重开画板后需等嵌入编辑器就绪，否则「预览地点创建」的保存确认握手可能超时
  await page.frameLocator('iframe').locator('.react-flow__pane').waitFor();await page.waitForTimeout(300);
  const initialPlacement=await page.evaluate(()=>window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId);
  await page.getByRole('button',{name:'创建地点',exact:true}).click();await page.getByRole('button',{name:'预览地点创建'}).click();
  await page.getByText('创建地点：旧桥（不移动人物）',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.host.read('group-b','session-b').world.nodes.some(node=>node.name==='旧桥')),false);checked('未知地点创建先预览不写入世界');
  await page.getByRole('button',{name:'应用',exact:true}).last().click();
  await page.waitForFunction(()=>window.host.read('group-b','session-b').world.nodes.some(node=>node.name==='旧桥'));
  assert.equal(await page.evaluate(()=>window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId),initialPlacement);checked('创建地点独立确认，人物位置不变');
  const bridge=await page.evaluate(()=>window.host.read('group-b','session-b').world.nodes.find(node=>node.name==='旧桥').id);
  await page.getByRole('combobox',{name:'选择已有地点：旧桥'}).selectOption(bridge);await page.getByRole('button',{name:'重新核对'}).click();
  await page.getByRole('button',{name:'确认移动'}).waitFor();
  assert.equal(await page.evaluate(()=>window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId),initialPlacement);checked('完整路径重新核对后仍未移动');
  assert.deepEqual((await page.evaluate(()=>window.host.reviewOwner)).slice(0,3),['group-b','session-b','unknown-story']);
  await page.screenshot({path:join(output,'reviewed.png'),fullPage:true});
  await page.getByRole('button',{name:'确认移动'}).click();await page.waitForFunction(bridge=>window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId===bridge,bridge);checked('二次确认后人物移入新地点');
  await page.evaluate(()=>window.host.changed());await page.getByText(/已应用位置的来源已变化/).waitFor();
  assert.equal(await page.evaluate(()=>window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId),bridge);checked('已应用来源变化提示保留位置');
  await page.getByRole('button',{name:'撤销此次剧情更新'}).click();assert.equal(await page.evaluate(()=>window.host.undoOwner),undefined);checked('第一次撤销点击仅进入确认');
  await page.getByRole('button',{name:'确认撤销此次更新'}).click();await page.waitForFunction(id=>window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId===id,initialPlacement);checked('群聊剧情撤销恢复原人物位置');
  await page.evaluate(()=>window.host.unknown());await page.getByRole('combobox',{name:'选择已有地点：旧桥'}).selectOption('dock');await page.getByRole('button',{name:'重新核对'}).click();await page.getByRole('button',{name:'确认移动'}).click();
  await page.waitForFunction(()=>window.host.read('group-b','session-b').runtime.placements[0].anchor.nodeId==='dock');
  await page.evaluate(()=>window.host.conflict());await page.getByText('画板版本已改变，请按当前位置重新核对',{exact:true}).waitFor();
  await page.getByRole('button',{name:'重新核对'}).click();await page.getByRole('button',{name:'确认移动'}).waitFor();checked('旧版本建议展示当前路径，可重核对且需再次确认');
  await page.getByRole('button',{name:'忽略',exact:true}).click();
  await page.getByRole('button',{name:'关闭画板助手'}).click();await page.frameLocator('iframe').getByRole('button',{name:'返回对话',exact:true}).click();await page.locator('iframe').waitFor({state:'detached'});
  await page.getByRole('button',{name:'查看或撤销'}).waitFor();checked('已确认剧情结果可从聊天再次查看或撤销');
  await page.evaluate(()=>window.host.selectGroup('group-a'));await page.getByRole('button',{name:'群聊空间画板'}).waitFor();
  assert.equal(await page.getByText(/本轮位置已确认/).count(),0);checked('切换群聊不携带前群建议或应用结果');

  assert.deepEqual(errors, []); checked('浏览器无未捕获异常')
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: checks.length, checks, errors }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, output }))
} catch (error) {
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, completed: checks, errors, failure: String(error) }, null, 2))
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
  throw error
}
} })
