// 群聊空间画板阶段 1 联验：阶段 0 全部能力 + 群聊 AI 初始化/指令确认。
// 公共设施（Vite/Playwright/就绪/收尾）来自 lib/browserHarness.mjs；本文件只保留 mock 与断言。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runBrowserSession } from './lib/browserHarness.mjs'

const port = 5181
const output = resolve('output/playwright/spatial-group-stage1')
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
const isBlank=core=>!core||(core.world.nodes.every(node=>node.tags.includes('system:offstage'))&&core.runtime.placements.length===0);
const snapshot=(g,s)=>{const saved=snapshots.get(key(g,s));if(!saved)return null;return {...saved,world,version:{...saved.version,worldFingerprint:'world-'+worldRevision},activeActorIds:world.actors.filter(actor=>actor.externalRef.type==='qingyu-persona'||groups.find(item=>item.id===g).memberIds.includes(actor.externalRef.id)).map(actor=>actor.id)}};
const host=window.host={current:()=>({groupId:useGroupChatStore.getState().currentGroup?.id,sessionId:useGroupChatStore.getState().currentSessionId}),loads:[],commits:[],aiCalls:0,hold:false,releases:[],read:(g='group-a',s='session-a')=>snapshot(g,s),officialBlank:(g,s)=>isBlank(snapshot(g,s)),switchSession:s=>useGroupChatStore.getState().switchSession(useGroupChatStore.getState().currentGroup.id,s),selectGroup:g=>useGroupChatStore.getState().selectGroup(g),mode:mode=>useGroupChatStore.setState(state=>({currentGroup:{...state.currentGroup,chatMode:mode}})),streaming:active=>useGroupChatStore.setState({isStreaming:active}),remove:id=>{groups[0].memberIds=groups[0].memberIds.filter(member=>member!==id);useGroupChatStore.setState({currentGroup:{...groups[0]}});listeners.forEach(listener=>listener({kind:'group',groupId:'group-a',sessionId:'session-a',worldId:world.id,commitId:crypto.randomUUID()}))},release:()=>{host.hold=false;host.releases.splice(0).forEach(resolve=>resolve())}};
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
groupInitializationSources:async(g,s)=>({sources:[{id:'group:setting',kind:'group',label:'群聊公共设定',text:'青石城有茶馆与渡口'}],members:groups.find(group=>group.id===g).memberIds.map(id=>({id,name:characters.find(character=>character.id===id).name})),loreEntries:[],sharedSessions:1,canInitialize:isBlank(snapshot(g,s))}),
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
window.api.group.updateSession=async(g,s,updates)=>{Object.assign(sessions[g].find(item=>item.id===s),updates);host.contextEnabled=updates.spatialContextEnabled};

