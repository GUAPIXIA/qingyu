#!/usr/bin/env node
// 受控动作登记：settings.saveAPICredential（默认关闭，需会话显式授权）。
//
// 背景：真实模型验证需要把用户本机密钥写入**隔离档案**。实测证明跨进程注入不可行——
// Electron safeStorage 的密钥绑定在启动该进程的 userData 上，外部进程写入的密文产品侧解不开
// （`Error while decrypting the ciphertext`）。因此改为走产品自己的凭据写入 IPC，
// 但保持默认禁用：只有会话显式声明 `--allow-credential-write` 才放行，密钥经参数传入并在证据中脱敏。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve('tools/pc-agent/catalog/settings.json')
const doc = JSON.parse(readFileSync(path, 'utf8'))
const action = doc.actions.find((item) => item.id === 'settings.saveAPICredential')
if (!action) {
  console.error('未找到 settings.saveAPICredential')
  process.exit(1)
}
action.status = 'mapped'
action.description = '写入连接档案的 API 凭据（默认关闭；需会话 --allow-credential-write 显式授权）'
action.layer = 'ipc'
action.write = true
action.requires = ['credential-write']
action.pendingReason = null
action.assertions = ['写入后该档案可用于真实生成']
action.sideEffect = '把凭据加密写入隔离档案的 credentials.json'
action.redactKeys = []
action.control = false
action.awaitTask = null
action.cancelable = false
writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log('已登记受控动作：settings.saveAPICredential（requires: credential-write）')
