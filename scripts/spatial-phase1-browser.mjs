// 单聊空间画板阶段 1—4 联验：初始化预览、手动指令、剧情同步、自动同步与撤销。
// 公共设施（Vite/Playwright/就绪/收尾）来自 lib/browserHarness.mjs；本文件只保留 mock 与断言。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runBrowserSession } from './lib/browserHarness.mjs'

const phase4 = process.argv.includes('--phase4')
const phase3 = phase4 || process.argv.includes('--phase3')
const phase2 = phase3 || process.argv.includes('--phase2')
const stage = phase4 ? 4 : phase3 ? 3 : phase2 ? 2 : 1
const port = 5179
const output = resolve(`output/playwright/spatial-stage${stage}`)
await mkdir(output, { recursive: true })
await writeFile(join(output, 'host.tsx'), `import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/index.css';
import {SpatialBoardPane} from '/src/components/chat/SpatialBoardPane.tsx';
import {SpatialSuggestionNotice} from '/src/components/chat/SpatialSuggestionNotice.tsx';
import {useChatStore} from '/src/store/useChatStore';
import {useCharacterStore} from '/src/store/useCharacterStore';
import {usePersonaStore} from '/src/store/usePersonaStore';
import {createWorldWithDefaults,createEmptyRuntime,applyCommandBatch} from '@qingyu/spatial-core';
const world=createWorldWithDefaults('world-browser-1','青石城',{now:1});
world.actors=[{id:'aiko-actor',kind:'character',displayName:'Aiko',externalRef:{type:'qingyu-character',id:'char-browser'}},{id:'persona-actor',kind:'persona',displayName:'旅人',externalRef:{type:'qingyu-persona',id:'persona-browser'}}];
const core={world,runtime:createEmptyRuntime(world.id,'single_chat-browser',1)};
const createNode=(id,name,x)=>({type:'create_node',payload:{id,boardId:world.rootBoardId,kind:'place',name,description:'',tags:[],parentNodeId:null,childBoardId:null,createdAt:1,updatedAt:1,geometry:{x,y:160},iconKey:'pin'}});
const initial=applyCommandBatch(core,{schemaVersion:1,expectedRevision:0,commands:[createNode('tea','茶馆',100),createNode('garden','花园',480),{type:'place_actor',actorId:'aiko-actor',placement:{boardId:world.rootBoardId,anchor:{kind:'node',nodeId:'tea'},semanticPosition:{precision:'inside-only',note:''}}}]},{source:'system',now:1,idGen:()=>crypto.randomUUID()});
if(!initial.ok)throw Error(initial.message);
const withVersion=(state,epoch='epoch-browser')=>({...state,version:{worldId:world.id,runtimeId:core.runtime.runtimeId,bindingEpoch:epoch,runtimeRevision:state.runtime.revision,worldFingerprint:'fp-'+state.runtime.revision}});
const isBlank=snapshot=>!snapshot||(snapshot.world.boards.length===1&&snapshot.world.nodes.every(node=>node.tags.includes('system:offstage'))&&snapshot.world.distances.length===0&&snapshot.runtime.placements.length===0);
const aiListeners=new Set(),listeners=new Set();
let bound=null;
const state={schemaVersion:1,id:'ai-browser',scope:{characterId:'char-browser',sessionId:'chat-browser',worldId:null,runtimeId:null,bindingEpoch:null},messages:[],proposals:[],tasks:[],createdAt:1,updatedAt:1};
const host=window.host={state,applies:0,draftEdits:0,boardEdits:0,cancelled:0,retried:0,policy:'suggest',hold:false,closed:false,committed:()=>bound};
const notify=()=>aiListeners.forEach(listener=>listener({characterId:'char-browser',sessionId:'chat-browser'}));
const submit=(snapshot,input)=>{
 const applied=applyCommandBatch(snapshot,{schemaVersion:1,expectedRevision:input.expectedRuntimeRevision,commands:input.commands},{source:'user',now:2,idGen:()=>crypto.randomUUID()});
 if(!applied.ok)return applied;
 const next=withVersion(applied.state,snapshot.version.bindingEpoch);
 return {ok:true,snapshot:next,duplicate:false,receipt:{commitId:input.commitId,revisionBefore:input.expectedRuntimeRevision,revisionAfter:next.runtime.revision,worldFingerprintAfter:next.version.worldFingerprint}};
};
const unavailable=async()=>{throw Error('fixture unsupported')};
window.api={settings:{save:async()=>{}},app:{log:async()=>{}},chat:{updateSession:async(_char,_sid,patch)=>{if(patch.spatialNarrativeSyncPolicy)host.policy=patch.spatialNarrativeSyncPolicy}},spatial:{
 prepareDialogue:async()=>null,dialogueSaved:async()=>{},retryDialogue:async()=>{host.retried++;state.tasks.at(-1).state='completed';notify()},
 listWorlds:async()=>[],loadBound:async()=>structuredClone(bound),
 setEnabled:async(_char,_sid,enabled)=>{if(!enabled)return null;if(!bound)bound=withVersion(core,'epoch-browser');return structuredClone(bound)},
 createAndBind:unavailable,bindWorld:unavailable,
 getAiSession:async()=>structuredClone(state),
 proposalTargets:async()=>bound?.world.nodes.filter(node=>!node.tags.includes('system:offstage')).map(node=>({id:node.id,boardId:node.boardId,path:node.name,canContain:node.kind==='region'||!!node.childBoardId}))??[],
 initializationSources:async()=>({sources:[{id:'scenario',label:'角色场景设定',kind:'character',text:'Aiko 在茶馆，附近有花园。'}],loreEntries:[],canInitialize:isBlank(bound),sharedSessions:bound?1:0}),
 onUpdated:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
 onAiUpdated:listener=>{aiListeners.add(listener);return()=>aiListeners.delete(listener)},
 askAi:async(_char,_sid,input)=>{
  state.tasks.push({id:input.requestId,state:'running',mode:input.mode,model:'fixture-chat-model'});state.messages.push({id:crypto.randomUUID(),role:'user',content:input.text||'初始化场景',mode:input.mode});notify();
  if(host.hold)await new Promise(resolve=>host.release=resolve);
  if(state.tasks.at(-1).state==='cancelled')return structuredClone(state);
  const id=crypto.randomUUID();
  const proposal={id,commitId:crypto.randomUUID(),mode:input.mode,status:'pending',explanation:'仅提出建议，确认后提交',summary:input.mode==='initialize'?['茶馆、花园；Aiko 位于茶馆']:['Aiko → 花园'],unresolved:[],evidence:[],sources:[],commands:[],createdAt:1};
  if(input.mode==='initialize')proposal.preview=withVersion(initial.state,'draft_'+id);
  else proposal.commands=[{type:'move_actor',actorId:'aiko-actor',from:{revision:bound.runtime.placements[0].revision},to:{boardId:world.rootBoardId,anchor:{kind:'node',nodeId:'garden'},semanticPosition:{precision:'inside-only',note:''}}}];
  state.proposals.push(proposal);state.messages.push({id:crypto.randomUUID(),role:'assistant',content:proposal.explanation,mode:input.mode,proposalId:id});state.tasks.at(-1).state='completed';notify();return structuredClone(state);
 },
 editDraft:async(_char,_sid,id,input)=>{host.draftEdits++;const proposal=state.proposals.find(item=>item.id===id);const result=submit(proposal.preview,input);if(result.ok){proposal.preview=result.snapshot;proposal.summary=['草稿已修改'];notify()}return result},
 applyEditorBatch:async(_char,_sid,input)=>{host.boardEdits++;const result=submit(bound,input);if(result.ok)bound=result.snapshot;return result},
 applyProposal:async(_char,_sid,id)=>{const proposal=state.proposals.find(item=>item.id===id);if(proposal.status!=='applied'){host.applies++;proposal.before=structuredClone(bound);if(proposal.preview)bound=withVersion(proposal.preview);else bound=submit(bound,{expectedRuntimeRevision:bound.runtime.revision,commands:proposal.commands,commitId:proposal.commitId}).snapshot;proposal.status='applied';proposal.appliedRevision=bound.runtime.revision;notify()}return {state:structuredClone(state),snapshot:structuredClone(bound)}},
 reviewProposal:async(_char,_sid,id,input)=>{const p=state.proposals.find(item=>item.id===id),next=structuredClone(p);next.id=crypto.randomUUID();next.commitId=crypto.randomUUID();next.reviewedFromId=id;next.replacedById=undefined;next.canReview=false;next.status='pending';next.staleReason=undefined;next.baseVersion=bound.version;
  const nodeId=Object.values(input.targets)[0]||p.commands[0]?.to.anchor.nodeId;const node=bound.world.nodes.find(item=>item.id===nodeId);next.commands=[{type:'move_actor',actorId:'aiko-actor',from:{revision:bound.runtime.placements[0].revision},to:{boardId:node.boardId,anchor:{kind:'node',nodeId},semanticPosition:{precision:'inside-only',note:''}}}];next.summary=['Aiko → '+node.name];next.comparisons=[{actorName:'Aiko',currentPath:bound.world.nodes.find(item=>item.id===bound.runtime.placements[0].anchor.nodeId).name,targetPath:node.name}];next.unresolved=[];next.dialogueCandidates=[];p.status='stale';p.replacedById=next.id;state.proposals.push(next);notify();return structuredClone(state)},
 preparePlace:async(_char,_sid,id,name,parent)=>{state.proposals.push({id:crypto.randomUUID(),commitId:crypto.randomUUID(),mode:'instruction',status:'pending',summary:['创建地点：'+name+'（不移动人物）'],unresolved:[],evidence:[],sources:[],commands:[createNode('wharf',name,760)],createdAt:3});notify();return structuredClone(state)},
 undoProposal:async(_char,_sid,id)=>{const p=state.proposals.find(item=>item.id===id);if(p.appliedRevision!==bound.runtime.revision)throw Error('剧情提交后画板已有其他修改，不能覆盖当前位置');const old=p.before.runtime.placements[0];bound=submit(bound,{expectedRuntimeRevision:bound.runtime.revision,commitId:crypto.randomUUID(),commands:[{type:'move_actor',actorId:old.actorId,to:{boardId:old.boardId,anchor:old.anchor,semanticPosition:old.semanticPosition}}]}).snapshot;p.status='undone';notify();return {state:structuredClone(state),snapshot:structuredClone(bound)}},
 discardProposal:async(_char,_sid,id)=>{state.proposals.find(item=>item.id===id).status='discarded';return structuredClone(state)},
 cancelAi:async()=>{host.cancelled++;state.tasks.at(-1).state='cancelled';host.release?.();notify();return structuredClone(state)},
 readContext:async()=>null
}};
host.story=(diagnostic=false)=>{
 const id=crypto.randomUUID();
 state.proposals.push({id,commitId:crypto.randomUUID(),mode:'dialogue_sync',dialogueId:'dialogue-fixture',status:'pending',explanation:'已保存正文提取',summary:diagnostic?[]:['Aiko → 夜茶馆'],unresolved:diagnostic?['她准备出发：尚未完成，不改变位置']:[],evidence:[{sourceId:'assistant',quote:'Aiko 走回夜茶馆'}],sources:[{id:'assistant',label:'已保存正文',kind:'message',text:'Aiko 走回夜茶馆'}],commands:diagnostic?[]:[{type:'move_actor',actorId:'aiko-actor',from:{revision:bound.runtime.placements[0].revision},to:{boardId:world.rootBoardId,anchor:{kind:'node',nodeId:'tea'},semanticPosition:{precision:'inside-only',note:''}}}],baseVersion:bound.version,createdAt:2});notify();return id;
};
host.stale=()=>{const p=state.proposals.at(-1);p.status='stale';p.staleReason='来源正文已切换候选';notify()};
host.fail=()=>{state.tasks.push({id:'failed-story',dialogueId:'dialogue-fixture',mode:'dialogue_sync',state:'failed',error:'剧情提取超时'});notify()};
host.unknown=()=>{for(const p of state.proposals)if(p.status==='pending')p.status='discarded';const id=host.story(true),p=state.proposals.at(-1);p.unresolved=['渡口：地图未收录'];p.evidence=[{sourceId:'assistant',quote:'Aiko 已经到达渡口'}];p.dialogueCandidates=[{id:'candidate',actorId:'aiko-actor',targetText:'渡口',completed:true,eligible:true,evidence:'Aiko 已经到达渡口',evidenceSource:'assistant',note:'',reason:'地图未收录'}];notify();return id};
host.conflict=()=>{const id=host.story(),p=state.proposals.at(-1);p.commands[0].to.anchor.nodeId='garden';p.summary=['Aiko → 花园'];p.status='stale';p.canReview=true;p.staleReason='画板版本已改变，请重新核对当前位置与目标';bound=submit(bound,{expectedRuntimeRevision:bound.runtime.revision,commitId:crypto.randomUUID(),commands:[{type:'update_world',patch:{description:'手动修改'}}]}).snapshot;notify();return id};
host.beginAuto=()=>{const id=host.story(),p=state.proposals.at(-1);p.automatic={status:'applying'};state.tasks.push({id:crypto.randomUUID(),mode:'dialogue_sync',dialogueId:p.dialogueId,state:'completed'});notify();return id};
host.finishAuto=async()=>{const p=state.proposals.at(-1);await window.api.spatial.applyProposal('char-browser','chat-browser',p.id);p.automatic={status:'applied'};notify();listeners.forEach(listener=>listener({worldId:world.id,characterId:'char-browser',sessionId:'chat-browser'}))};
host.confirmation=()=>{const id=host.story(),p=state.proposals.at(-1);p.commands[0].to.anchor.nodeId='garden';p.summary=['Aiko → 花园'];p.automatic={status:'confirmation',reason:'置信度不足 0.9，仍需确认'};notify();return id};
const avatar='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" rx="30" fill="#8265b5"/><text x="30" y="39" font-size="28" fill="white" text-anchor="middle">A</text></svg>');
useCharacterStore.setState({characters:[{id:'char-browser',name:'Aiko',avatar,updatedAt:1}]});
usePersonaStore.setState({personas:[{id:'persona-browser',name:'旅人',avatar,description:'',persona:''}]});
useChatStore.setState({currentSessionId:'chat-browser',sessions:[{id:'chat-browser',characterId:'char-browser',title:'演示',messageCount:0,lastMessage:'',createdAt:1,updatedAt:1}]});
document.body.style.margin='0';
createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex',flexDirection:'column'}}><SpatialSuggestionNotice characterId="char-browser" sessionId="chat-browser" worldId="world-browser-1" enabled onOpen={()=>host.noticeOpened=true}/><SpatialBoardPane characterId="char-browser" sessionId="chat-browser" onClose={()=>host.closed=true} registerClose={()=>{}}/></div>);
`)
await writeFile(join(output,'host.html'), `<!doctype html><html><head><base href="/"><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/output/playwright/spatial-stage${stage}/host.tsx"></script></body></html>`)

