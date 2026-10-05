// 宿主与客户端之间的协议：Windows 本地命名管道上的行分隔 JSON。
// 约定：一行一个 JSON 对象；请求 { id, token, method, params }；响应 { id, ok, result | error }。
import { connect } from 'node:net'

export const PIPE_PREFIX = '\\\\.\\pipe\\qingyu-pc-agent-'

export function pipePathFor(hostId) {
  return `${PIPE_PREFIX}${hostId}`
}

export function encodeMessage(payload) {
  return `${JSON.stringify(payload)}\n`
}

/** 把数据流切成完整 JSON 消息；解析失败的消息通过 onInvalid 上报而不是静默丢弃 */
export function createLineDecoder(onMessage, onInvalid = () => {}) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        try {
          onMessage(JSON.parse(line))
        } catch (error) {
          onInvalid(line, error)
        }
      }
      index = buffer.indexOf('\n')
    }
  }
}

/** 一个请求/响应通道，两侧共用（宿主用 socket，客户端用连接） */
export class JsonChannel {
  constructor(socket) {
    this.socket = socket
    this.pending = new Map()
    this.handlers = new Map()
    this.closed = false
    this.socket.on('data', createLineDecoder(
      (message) => this.#onMessage(message),
      (line, error) => this.onInvalid?.(line, error),
    ))
    this.socket.on('close', () => {
      this.closed = true
      for (const [, reject] of this.pending) reject(new Error('CHANNEL_CLOSED：连接已关闭'))
      this.pending.clear()
    })
  }

  #onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.ok) resolve(message.result)
      else reject(Object.assign(new Error(message.error?.message ?? '请求失败'), { code: message.error?.code, detail: message.error }))
      return
    }
    const handler = this.handlers.get(message.method)
    if (handler) handler(message)
  }

  send(payload) {
    if (this.closed) throw new Error('CHANNEL_CLOSED：连接已关闭')
    this.socket.write(encodeMessage(payload))
  }

  request(method, params = {}, { timeoutMs = 600000 } = {}) {
    const id = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`请求超时（${method}）`), { code: 'TIMEOUT' }))
      }, timeoutMs) : null
      this.pending.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value) },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error) },
      })
      this.send({ id, method, params })
    })
  }

  close() {
    this.closed = true
    this.socket.destroy()
  }
}

export function connectPipe(pipePath, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接宿主管道超时：${pipePath}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
