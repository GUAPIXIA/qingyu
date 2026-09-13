/**
 * 开发辅助：从应用数据目录解出「当前活跃连接配置」的 API Key，写入指定文件（不打印明文）。
 *
 * 用途：给 scripts/evaluate-generation.ts 之类的实机评测脚本提供 --key-file，
 * 避免把密钥写进 shell 历史或仓库。
 *
 * 用法：
 *   node_modules/electron/dist/electron.exe scripts/decrypt-api-key.cjs <profileId> <outFile>
 *
 * 说明：应用用 Electron safeStorage 加密凭据。Windows 上该密文为 Chromium OSCrypt 的
 * "v10" 格式（AES-256-GCM，密钥由 Local State 的 os_crypt.encrypted_key 经 DPAPI 保护），
 * 而该密钥**绑定在应用自己的 userData 目录**（Local State 文件）上。
 * 因此这里必须先把 userData 指到应用数据目录，再调用 safeStorage 解密，
 * 否则会因换了一把 key 而报 "Error while decrypting the ciphertext"。不做任何自研密码学处理。
 */
const { app, safeStorage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const [, , profileId, outFile] = process.argv
const appData = join(homedir(), 'AppData', 'Roaming', 'qingyu')
// 必须在 app ready 之前设定，safeStorage 读取的就是这里的 Local State
app.setPath('userData', appData)

app.whenReady().then(() => {
  if (!profileId || !outFile) {
    console.error('用法: electron scripts/decrypt-api-key.cjs <profileId|active> <outFile>')
    app.exit(1)
    return
  }
  const configDir = join(appData, 'data', 'config')
  const creds = JSON.parse(readFileSync(join(configDir, 'credentials.json'), 'utf-8'))
  const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'))
  const activeProfileId = profileId === 'active' ? settings.activeProfileId : profileId
  const encrypted = creds[`profile-${activeProfileId}`]
  if (!encrypted) {
    console.error(`credentials.json 中没有 profile-${activeProfileId}`)
    app.exit(2)
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('safeStorage 不可用（需要桌面会话）')
    app.exit(3)
    return
  }
  const key = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  writeFileSync(outFile, key, 'utf-8')
  console.log(`已写入 ${outFile}（len=${key.length}，前缀 ${key.slice(0, 3)}***）`)
  app.exit(0)
})