useCharacterStore.setState({characters});usePersonaStore.setState({personas,loaded:true});useGroupChatStore.setState({groupChats:groups,currentGroup:groups[0],sessions:sessions['group-a'],currentSessionId:'session-a',messages:[],isStreaming:false});
document.body.style.margin='0';createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex'}}><GroupChatPage/></div>);
`)
await writeFile(join(output, 'host.html'), '<!doctype html><html><head><base href="/"></head><body><div id="root"></div><script type="module" src="/output/playwright/spatial-group-stage1/host.tsx"></script></body></html>')

const checks = []
const checked = name => checks.push(name)

await runBrowserSession({ port, run: async ({ page, errors }) => {
  try {
    await page.goto(`http://127.0.0.1:${port}/output/playwright/spatial-group-stage1/host.html`)
    // 入口按钮 aria-label 未变；面板默认关闭，需先开启「启用空间画布」开关（新 UI 流程）
    const open = async () => {
      await page.getByRole('button', { name: '群聊空间画板', exact: true }).click()
      const toggle = page.getByRole('switch', { name: '启用空间画布' })
      if (await toggle.isVisible().catch(() => false)) await toggle.click()
      await page.frameLocator('iframe').locator('.react-flow__pane').waitFor()
    }
    await page.getByRole('button', { name: '群聊空间画板', exact: true }).click()
    await page.getByRole('switch', { name: '启用空间画布' }).waitFor()
    assert.equal(await page.getByText('空间画布已关闭').count(), 1)
    await page.getByRole('switch', { name: '启用空间画布' }).click()
    let frame = page.frameLocator('iframe')
    await frame.locator('.react-flow__pane').waitFor()
    checked('群聊页头入口与默认关闭')
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

    // 新 UI：先开启画布进入 iframe，再点 iframe 内「打开画板助手」打开 AI 面板（旧「从当前设定生成」已移除）
    await page.evaluate(async () => { await window.host.selectGroup('group-b'); await window.host.switchSession('session-b') })
    await open()
    frame = page.frameLocator('iframe')
    await frame.getByRole('button', { name: '打开画板助手', exact: true }).click()
    await page.getByText('初始化来源 · 1 项').click()
    await page.getByRole('checkbox', { name: '大本 · 成员设定' }).uncheck()
    await page.getByRole('button', { name: '生成场景', exact: true }).click()
    await frame.getByText('茶馆', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.host.aiRequests.at(-1).input.memberIds), ['char-a'])
    assert.equal(await page.evaluate(() => window.host.officialBlank('group-b', 'session-b')), true)
    checked('成员来源可选，生成群聊草稿不写正式世界')
    await frame.getByText('茶馆', { exact: true }).click()
    const name = frame.locator('.inspector .field').filter({ has: frame.locator('label', { hasText: '名称（必填）' }) }).locator('input').first()
    await name.fill('夜茶馆'); await name.press('Tab'); await page.waitForFunction(() => window.host.draftEdits === 1)
    assert.equal(await page.evaluate(() => window.host.officialBlank('group-b', 'session-b')), true); checked('群聊初始化草稿可在画板修改')
    await page.getByRole('button', { name: '确认场景', exact: true }).click(); await page.waitForFunction(() => window.host.applies === 1)
    frame = page.frameLocator('iframe'); await frame.getByText('夜茶馆', { exact: true }).waitFor()
    checked('确认采用已修改草稿并绑定当前群会话')
    assert.equal(await page.getByRole('combobox', { name: '剧情同步策略' }).count(), 0); checked('群聊阶段1仅提供手动AI确认')
    await page.getByRole('textbox', { name: '画板助手输入' }).fill('把 Aiko 移到渡口'); await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '应用', exact: true }).waitFor()
    assert.equal((await page.evaluate(() => window.host.read('group-b', 'session-b'))).runtime.placements[0].anchor.nodeId, 'tea')
    checked('独立群聊助手显式指令等待确认')
    await page.getByRole('button', { name: '应用', exact: true }).click(); await page.waitForFunction(() => window.host.read('group-b', 'session-b').runtime.placements[0].anchor.nodeId === 'dock'); checked('确认后指定成员移动生效')
    await page.getByText('同步设置', { exact: true }).click()
    await page.getByRole('checkbox', { name: '对话读取位置' }).click(); await page.waitForFunction(() => window.host.contextEnabled === false); checked('群聊会话可关闭位置读取')
    await page.evaluate(() => window.host.aiHold = true)
    await page.getByRole('textbox', { name: '画板助手输入' }).fill('先核对位置'); await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).click(); await page.getByText('画板请求已停止；可修改输入后重新发送。').waitFor(); checked('群聊助手可取消等待中的请求')
    await page.screenshot({ path: join(output, 'group-assistant.png'), fullPage: true })

    assert.deepEqual(errors, []); checked('浏览器无未捕获异常')
    await writeFile(join(output, 'result.json'), JSON.stringify({ passed: checks.length, checks, errors }, null, 2))
    console.log(JSON.stringify({ passed: checks.length, output }))
  } catch (error) {
    await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, completed: checks, errors, failure: String(error) }, null, 2))
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
    throw error
  }
} })