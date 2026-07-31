import type { IpcMain } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { createLogger } from '../services/logger'

const log = createLogger('tts')

let psProcess: ChildProcessWithoutNullStreams | null = null
let speechState: 'idle' | 'speaking' | 'paused' = 'idle'
let initPromise: Promise<void> | null = null

/** H-06 修复：命令队列，串行化 TTS 命令 */
let commandQueue: Promise<void> = Promise.resolve()

/** PowerShell 脚本：持久进程，从 stdin 读取 JSON 命令 */
const PS_SCRIPT = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$pendingPrompt = $null

function Handle-Command {
    param([string]$line)
    try {
        $cmd = $line | ConvertFrom-Json
        switch ($cmd.action) {
            'speak' {
                $synth.SpeakAsyncCancelAll()
                $pendingPrompt = $synth.SpeakAsync($cmd.text)
                Write-Output '{"status":"speaking"}'
            }
            'pause' {
                $synth.Pause()
                Write-Output '{"status":"paused"}'
            }
            'resume' {
                $synth.Resume()
                Write-Output '{"status":"speaking"}'
            }
            'stop' {
                $synth.SpeakAsyncCancelAll()
                $pendingPrompt = $null
                Write-Output '{"status":"idle"}'
            }
            'setVoice' {
                try { $synth.SelectVoice($cmd.voice) } catch {}
                Write-Output '{"status":"ok"}'
            }
            'setRate' {
                $synth.Rate = [int]$cmd.rate
                Write-Output '{"status":"ok"}'
            }
            'getState' {
                Write-Output ('{"status":"' + $script:speechState + '"}')
            }
            default {
                Write-Output '{"status":"unknown"}'
            }
        }
    } catch {
        Write-Output '{"status":"error","message":"$($_.Exception.Message)"}'
    }
    [Console]::Out.Flush()
}

# 监控语音完成事件
function OnSpeakCompleted {
    $script:speechState = 'idle'
    Write-Output '{"status":"completed"}'
    [Console]::Out.Flush()
}

# 注册事件
$null = Register-ObjectEvent -InputObject $synth -EventName SpeakCompleted -Action {
    $script:speechState = 'idle'
    Write-Output '{"status":"completed"}'
    [Console]::Out.Flush()
}

# 主循环：从 stdin 读取命令
while ($line = [Console]::In.ReadLine()) {
    if ($line -eq 'exit') { break }
    if ($line.Trim()) {
        $script:speechState = 'speaking'
        Handle-Command $line
    }
}

$synth.SpeakAsyncCancelAll()
$synth.Dispose()
`.trim()

/** 确保 PowerShell 进程已启动 */
async function ensureProcess(): Promise<void> {
  if (psProcess && !psProcess.killed) return
  if (initPromise) return initPromise

  initPromise = new Promise((resolve, reject) => {
    psProcess = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', PS_SCRIPT,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let initialized = false

    // R-01 修复：init 监听器 resolve 后立即移除，防止累积泄漏
    const onInitData = () => {
      if (!initialized) {
        initialized = true
        psProcess?.stdout?.off('data', onInitData)
        resolve()
      }
    }
    psProcess.stdout?.on('data', onInitData)

    psProcess.on('error', (err) => {
      initPromise = null
      reject(err)
    })

    psProcess.on('exit', () => {
      psProcess = null
      speechState = 'idle'
      initPromise = null
    })

    // 超时保护
    setTimeout(() => {
      if (!initialized) {
        initialized = true
        psProcess?.stdout?.off('data', onInitData)
        resolve() // 即使没收到输出也继续
      }
    }, 3000)
  })

  return initPromise
}

/** 发送命令到 PowerShell 进程（H-06 修复：通过队列串行化，避免竞态） */
function sendCommand(cmd: object): Promise<any> {
  const task = commandQueue.then(async () => {
    await ensureProcess()
    if (!psProcess || !psProcess.stdin || !psProcess.stdout) {
      throw new Error('PowerShell 进程未就绪')
    }

    const cmdStr = JSON.stringify(cmd)
    return new Promise<any>((resolve) => {
      const onData = (data: Buffer) => {
        const text = data.toString().trim()
        if (!text) return
        try {
          const result = JSON.parse(text)
          psProcess?.stdout?.off('data', onData)
          if (result.status === 'speaking') speechState = 'speaking'
          else if (result.status === 'paused') speechState = 'paused'
          else if (result.status === 'idle' || result.status === 'completed') speechState = 'idle'
          resolve(result)
        } catch {
          // 非 JSON 输出，忽略
        }
      }

      psProcess.stdout.on('data', onData)
      psProcess.stdin.write(cmdStr + '\n')

      // 超时
      setTimeout(() => {
        psProcess?.stdout?.off('data', onData)
        resolve({ status: 'timeout' })
      }, 10000)
    })
  })

  // 更新队列（捕获错误防止队列卡死）
  commandQueue = task.then(() => {}, () => {})
  return task
}

/** 获取系统语音列表 */
async function getVoices(): Promise<{ id: string; name: string; lang: string }[]> {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Speech;
       $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
       $synth.GetInstalledVoices() | ForEach-Object { 
         $info = $_.VoiceInfo;
         Write-Output ($info.Id + '|' + $info.Name + '|' + $info.Culture.Name)
       }`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let output = ''
    proc.stdout?.on('data', (data) => { output += data.toString() })
    proc.on('exit', () => {
      const voices = output.trim().split('\n')
        .filter((l) => l.trim())
        .map((line) => {
          const [id, name, lang] = line.trim().split('|')
          return { id: id || name, name: name || id, lang: lang || 'zh-CN' }
        })
      resolve(voices)
    })
    proc.on('error', () => resolve([]))
  })
}

