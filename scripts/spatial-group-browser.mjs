import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
const require = createRequire(resolve('spatial-board/package.json'))
const { chromium } = require('playwright')
const output = resolve('output/playwright/spatial-group-stage0')
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
const snapshots=new Map(),listeners=new Set();
const key=(g,s)=>g+'/'+s;
const snapshot=(g,s)=>{const saved=snapshots.get(key(g,s));if(!saved)return null;return {...saved,world,version:{...saved.version,worldFingerprint:'world-'+worldRevision},activeActorIds:world.actors.filter(actor=>actor.externalRef.type==='qingyu-persona'||groups.find(item=>item.id===g).memberIds.includes(actor.externalRef.id)).map(actor=>actor.id)}};
const host=window.host={current:()=>({groupId:useGroupChatStore.getState().currentGroup?.id,sessionId:useGroupChatStore.getState().currentSessionId}),loads:[],commits:[],aiCalls:0,hold:false,releases:[],read:(g='group-a',s='session-a')=>snapshot(g,s),switchSession:s=>useGroupChatStore.getState().switchSession(useGroupChatStore.getState().currentGroup.id,s),selectGroup:g=>useGroupChatStore.getState().selectGroup(g),mode:mode=>useGroupChatStore.setState(state=>({currentGroup:{...state.currentGroup,chatMode:mode}})),streaming:active=>useGroupChatStore.setState({isStreaming:active}),remove:id=>{groups[0].memberIds=groups[0].memberIds.filter(member=>member!==id);useGroupChatStore.setState({currentGroup:{...groups[0]}});listeners.forEach(listener=>listener({kind:'group',groupId:'group-a',sessionId:'session-a',worldId:world.id,commitId:crypto.randomUUID()}))},release:()=>{host.hold=false;host.releases.splice(0).forEach(resolve=>resolve())}};
const bind=async(g,s)=>{if(!world){world=createWorldWithDefaults('shared-world','青石城',{now:1});world.actors=[{id:'actor-a',kind:'character',displayName:'Aiko',externalRef:{type:'qingyu-character',id:'char-a'}},{id:'actor-b',kind:'character',displayName:'大本',externalRef:{type:'qingyu-character',id:'char-b'}},{id:'actor-user',kind:'persona',displayName:'旅人',externalRef:{type:'qingyu-persona',id:'persona-a'}}]}
const runtime=createEmptyRuntime(world.id,'runtime-'+g+'-'+s,1);snapshots.set(key(g,s),{world,runtime,version:{worldId:world.id,runtimeId:runtime.runtimeId,bindingEpoch:'epoch-'+g+'-'+s,runtimeRevision:0,worldFingerprint:'world-'+worldRevision}});return snapshot(g,s)};
window.api.persona.list=async()=>personas;window.api.group.list=async()=>groups;window.api.group.listSessions=async g=>sessions[g];window.api.group.listMessages=async()=>[];
Object.assign(window.api.spatial,{loadGroupBound:async(g,s)=>{host.loads.push(key(g,s));return snapshot(g,s)},createGroupAndBind:bind,bindGroupWorld:bind,listWorlds:async()=>world?[{id:world.id,name:world.name,updatedAt:1}]:[],onUpdated:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},getAiSession:async()=>{host.aiCalls++;throw Error('群聊阶段0不应调用AI')},loadBound:async()=>{throw Error('群聊不应读取单聊')},applyGroupEditorBatch:async(g,s,input)=>{
host.commits.push({groupId:g,sessionId:s,input});if(host.hold)await new Promise(resolve=>host.releases.push(resolve));const before=snapshot(g,s);if(input.runtimeId!==before.version.runtimeId||input.bindingEpoch!==before.version.bindingEpoch||input.expectedRuntimeRevision!==before.version.runtimeRevision||input.expectedWorldFingerprint!==before.version.worldFingerprint)return {ok:false,code:'version_conflict',message:'版本冲突',snapshot:before};
const result=applyCommandBatch(before,{schemaVersion:1,expectedRevision:input.expectedRuntimeRevision,commands:input.commands},{source:'user',now:Date.now(),idGen:()=>crypto.randomUUID()});if(!result.ok)return result;world=result.state.world;worldRevision++;snapshots.set(key(g,s),{...result.state,version:{...before.version,runtimeRevision:result.state.runtime.revision}});return {ok:true,snapshot:snapshot(g,s),duplicate:false,receipt:{commitId:input.commitId,revisionBefore:before.runtime.revision,revisionAfter:result.state.runtime.revision,worldFingerprintAfter:'world-'+worldRevision}};
}});
useCharacterStore.setState({characters});usePersonaStore.setState({personas,loaded:true});useGroupChatStore.setState({groupChats:groups,currentGroup:groups[0],sessions:sessions['group-a'],currentSessionId:'session-a',messages:[],isStreaming:false});
document.body.style.margin='0';createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex'}}><GroupChatPage/></div>);
`)
await writeFile(join(output, 'host.html'), '<!doctype html><html><head><base href="/"></head><body><div id="root"></div><script type="module" src="/output/playwright/spatial-group-stage0/host.tsx"></script></body></html>')
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5181', '--strictPort'], { cwd: resolve('.'), stdio: 'pipe', windowsHide: true })
let startup = ''; server.stderr.on('data', chunk => startup += chunk); server.stdout.on('data', chunk => startup += chunk)
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []; page.on('pageerror', error => errors.push(error.message))
const checks = []
const checked = name => checks.push(name)
try {
  for (let attempt = 0; attempt < 80; attempt++) { try { if ((await fetch('http://127.0.0.1:5181')).ok) break } catch {} await new Promise(resolve => setTimeout(resolve, 100)) }
  await page.goto('http://127.0.0.1:5181/output/playwright/spatial-group-stage0/host.html')
  const open = () => page.getByRole('button', { name: '群聊空间画板', exact: true }).click()
  await open(); await page.getByRole('button', { name: '创建空白', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '从当前设定生成', exact: true }).count(), 0); checked('群聊页头入口与手动初始化')
  await page.getByRole('button', { name: '创建空白', exact: true }).click()
  let frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: '角色托盘', exact: true }).click()
  await frame.getByText('Aiko', { exact: true }).waitFor()
  assert.equal(await frame.locator('.tray-item').count(), 3)
  assert.equal(await frame.locator('.tray-item img').count(), 3); checked('当前成员与用户身份头像')
  assert.equal(await frame.getByRole('button', { name: '打开画板助手', exact: true }).count(), 0)
  assert.equal(await frame.getByPlaceholder('新角色名').count(), 0); checked('隐藏未接入的群聊助手和角色创建')
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
  await open(); await page.getByRole('button', { name: '青石城', exact: true }).click()
  frame = page.frameLocator('iframe'); await frame.getByRole('button', { name: '角色托盘', exact: true }).waitFor()
  assert.equal(await frame.locator('.rf-actor').count(), 0)
  assert.equal((await page.evaluate(() => window.host.read('group-a', 'session-b'))).runtime.placements.length, 0); checked('同群新会话共享世界且位置为空')
  await page.getByRole('button', { name: /^另一群/ }).click()
  await page.locator('iframe').waitFor({ state: 'detached' }); await open()
  await page.getByRole('button', { name: '青石城', exact: true }).click()
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
  assert.deepEqual(errors, []); checked('浏览器无未捕获异常')
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: checks.length, checks, errors }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, output }))
} catch (error) {
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, completed: checks, errors, failure: String(error) }, null, 2))
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
  console.error(startup.slice(-1800)); console.error(errors); throw error
} finally { await browser.close(); server.kill() }
