import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const port = 5197
const url = `http://127.0.0.1:${port}/`
const server = spawn(process.execPath, [
  join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: root, stdio: 'ignore' })

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error('Vite exited before becoming ready')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite did not become ready')
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch {
    return chromium.launch({ channel: 'chrome', headless: true })
  }
}

let browser
let page
try {
  await waitForServer()
  browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  await page.goto(url)
  await page.locator('.react-flow__pane').waitFor()
  await page.waitForTimeout(350)

  if (process.env.SPATIAL_CAPTURE_SCREENSHOT) {
    const output = join(root, 'output', 'playwright')
    await mkdir(output, { recursive: true })
    await page.screenshot({ path: join(output, 'spatial-board-empty.png'), fullPage: true })
  }

  // Draw a region with the real mouse, then edit it through the inspector.
  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  assert(box, 'canvas pane has a bounding box')
  await page.getByText('从一片区域开始').waitFor()
  await page.locator('.canvas-empty-actions button.primary').click()
  const start = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.4 }
  const end = { x: start.x + 230, y: start.y + 170 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await page.mouse.up()
  const region = page.locator('.rf-region:not(.offstage)').first()
  await region.waitFor()
  await region.click()
  assert.equal(await page.getByRole('button', { name: '创建内部画板', exact: true }).count(), 0)
  assert.equal(await page.getByRole('navigation', { name: '画板层级' }).count(), 0)
  assert.equal(await page.locator('.inspector').getByText('分类', { exact: true }).count(), 0)
  assert.equal(await page.locator('.inspector').getByText('自定义分类标签', { exact: true }).count(), 0)
  assert.equal(await region.locator('.rf-sub').count(), 0)
  const name = page.locator('.inspector .field input').first()
  await name.fill('浏览器回归区域')
  await name.blur()
  await page.getByText('浏览器回归区域').first().waitFor()

  // Zoom and verify that opening or closing panels preserves the viewport.
  await page.getByRole('button', { name: '放大画布' }).click()
  await page.waitForTimeout(400)
  const viewport = page.locator('.react-flow__viewport')
  await pane.click({ position: { x: 20, y: 20 } })
  await page.waitForTimeout(300)
  const beforePanels = await viewport.getAttribute('style')
  await region.click()
  await page.waitForTimeout(450)
  assert.equal(await viewport.getAttribute('style'), beforePanels, 'inspector preserved viewport')
  await page.getByRole('button', { name: '切换剧情模拟面板' }).click()
  await page.waitForTimeout(450)
  assert.equal(await viewport.getAttribute('style'), beforePanels, 'story panel preserved viewport')
  await page.getByRole('button', { name: '切换剧情模拟面板' }).click()
  await page.getByRole('button', { name: '角色托盘' }).click()
  await page.waitForTimeout(450)
  assert.equal(await viewport.getAttribute('style'), beforePanels, 'actor tray preserved viewport')

  // Drag a new actor from the tray onto the drawn region.
  await page.getByPlaceholder('新角色名').fill('回归角色')
  await page.getByRole('button', { name: '加', exact: true }).click()
  await page.locator('.tray-item').filter({ hasText: '回归角色' }).dragTo(region)
  const actor = page.locator('.rf-actor').filter({ hasText: '回归角色' }).first()
  await actor.waitFor()
  assert.match(await actor.getAttribute('title'), /浏览器回归区域/, 'actor anchored to drawn region')

  // The place tool must work directly inside a region and center the node at the click.
  await page.locator('.tool-btn').filter({ hasText: '地点' }).click()
  const regionBox = await region.boundingBox()
  assert(regionBox, 'region has a bounding box')
  const placePoint = {
    x: regionBox.x + regionBox.width * 0.75,
    y: regionBox.y + regionBox.height * 0.28,
  }
  await page.mouse.click(placePoint.x, placePoint.y)
  const place = page.locator('.react-flow__node-place').first()
  await place.waitFor()
  const placeBox = await place.boundingBox()
  assert(placeBox, 'place has a bounding box')
  assert(Math.abs(placeBox.x + placeBox.width / 2 - placePoint.x) < 6, 'place centered horizontally')
  assert(Math.abs(placeBox.y + placeBox.height / 2 - placePoint.y) < 6, 'place centered vertically')

  // A single add action creates a leaf structure; leaves have no add or internal-board action.
  await page.keyboard.press('Escape')
  await place.click()
  assert.equal(await page.getByText('子画板', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '创建内部画板', exact: true }).count(), 0)
  await place.hover()
  await place.getByRole('button', { name: '添加子结构', exact: true }).click()
  const child = page.locator('.rf-place.chip').filter({ hasText: '子结构 1' }).first()
  await child.waitFor()
  assert.equal(await child.getByRole('button', { name: '添加子结构', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '添加楼层', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '添加房间', exact: true }).count(), 0)
  await child.click()
  assert.equal(await page.locator('.inspector').getByText('分类', { exact: true }).count(), 0)
  assert.equal(await page.locator('.inspector').getByText('自定义分类标签', { exact: true }).count(), 0)
  assert.equal(await page.locator('.inspector').getByRole('button', { name: '添加子结构', exact: true }).count(), 0)
  assert.equal(await page.locator('.inspector').getByRole('button', { name: '创建内部画板', exact: true }).count(), 0)
  if (process.env.SPATIAL_CAPTURE_SCREENSHOT) {
    const output = join(root, 'output', 'playwright')
    await mkdir(output, { recursive: true })
    await page.screenshot({ path: join(output, 'spatial-board-substructure.png'), fullPage: true })
    await page.screenshot({ path: join(output, 'spatial-board-without-categories.png'), fullPage: true })
  }

  if (process.env.SPATIAL_CAPTURE_SCREENSHOT) {
    const output = join(root, 'output', 'playwright')
    await mkdir(output, { recursive: true })
    await page.screenshot({ path: join(output, 'spatial-board-current.png'), fullPage: true })
  }

  // Inspector and file actions stay out of the way until requested.
  const paneBeforeClose = await pane.boundingBox()
  await page.getByRole('button', { name: '关闭属性面板' }).click()
  await page.locator('.panel-wrap').waitFor({ state: 'detached' })
  await page.waitForTimeout(250)
  const paneAfterClose = await pane.boundingBox()
  assert(paneBeforeClose && paneAfterClose && paneAfterClose.width > paneBeforeClose.width + 200,
    `canvas did not expand: before=${paneBeforeClose?.width}, after=${paneAfterClose?.width}`)
  assert.equal(await page.locator('.top-menu-trigger svg circle').count(), 3, 'file menu icon has three dots')
  await page.getByRole('button', { name: '文件与画板操作' }).click()
  await page.getByRole('button', { name: '导入 JSON' }).waitFor()
  if (process.env.SPATIAL_CAPTURE_SCREENSHOT) {
    const output = join(root, 'output', 'playwright')
    await page.screenshot({ path: join(output, 'spatial-board-menu.png'), fullPage: true })
  }
  await pane.click({ position: { x: 20, y: 20 } })
  assert.equal(await page.locator('.top-file-menu').count(), 0, 'file menu closes outside')

  // The complete world and runtime must survive a real page reload.
  await page.locator('.status-bar').getByText('已保存', { exact: true }).waitFor()
  await page.reload()
  await page.getByText('浏览器回归区域').first().waitFor()
  const restoredActor = page.locator('.rf-actor').filter({ hasText: '回归角色' }).first()
  await restoredActor.waitFor()
  assert.match(await restoredActor.getAttribute('title'), /浏览器回归区域/)
  await page.locator('.react-flow__node-place').first().waitFor()
  await page.getByText('已恢复草稿').waitFor()
  // Existing internal-board data remains intact, but offers no badge or navigation gesture.
  const legacyBoardId = await page.evaluate(async () => {
    const { useSpatialStore } = await import('/src/store/spatialStore.ts')
    const store = useSpatialStore.getState()
    const entry = store.core.world.nodes.find(node => node.name === '浏览器回归区域')
    const childBoardId = store.createInternalBoard(entry.id)
    store.goRootBoard()
    return childBoardId
  })
  assert(legacyBoardId)
  await region.locator('.rf-title').dblclick()
  assert.equal(await page.getByText('有内部画板', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '进入内部画板 →', exact: true }).count(), 0)
  assert.equal(await page.getByRole('navigation', { name: '画板层级' }).count(), 0)
  const legacyView = await page.evaluate(async () => {
    const { useSpatialStore } = await import('/src/store/spatialStore.ts')
    const state = useSpatialStore.getState()
    return { current: state.currentBoardId, root: state.core.world.rootBoardId, boards: state.core.world.boards.map(board => board.id) }
  })
  assert.equal(legacyView.current, legacyView.root, 'double-click stays on the root board')
  assert(legacyView.boards.includes(legacyBoardId), 'legacy child board retained')
  if (process.env.SPATIAL_CAPTURE_SCREENSHOT) {
    await page.screenshot({ path: join(root, 'output', 'playwright', 'spatial-board-hidden-child-boards.png'), fullPage: true })
  }
  await page.setViewportSize({ width: 900, height: 640 })
  const dock = await page.locator('.tool-dock').boundingBox()
  assert(dock && dock.y >= 58 && dock.y + dock.height <= 640 - 34, 'floating dock fits compact viewport')
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 900, 'no horizontal page overflow')
  if (process.env.SPATIAL_CAPTURE_SCREENSHOT) {
    const output = join(root, 'output', 'playwright')
    await page.screenshot({ path: join(output, 'spatial-board-compact.png'), fullPage: true })
  }
  console.log('Browser regression OK: floating dock, onboarding, draw, panels, actor drop, place in region, reload')
} catch (error) {
  if (page) {
    const output = join(root, 'output', 'playwright')
    await mkdir(output, { recursive: true })
    await page.screenshot({ path: join(output, 'spatial-browser-failure.png'), fullPage: true })
  }
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  server.kill()
}
