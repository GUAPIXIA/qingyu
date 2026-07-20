import type { IpcMain } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'

let psProcess: ChildProcessWithoutNullStreams | null = null
let speechState: 'idle' | 'speaking' | 'paused' = 'idle'
let initPromise: Promise<void> | null = null

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

    psProcess.stdout?.on('data', () => {
      if (!initialized) {
        initialized = true
        resolve()
      }
    })

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
        resolve() // 即使没收到输出也继续
      }
    }, 3000)
  })

  return initPromise
}

/** 发送命令到 PowerShell 进程 */
function sendCommand(cmd: object): Promise<any> {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureProcess()
      if (!psProcess || !psProcess.stdin || !psProcess.stdout) {
        reject(new Error('PowerShell 进程未就绪'))
        return
      }

      const cmdStr = JSON.stringify(cmd)
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
    } catch (e) {
      reject(e)
    }
  })
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
      return { success: true }
    } catch (e) {
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
    return await getVoices()
  })
}
