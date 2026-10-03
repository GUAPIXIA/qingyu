import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, 'output', 'playwright')
await mkdir(output, { recursive: true })
// 真正的父窗口/iframe 消息通道；落盘与 CAS 另由主进程故障测试覆盖。
await writeFile(join(output, 'embedded-host.html'), `<!doctype html><html><body style="margin:0">
<iframe title="嵌入画板" style="width:100vw;height:100vh;border:0"></iframe>
<script type="module">
import { createWorldWithDefaults, createEmptyRuntime, applyCommandBatch } from '@qingyu/spatial-core';
const world = createWorldWithDefaults('world-browser', '初始世界', { now: 1 });
let snapshot = { world, runtime: createEmptyRuntime(world.id, 'runtime-browser', 1),
  version: { worldId: world.id, runtimeId: 'runtime-browser', bindingEpoch: 'epoch-browser', runtimeRevision: 0, worldFingerprint: 'fp-0' } };
const frame = document.querySelector('iframe');
let externalRevision = 0;
const post = data => frame.contentWindow.postMessage(data, location.origin);
const host = window.host = { requests: [], replies: [], statuses: [], featureRequests: [], assistantRequests: [], hold: false, reject: false, acks: [],
  snapshot: () => snapshot, post,
  release: () => { host.hold = false; for (const reply of host.acks.splice(0)) post(reply); },
  external: () => {
    snapshot = { ...snapshot, world: { ...snapshot.world, name: '外部世界', description: '外部改动 ' + ++externalRevision },
      version: { ...snapshot.version, worldFingerprint: 'external-' + externalRevision } };
    post({ type: 'qingyu:spatial:external', snapshot });
  } };
addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  const data = event.data;
  if (data.type === 'qingyu:spatial:ready') post({ type: 'qingyu:spatial:init', ...snapshot, assistantEnabled: true, theme: 'light' });
  if (data.type === 'qingyu:spatial:assistant') host.assistantRequests.push(data);
  if (data.type === 'qingyu:spatial:pending') host.statuses.push(data);
  if (data.type === 'qingyu:spatial:set-enabled') {
    host.featureRequests.push(data);
    post({ type: 'qingyu:spatial:feature-toggle-result' });
  }
  if (data.type === 'qingyu:spatial:flushed' || data.type === 'qingyu:spatial:flush-error') host.replies.push(data);
  if (data.type !== 'qingyu:spatial:commands') return;
  const request = data.request;
  host.requests.push(request);
  let result;
  if (host.reject || request.expectedRuntimeRevision !== snapshot.version.runtimeRevision || request.expectedWorldFingerprint !== snapshot.version.worldFingerprint) {
    result = { ok: false, message: '版本冲突', snapshot };
  } else {
    const applied = applyCommandBatch(snapshot, { schemaVersion: 1, expectedRevision: request.expectedRuntimeRevision, commands: request.commands },
      { source: 'user', now: 5, idGen: () => crypto.randomUUID() });
    if (!applied.ok) throw Error(applied.message);
    snapshot = { ...applied.state, version: { ...snapshot.version, runtimeRevision: applied.state.runtime.revision,
      worldFingerprint: 'fp-' + applied.state.runtime.revision } };
    result = { ok: true, snapshot, receipt: { commitId: request.commitId, revisionAfter: snapshot.runtime.revision,
      worldFingerprintAfter: snapshot.version.worldFingerprint } };
  }
  const reply = { type: 'qingyu:spatial:commit-result', commitId: request.commitId, result };
  if (host.hold) host.acks.push(reply); else post(reply);
});
frame.src = '/index.html?embedded=1';
</script></body></html>`)

