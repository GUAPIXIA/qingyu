const fs = require('fs')
const { execSync } = require('child_process')
const adb = 'D:/Code/android-sdk/platform-tools/adb.exe'
const serial = 'emulator-5556'

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function dump(name) {
  try {
    execSync(`"${adb}" -s ${serial} shell uiautomator dump /sdcard/ui.xml`, { stdio: 'pipe' })
  } catch {}
  execSync(`"${adb}" -s ${serial} pull /sdcard/ui.xml output/pce01/${name}.xml`, { stdio: 'pipe' })
  const t = fs.readFileSync(`output/pce01/${name}.xml`, 'utf8')
  const texts = [...t.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter(Boolean)
  console.log('[' + name + ']', texts.slice(0, 25).join(' | '))
  return t
}

function tapText(t, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`text="${esc}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)
  const m = t.match(re)
  if (!m) {
    console.log('NOT FOUND', label)
    return false
  }
  const x = Math.floor((+m[1] + +m[3]) / 2)
  const y = Math.floor((+m[2] + +m[4]) / 2)
  console.log('TAP', label, x, y)
  execSync(`"${adb}" -s ${serial} shell input tap ${x} ${y}`, { stdio: 'pipe' })
  return true
}

function tapDesc(t, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`content-desc="${esc}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)
  const m = t.match(re)
  if (!m) return false
  const x = Math.floor((+m[1] + +m[3]) / 2)
  const y = Math.floor((+m[2] + +m[4]) / 2)
  console.log('TAP-DESC', label, x, y)
  execSync(`"${adb}" -s ${serial} shell input tap ${x} ${y}`, { stdio: 'pipe' })
  return true
}

execSync(`"${adb}" -s ${serial} shell am start -n com.qingyu.companion/.MainActivity`, { stdio: 'pipe' })
sleep(2000)

let t = dump('s0')
if (t.includes('创建本地资料并进入')) {
  tapText(t, '创建本地资料并进入')
  sleep(4000) // 等 Room 初始化
  t = dump('s1-main')
}

console.log('is main?', t.includes('本地模式') || t.includes('暂无会话'))

if (tapDesc(t, '设置') || tapText(t, '设置')) {
  sleep(1500)
  t = dump('s2-settings')
}

for (let i = 0; i < 8 && !t.includes('同步中心'); i++) {
  execSync(`"${adb}" -s ${serial} shell input swipe 720 1400 720 850 250`, { stdio: 'pipe' })
  sleep(450)
  t = dump('s2-scroll' + i)
}

if (t.includes('同步中心')) {
  // 只点 title 节点（若 title 与副标题同一节点，点上半部）
  const m = t.match(/text="同步中心"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  if (m) {
    const x = Math.floor((+m[1] + +m[3]) / 2)
    const y = Math.floor(+m[2] + 12) // 节点上沿附近
    console.log('TAP sync-center upper', x, y, 'node', m[1], m[2], m[3], m[4])
    execSync(`"${adb}" -s ${serial} shell input tap ${x} ${y}`, { stdio: 'pipe' })
    sleep(2000)
    const sc = dump('s3-sync-center')
    try {
      execSync(`"${adb}" -s ${serial} exec-out screencap -p > output/pce01/mumu-sync-center.png`, { shell: true })
    } catch {}
    const ok = sc.includes('本地未同步更改') || sc.includes('同步目标') || sc.includes('开始同步') || sc.includes('局域网')
    console.log('SYNC_CENTER_OPEN', ok)
    if (ok && tapText(sc, '局域网（PC）')) {
      sleep(2000)
      const lan = dump('s4-lan-auth')
      try {
        execSync(`"${adb}" -s ${serial} exec-out screencap -p > output/pce01/mumu-lan-auth.png`, { shell: true })
      } catch {}
      console.log('LAN_AUTH_OPEN', lan.includes('扫描') || lan.includes('短认证') || lan.includes('授权'))
    }
  }
} else {
  console.log('sync center not visible')
}
console.log('DONE')