await runBrowserSession({ port, run: async ({ page, errors }) => {
 try {
  await page.goto(`http://127.0.0.1:${port}/output/playwright/spatial-stage${stage}/host.html`)
  // 新 UI：面板默认关闭，先开启「启用空间画布」，mock 首次 enable 自动创建并绑定空白画板（幂等）。
  await page.getByRole('switch',{name:'启用空间画布'}).click()
  let frame=page.frameLocator('iframe')
  await frame.locator('.react-flow__pane').waitFor()
  // 画板助手改由 iframe 内「打开画板助手」开合（页面级面板）。
  await frame.getByRole('button',{name:'打开画板助手'}).click()
  await page.getByRole('button',{name:'生成场景',exact:true}).click()
  await page.waitForFunction(()=>window.host.state.proposals.length===1)
  await frame.getByText('茶馆',{exact:true}).waitFor()
  // 初始化预览期间画板尚未提交场景（仅绑定空白画板）。
  assert.equal(await page.evaluate(()=>window.host.committed().runtime.placements.length),0)
  assert.equal(await page.evaluate(()=>window.host.committed().world.nodes.filter(node=>node.name==='茶馆').length),0)
  await page.screenshot({path:join(output,'initialization-preview.png'),fullPage:true})
  await frame.getByText('茶馆',{exact:true}).click()
  const name=frame.locator('.inspector .field').filter({has:frame.locator('label',{hasText:'名称（必填）'})}).locator('input').first()
  await name.fill('夜茶馆');await name.press('Tab')
  await page.waitForFunction(()=>window.host.draftEdits===1)
  assert.equal(await page.evaluate(()=>window.host.boardEdits),0)
  await page.getByRole('button',{name:'确认场景',exact:true}).click()
  await page.waitForFunction(()=>window.host.applies===1)
  frame=page.frameLocator('iframe')
  await frame.getByText('夜茶馆',{exact:true}).waitFor()
  await page.getByRole('button',{name:'关闭画板助手'}).click()
  await frame.getByRole('button',{name:'打开画板助手'}).click()
  // 新 UI：位置读取与剧情同步设置收纳在默认折叠的「同步设置」区内，先展开
  await page.getByText('同步设置',{exact:true}).click()
  await page.getByRole('textbox',{name:'画板助手输入'}).fill('把 Aiko 移到花园')
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await page.waitForFunction(()=>window.host.state.proposals.filter(item=>item.status==='pending').length===1)
  assert.equal(await page.evaluate(()=>window.host.committed().runtime.placements[0].anchor.nodeId),'tea')
  await page.getByRole('button',{name:'应用',exact:true}).click()
  await page.waitForFunction(()=>window.host.committed().runtime.placements[0].anchor.nodeId==='garden')
  assert.equal(await page.evaluate(()=>window.host.applies),2)
  await page.getByRole('checkbox',{name:'对话读取位置'}).click()
  await page.waitForFunction(()=>document.querySelector('aside input[type="checkbox"]').checked===false)
  await page.evaluate(()=>window.host.hold=true)
  await page.getByRole('textbox',{name:'画板助手输入'}).fill('将 Aiko 移回茶馆')
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await page.getByRole('button',{name:'停止',exact:true}).click()
  await page.waitForFunction(()=>window.host.cancelled===1)
  await page.getByRole('textbox',{name:'画板助手输入'}).fill('')
  if(phase2){
   await page.getByRole('combobox',{name:'剧情同步策略'}).selectOption('off');await page.waitForFunction(()=>window.host.policy==='off');
   await page.getByRole('combobox',{name:'剧情同步策略'}).selectOption('suggest');await page.waitForFunction(()=>window.host.policy==='suggest');
   await page.evaluate(()=>window.host.story());await page.getByRole('heading',{name:'剧情位置建议'}).waitFor();
   assert.equal(await page.evaluate(()=>window.host.committed().runtime.placements[0].anchor.nodeId),'garden');
   await page.getByRole('button',{name:'应用',exact:true}).click();await page.waitForFunction(()=>window.host.committed().runtime.placements[0].anchor.nodeId==='tea');
   await page.evaluate(()=>{window.host.story();window.host.stale()});await page.getByText('剧情建议已失效：来源正文已切换候选').waitFor();
   assert.equal(await page.getByRole('button',{name:'应用',exact:true}).count(),0);
   await page.evaluate(()=>window.host.story(true));await page.getByText(/未明确项 · 1 项/).last().click();await page.getByText('她准备出发：尚未完成，不改变位置').waitFor();
   assert.equal(await page.getByRole('button',{name:'应用',exact:true}).isDisabled(),true);
   await page.evaluate(()=>window.host.fail());await page.getByRole('button',{name:'重新提取本轮剧情'}).click();await page.waitForFunction(()=>window.host.retried===1);
  }
  if(phase3){
   await page.evaluate(()=>window.host.unknown());
   await page.getByRole('button',{name:'查看画板建议'}).click();assert.equal(await page.evaluate(()=>window.host.noticeOpened),true);
   await page.getByRole('button',{name:'创建地点',exact:true}).click();await page.getByRole('button',{name:'预览地点创建'}).click();
   await page.getByRole('heading',{name:'待确认调整'}).waitFor();await page.getByRole('heading',{name:'待确认调整'}).locator('..').getByRole('button',{name:'应用',exact:true}).click();await page.waitForFunction(()=>window.host.committed().world.nodes.some(item=>item.id==='wharf'));
   assert.equal(await page.evaluate(()=>window.host.committed().runtime.placements[0].anchor.nodeId),'tea');
   await page.getByRole('combobox',{name:'选择已有地点：渡口'}).selectOption('wharf');await page.getByRole('button',{name:'重新核对',exact:true}).click();
   await page.getByRole('button',{name:'确认移动',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.host.committed().runtime.placements[0].anchor.nodeId),'tea');
   await page.screenshot({path:join(output,'resolved-awaiting-confirmation.png'),fullPage:true});
   await page.getByRole('button',{name:'确认移动',exact:true}).click();await page.waitForFunction(()=>window.host.committed().runtime.placements[0].anchor.nodeId==='wharf');
   const undo=page.getByRole('button',{name:'撤销此次剧情更新'}).last();await undo.click();await page.getByRole('button',{name:'确认撤销此次更新'}).click();await page.waitForFunction(()=>window.host.committed().runtime.placements[0].anchor.nodeId==='tea');
   await page.evaluate(()=>window.host.conflict());await page.getByRole('button',{name:'重新核对',exact:true}).click();await page.getByRole('button',{name:'确认移动',exact:true}).click();await page.waitForFunction(()=>window.host.committed().runtime.placements[0].anchor.nodeId==='garden');
  }
  if(phase4){
   const selector=page.getByRole('combobox',{name:'剧情同步策略'});
   await page.getByRole('checkbox',{name:'对话读取位置'}).click();
   await page.waitForFunction(()=>document.querySelector('aside input[type="checkbox"]').checked===true);
   await selector.selectOption('auto');await page.waitForFunction(()=>window.host.policy==='auto');
   await page.getByText('按剧情自动同步角色和用户位置，明确的新地点自动添加；不确定或未完成的动作自动跳过。').waitFor();
   await page.evaluate(()=>window.host.beginAuto());await page.getByText('正在自动同步位置…').waitFor();
   // 新 UI：自动同步中的提案不再提供手动「应用」入口
   assert.equal(await page.getByRole('button',{name:'应用',exact:true}).count(),0);
   assert.equal(await selector.isEnabled(),true);
   assert.equal(await page.evaluate(()=>window.host.committed().runtime.placements[0].anchor.nodeId),'garden');
   await page.evaluate(()=>window.host.finishAuto());await page.getByText('已自动应用：Aiko → 夜茶馆').waitFor();
   await page.getByText('本轮位置已自动同步').waitFor();
   // 新 UI：单聊自动同步仅给 2s 瞬态提示，无持久「查看或撤销」入口；直接打开助手面板查看结果
   if (!(await page.getByRole('button',{name:'关闭画板助手'}).isVisible().catch(()=>false))) await page.frameLocator('iframe').getByRole('button',{name:'打开画板助手'}).click();
   assert.equal(await page.evaluate(()=>window.host.committed().runtime.placements[0].anchor.nodeId),'tea');
   await page.getByText('已自动应用：Aiko → 夜茶馆').scrollIntoViewIfNeeded();
   await page.screenshot({path:join(output,'automatic-applied.png'),fullPage:true});
   await page.getByText('已自动应用：Aiko → 夜茶馆').locator('..').getByRole('button',{name:'撤销此次剧情更新'}).click();
   assert.equal(await page.evaluate(()=>window.host.committed().runtime.placements[0].anchor.nodeId),'tea');
   await page.getByRole('button',{name:'确认撤销此次更新'}).click();await page.waitForFunction(()=>window.host.committed().runtime.placements[0].anchor.nodeId==='garden');
   assert.equal(await page.getByText('本轮位置已自动同步').count(),0);
   await page.evaluate(()=>window.host.confirmation());await page.getByText('置信度不足 0.9，仍需确认').waitFor();
   // 新 UI：自动策略下低置信度建议仅显示原因，不提供手动「应用」；需切回「需确认」策略再应用
   assert.equal(await page.getByRole('button',{name:'应用',exact:true}).count(),0);
   await selector.selectOption('suggest');await page.waitForFunction(()=>window.host.policy==='suggest');
   await selector.selectOption('off');await page.waitForFunction(()=>window.host.policy==='off');
   assert.equal(await page.evaluate(()=>window.host.state.proposals.at(-1).status),'pending');
  }
  await page.screenshot({path:join(output,'assistant-confirmed.png'),fullPage:true})
  assert.deepEqual(errors,[])
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,scenarios:phase4?25:phase3?19:phase2?13:7,errors,applies:await page.evaluate(()=>window.host.applies)},null,2))
  console.log(phase4 ? 'Phase 4 browser: 25 scenarios passed' : phase3 ? 'Phase 3 browser: 19 scenarios passed' : phase2 ? 'Phase 2 browser: 13 scenarios passed' : 'Phase 1 browser: 7 scenarios passed')
 } catch(error) {
  await page.screenshot({path:join(output,'failure.png'),fullPage:true})
  await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors,text:await page.locator('body').innerText(),debug:await page.evaluate(()=>({proposals:window.host.state.proposals.map(p=>({id:p.id,status:p.status,mode:p.mode})),tasks:window.host.state.tasks,buttons:[...document.querySelectorAll('aside button')].map(b=>({text:b.textContent,disabled:b.disabled}))}))},null,2))
  throw error
 }
} })