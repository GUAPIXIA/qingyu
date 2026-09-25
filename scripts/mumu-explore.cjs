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
  const descs = [...t.matchAll(/content-desc="([^"]+)"/g)].map((m) => m[1]).filter(Boolean)
  console.log(name, 'TEXT:', texts.slice(0, 30).join(' | '))
  console.log(name, 'DESC:', descs.slice(0, 30).join(' | '))
  return t
}

function tapLabel(t, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re = new RegExp(`text="${esc}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)
  let m = t.match(re)
  if (!m) {
    re = new RegExp(`content-desc="${esc}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)
    m = t.match(re)
  }
  if (!m) {
    console.log('NOT FOUND', label)
    return false
  }
  const x = Math.floor((+m[1] + +m[3]) / 2)
  const y = Math.floor((+m[2] + +m[4]) / 2)
  execSync(`"${adb}" -s ${serial} shell input tap ${x} ${y}`, { stdio: 'pipe' })
  console.log('TAP', label, x, y)
  return true
}

const t = dump('mumu-ui-main')
// 常见设置入口
for (const label of ['设置', '同步中心', 'cd_settings', '更多', '⋯', '···', '轻语']) {
  if (tapLabel(t, label)) {
    sleep(1500)
    const t2 = dump('mumu-ui-after-' + label)
    break
  }
}
// 打开 content-hub 相关：点击「角色」页找设置
console.log('--- try 角色 tab ---')
const t3 = fs.readFileSync('output/pce01/mumu-ui-main.xml', 'utf8')
if (tapLabel(t3, '角色')) {
  sleep(1500)
  dump('mumu-ui-characters')
}
