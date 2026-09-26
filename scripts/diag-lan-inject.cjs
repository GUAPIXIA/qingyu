const fs = require('fs')
const { execFileSync } = require('child_process')
const adb = 'D:/Code/android-sdk/platform-tools/adb.exe'
const serial = 'emulator-5556'

function pullUi(name) {
  try {
    execFileSync(adb, ['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/ui.xml'], { stdio: 'pipe' })
  } catch {}
  execFileSync(adb, ['-s', serial, 'pull', '/sdcard/ui.xml', `output/pce01/${name}.xml`], { stdio: 'pipe' })
  const t = fs.readFileSync(`output/pce01/${name}.xml`, 'utf8')
  const texts = [...t.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter(Boolean)
  console.log('UI:', texts.join(' | '))
  return texts
}

function logcat() {
  try {
    const out = execFileSync(adb, ['-s', serial, 'shell', 'logcat', '-d'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    const lines = out.split(/\r?\n/).filter((l) => /SyncQrInject|LanSync|OkHttp|sync_qr|FATAL|AndroidRuntime/.test(l))
    console.log(lines.slice(-25).join('\n'))
  } catch (e) {
    console.log('logcat err', e.message)
  }
}

pullUi('lan-now')
logcat()
