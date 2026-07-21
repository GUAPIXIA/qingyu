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

export function registerTTSIPC(ipcMain: IpcMain): void {
  // 朗读
  ipcMain.handle('tts:speak', async (_e, text: string, voice?: string, rate?: number) => {
    try {
      if (voice) await sendCommand({ action: 'setVoice', voice })
      if (rate !== undefined) await sendCommand({ action: 'setRate', rate })
      await sendCommand({ action: 'speak', text })
      log.info('TTS 朗读', { textLen: text.length, voice })
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
  ipcMain.handle('tts:getVoices', async () => {
    const voices = await getVoices()
    log.info('已获取语音列表', { count: voices.length })
    return voices
  })
}
