const fs = require('fs')
const path = 'output/pce01/mumu-ui-startup.xml'
if (!fs.existsSync(path)) {
  console.log('missing ui dump')
  process.exit(0)
}
const t = fs.readFileSync(path, 'utf8')
const texts = [...t.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter(Boolean)
const desc = [...t.matchAll(/content-desc="([^"]+)"/g)].map((m) => m[1]).filter(Boolean)
console.log('TEXTS:', texts.slice(0, 50).join(' | '))
console.log('DESC:', desc.slice(0, 20).join(' | '))
console.log('nodes', (t.match(/<node/g) || []).length)