/** 杀死 TTS PowerShell 进程（应用退出时调用） */
export function killTTS(): void {
  if (psProcess && !psProcess.killed) {
    try {
      psProcess.stdin.write('exit\n')
      psProcess.kill()
    } catch { /* ignore */ }
    psProcess = null
    speechState = 'idle'
    initPromise = null
  }
}

// ===================== OpenAI 兼容 TTS（3.2-A） =====================

/** OpenAI TTS 预设音色 */
export const OPENAI_VOICES = [
  { id: 'alloy', name: 'alloy（中性）', lang: '多语言' },
  { id: 'echo', name: 'echo（沉稳）', lang: '多语言' },
  { id: 'fable', name: 'fable（叙述）', lang: '多语言' },
  { id: 'onyx', name: 'onyx（低沉）', lang: '多语言' },
  { id: 'nova', name: 'nova（女性）', lang: '多语言' },
  { id: 'shimmer', name: 'shimmer（明亮）', lang: '多语言' },
  { id: 'ash', name: 'ash（中性）', lang: '多语言' },
  { id: 'ballad', name: 'ballad（叙述）', lang: '多语言' },
  { id: 'coral', name: 'coral（温暖）', lang: '多语言' },
  { id: 'sage', name: 'sage（柔和）', lang: '多语言' },
] as const

/** OpenAI 兼容 TTS：POST {baseUrl}/audio/speech → mp3 base64 */
export async function openaiSpeak(
  config: { baseUrl: string; apiKey: string; model: string; voice: string; speed?: number },
  text: string,
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/audio/speech`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model || 'tts-1',
      input: text.slice(0, 4000),
      voice: config.voice || 'alloy',
      speed: config.speed ?? 1,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`TTS 错误 ${response.status}: ${errText.slice(0, 300)}`)
  }
  const buf = await response.arrayBuffer()
  return Buffer.from(buf).toString('base64')
}

export function registerTTSIPC(ipcMain: IpcMain): void {
  // 朗读（provider 分发：openai 走 API 返回音频；system/edge 走本地引擎）
  ipcMain.handle('tts:speak', async (
    _e,
    text: string,
    opts: {
      provider?: string
      voice?: string
      rate?: number
      model?: string
      apiKey?: string
      baseUrl?: string
    } = {},
  ) => {
    try {
      // OpenAI 兼容 TTS：返回 mp3 base64，由渲染进程播放
      if (opts.provider === 'openai') {
        if (!opts.apiKey) return { success: false, error: 'OpenAI TTS 未配置 API Key' }
        const audioBase64 = await openaiSpeak(
          {
            baseUrl: opts.baseUrl || 'https://api.openai.com/v1',
            apiKey: opts.apiKey,
            model: opts.model || 'tts-1',
            voice: opts.voice || 'alloy',
            speed: opts.rate ?? 1,
          },
          text,
        )
        log.info('OpenAI TTS 朗读', { textLen: text.length, voice: opts.voice, model: opts.model })
        return { success: true, audioBase64 }
      }

      // 系统语音引擎（原逻辑）
      if (opts.voice) await sendCommand({ action: 'setVoice', voice: opts.voice })
      if (opts.rate !== undefined) await sendCommand({ action: 'setRate', rate: opts.rate })
      await sendCommand({ action: 'speak', text })
      log.info('TTS 朗读（系统语音）', { textLen: text.length, voice: opts.voice })
      return { success: true }
    } catch (e) {
      log.error('TTS 朗读失败', { error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  })

  // 暂停
  ipcMain.handle('tts:pause', async () => {
    await sendCommand({ action: 'pause' })
    speechState = 'paused'
    return { success: true }
  })

  // 恢复
  ipcMain.handle('tts:resume', async () => {
    await sendCommand({ action: 'resume' })
    speechState = 'speaking'
    return { success: true }
  })

  // 停止
  ipcMain.handle('tts:stop', async () => {
    await sendCommand({ action: 'stop' })
    speechState = 'idle'
    return { success: true }
  })

  // 获取状态
  ipcMain.handle('tts:getState', async () => {
    return { state: speechState }
  })

  // 获取语音列表
  ipcMain.handle('tts:getVoices', async (_e, provider?: string) => {
    if (provider === 'openai') return OPENAI_VOICES
    const voices = await getVoices()
    log.info('已获取语音列表', { count: voices.length })
    return voices
  })
}
