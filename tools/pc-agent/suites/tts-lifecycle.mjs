// 真实 TTS 旅程：产品朗读链路（真实合成音频）+ 状态机 + 第三方 provider 兼容性核对。
//
// 真实合成用 edge provider（无需密钥）。若设置了 PC_AGENT_TTS_KEY_FILE，则额外核对
// 小米 MiMo TTS 与产品 openai 兼容路径的兼容性（当前预期为不兼容，作为集成缺口记录）。
import { readFileSync } from 'node:fs'
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

const XIAOMI_BASE_URL = 'https://api.xiaomimimo.com/v1'
const XIAOMI_TTS_MODEL = 'mimo-v2.5-tts'

export const ttsLifecycleSuite = {
  id: 'tts.lifecycle',
  description: '真实 TTS：朗读合成、状态机、音色列表与第三方 provider 兼容性',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })

    await recorder.step('朗读状态基线可读', async () => {
      const state = await invoke('tts.getState', [], { purpose: 'observe' })
      recorder.expect(['idle', 'speaking', 'paused'].includes(state?.state), `state=${JSON.stringify(state)}`)
      return `state=${state.state}`
    })

    await recorder.step('列出音色（edge provider）', async () => {
      const voices = await invoke('tts.listVoices', ['edge'], { purpose: 'observe' })
      recorder.expect(Array.isArray(voices) && voices.length > 0, `音色列表为空：${JSON.stringify(voices)?.slice(0, 100)}`)
      return `${voices.length} 个音色，首个=${typeof voices[0] === 'string' ? voices[0] : voices[0]?.name ?? JSON.stringify(voices[0]).slice(0, 40)}`
    })

    await recorder.step('真实朗读合成（edge，返回真实音频）', async () => {
      const result = await invoke('tts.speak', ['你好，这是轻语语音合成测试。', {
        provider: 'edge',
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: 1,
      }], { timeoutMs: 120000 })
      recorder.expect(result?.success === true, `朗读失败：${JSON.stringify(result)?.slice(0, 200)}`)
      const audio = String(result.audioBase64 ?? '')
      recorder.expect(audio.length > 1000, `音频数据过小：${audio.length} 字符`)
      const bytes = Buffer.from(audio, 'base64')
      const magic = bytes.subarray(0, 3).toString('hex')
      recorder.expect(/^494433|^fffb|^fff3/.test(magic), `音频魔数不像 MP3：${magic}`)
      return `mp3 ${Math.round(bytes.length / 1024)} KB（magic=${magic}）`
    })

    await recorder.step('停止朗读后状态回到 idle', async () => {
      const stopped = await invoke('tts.stop', [])
      recorder.expect(stopped?.success === true, `停止失败：${JSON.stringify(stopped)?.slice(0, 120)}`)
      const state = await invoke('tts.getState', [], { purpose: 'observe' })
      recorder.expect(state?.state === 'idle', `停止后 state=${state?.state}`)
      return `state=${state.state}`
    })

    const keyFile = process.env.PC_AGENT_TTS_KEY_FILE
    if (!keyFile) {
      recorder.skip('小米 MiMo TTS（产品 xiaomi provider）真实合成', '未提供 PC_AGENT_TTS_KEY_FILE；该项用于验证小米 MiMo TTS 提供商')
    } else {
      const apiKey = readFileSync(keyFile, 'utf8').trim()

      await recorder.step('小米 MiMo TTS（产品 xiaomi provider）真实合成', async () => {
        const result = await invoke('tts.speak', ['你好，这是小米语音合成测试。', {
          provider: 'xiaomi',
          baseUrl: XIAOMI_BASE_URL,
          model: XIAOMI_TTS_MODEL,
          apiKey,
          voice: 'mimo_default',
        }], { timeoutMs: 120000 })
        recorder.expect(result?.success === true, `小米 TTS 合成失败：${JSON.stringify(result)?.slice(0, 200)}`)
        const bytes = Buffer.from(String(result.audioBase64 ?? ''), 'base64')
        recorder.expect(bytes.length > 1000, `音频数据过小：${bytes.length} 字节`)
        const magic = bytes.subarray(0, 3).toString('hex')
        recorder.expect(/^494433|^fffb|^fff3|^fff2/.test(magic), `音频魔数不像 MP3：${magic}`)
        return `mp3 ${Math.round(bytes.length / 1024)} KB（magic=${magic}）`
      })

      await recorder.step('设计回归守卫：openai 兼容路径对小米端点仍不适用', async () => {
        // 小米没有 /audio/speech，因此 xiaomi 必须走独立适配器；若有人把小米改成 openai 兼容路径，
        // 这一步会失败（说明回归了）。反之若小米将来提供 /audio/speech，本步骤也应更新。
        const result = await invoke('tts.speak', ['设计回归守卫。', {
          provider: 'openai',
          baseUrl: XIAOMI_BASE_URL,
          model: XIAOMI_TTS_MODEL,
          apiKey,
          voice: 'mimo_default',
        }], { timeoutMs: 120000 })
        if (result?.success === true) {
          recorder.skip('设计回归守卫：openai 兼容路径对小米端点仍不适用', '小米端点现已支持 /audio/speech，两个 provider 可合并——需重新评估适配器设计')
          return '小米端点已支持 /audio/speech'
        }
        const message = String(result?.error ?? '')
        recorder.expect(/404/.test(message), `错误信息未体现端点不匹配：${message.slice(0, 120)}`)
        return `openai 路径仍 404（符合设计）：${message.slice(0, 60)}`
      })
    }

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { provider: 'edge', xiaomiModel: XIAOMI_TTS_MODEL },
    })
  },
}