const port = 5198
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: root, stdio: 'ignore' })
let browser
try {
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw Error('Vite exited')
    try { if ((await fetch(base)).ok) { ready = true; break } } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(ready, 'Vite ready')
  try { browser = await chromium.launch({ headless: true }) } catch { browser = await chromium.launch({ channel: 'chrome', headless: true }) }
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/output/playwright/embedded-host.html')
  const frame = page.frameLocator('iframe')
  const name = frame.getByRole('textbox', { name: '世界名称' })
  await name.waitFor()
  assert.equal(await name.inputValue(), '初始世界')
  assert.equal(await frame.getByRole('button', { name: 'AI 初始化', exact: true }).count(), 1)
  await frame.getByRole('button', { name: 'AI 初始化', exact: true }).click()
  await page.waitForFunction(() => window.host.assistantRequests.length === 1)
  assert.equal(await frame.getByRole('button', { name: 'AI 助手', exact: true }).count(), 1)
  await frame.getByRole('button', { name: 'AI 助手', exact: true }).click()
  await page.waitForFunction(() => window.host.assistantRequests.length === 2)
  assert.equal(await page.evaluate(() => window.host.requests.length), 0)
  await page.screenshot({ path: join(output, 'embedded-ai-start.png'), fullPage: true })
  await frame.getByRole('button', { name: '绘制区域', exact: false }).click()
  assert.equal(await frame.locator('.canvas-empty').count(), 0)
  assert.equal(await frame.getByRole('button', { name: 'AI 助手', exact: true }).count(), 1)
  await page.keyboard.press('Escape')
  // 返回、名称和全局开关合并在唯一的画布顶栏。
  assert.equal(await frame.locator('.top-bar').count(), 1)
  assert.equal(await frame.getByRole('button', { name: '返回对话' }).count(), 1)
  const featureSwitch = frame.getByRole('switch', { name: '启用空间画布' })
  assert.equal(await featureSwitch.count(), 1)
  const headerBox = await frame.locator('.top-bar').boundingBox()
  const nameBox = await name.boundingBox()
  const switchBox = await featureSwitch.boundingBox()
  assert(headerBox && nameBox && switchBox)
  assert(nameBox.y >= headerBox.y && nameBox.y + nameBox.height <= headerBox.y + headerBox.height)
  assert(switchBox.y >= headerBox.y && switchBox.y + switchBox.height <= headerBox.y + headerBox.height)
  await featureSwitch.click()
  await page.waitForFunction(() => window.host.featureRequests.length === 1)
  assert.deepEqual(await page.evaluate(() => window.host.featureRequests[0]), { type: 'qingyu:spatial:set-enabled', enabled: false })
  await page.waitForFunction(() => !document.querySelector('iframe').contentDocument.querySelector('.spatial-feature-switch').disabled)
  await page.screenshot({ path: join(output, 'embedded-header-merged.png'), clip: { x: 0, y: 0, width: 1360, height: 130 } })
  await page.evaluate(() => { window.host.hold = true })
  await name.fill('第一次修改')
  await name.press('Tab')
  await page.waitForFunction(() => window.host.requests.length === 1)
  await name.fill('第二次修改')
  await name.press('Tab')
  await page.waitForFunction(() => window.host.statuses.at(-1)?.pending === 2)
  assert.equal(await page.evaluate(() => window.host.requests.length), 1)
  await page.evaluate(() => window.host.post({ type: 'qingyu:spatial:flush', requestId: 'flush-two' }))
  assert.equal(await page.evaluate(() => window.host.replies.length), 0)
  await page.evaluate(() => window.host.release())
  await page.waitForFunction(() => window.host.replies.some(reply => reply.requestId === 'flush-two'))
  const requests = await page.evaluate(() => window.host.requests)
  assert.deepEqual(requests.map(request => request.expectedRuntimeRevision), [0, 1])
  assert.equal(await name.inputValue(), '第二次修改')
  assert.equal(await page.evaluate(() => window.host.snapshot().world.name), '第二次修改')

  await frame.getByRole('button', { name: '撤销', exact: true }).click()
  await page.waitForFunction(() => window.host.snapshot().world.name === '第一次修改' && window.host.statuses.at(-1)?.pending === 0)
  await frame.getByRole('button', { name: '重做', exact: true }).click()
  await page.waitForFunction(() => window.host.snapshot().world.name === '第二次修改' && window.host.statuses.at(-1)?.pending === 0)

  // 无待提交操作的外部更新同步，不回发命令。
  const count = await page.evaluate(() => window.host.requests.length)
  await page.evaluate(() => window.host.external())
  await name.waitFor()
  await page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelector('.world-name')?.value === '外部世界')
  assert.equal(await page.evaluate(() => window.host.requests.length), count)

  // 有本地操作时保留预览，重试仍用原始提交身份和版本。
  await page.evaluate(() => { window.host.hold = true; window.host.reject = true })
  await name.fill('保留本地修改')
  await name.press('Tab')
  await page.waitForFunction(() => window.host.acks.length === 1)
  await page.evaluate(() => window.host.external())
  await page.waitForFunction(() => !!window.host.statuses.at(-1)?.error)
  assert.equal(await name.inputValue(), '保留本地修改')
  await page.evaluate(() => window.host.release())
  await page.waitForFunction(() => window.host.statuses.at(-1)?.error === '版本冲突')
  const original = await page.evaluate(() => window.host.requests.at(-1))
  await page.evaluate(() => window.host.post({ type: 'qingyu:spatial:retry' }))
  await page.waitForFunction(length => window.host.requests.length === length, count + 2)
  assert.deepEqual(await page.evaluate(() => window.host.requests.at(-1)), original)
  await page.evaluate(() => window.host.post({ type: 'qingyu:spatial:reload', snapshot: window.host.snapshot() }))
  await page.waitForFunction(() => window.host.statuses.at(-1)?.pending === 0 && !window.host.statuses.at(-1)?.error)
  assert.equal(await name.inputValue(), '外部世界')
  await page.screenshot({ path: join(output, 'embedded-stage0.png'), fullPage: true })
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'embedded-stage0-result.json'), JSON.stringify({ passed: true, scenarios: 8, requests: await page.evaluate(() => window.host.requests), errors }, null, 2))
  console.log('Embedded browser regression: 8 scenarios passed (AI start/assistant entries, merged header/switch, queue, flush, undo/redo, external sync, conflict, explicit reload)')
} finally {
  await browser?.close()
  server.kill()
}
