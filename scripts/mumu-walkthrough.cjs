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
  } catch {
    // MuMu 上 uiautomator 常以 139 退出但仍写出 xml
  }
  execSync(`"${adb}" -s ${serial} pull /sdcard/ui.xml output/pce01/${name}.xml`, { stdio: 'pipe' })
  const t = fs.readFileSync(`output/pce01/${name}.xml`, 'utf8')
  const texts = [...t.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter(Boolean)
  console.log(name, '=>', texts.slice(0, 40).join(' | '))
  return t
}

function tapText(t, label) {
  const re = new RegExp(`text="${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)
  const m = t.match(re)
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

const t1 = dump('mumu-ui-1')
tapText(t1, '创建本地资料并进入')
sleep(3000)
const t2 = dump('mumu-ui-2')
if (tapText(t2, '设置')) {
  sleep(2000)
  const t3 = dump('mumu-ui-settings')
  if (tapText(t3, '同步中心')) {
    sleep(2000)
    dump('mumu-ui-sync-center')
  }
}
try {
  execSync(`"${adb}" -s ${serial} exec-out screencap -p > output/pce01/mumu-final.png`, { shell: true })
} catch {}
console.log('done')
