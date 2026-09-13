import type { AIAdapter, GateFieldProbe } from './types'
import {
  attachGateProbe,
  createReasoningRunawayGuard,
  createVendorThinkingStreamFilter,
  deleteGateField,
  isReasoningBudgetExhausted,
  matchRejectedGateField,
  withInternalAbort,
  REASONING_BUDGET_EXHAUSTED_MESSAGE,
  stripVendorThinking,
} from './types'
import { normalizeFinishReason } from '../../../shared/generationObservation'
import type { AICompletion } from '../../../shared/types'
import type { GateProbeSignal } from '../../../shared/reasoningGate'
import { sanitizeApiKey } from '../../utils/pathGuard'
import { toOpenAIContent, imageErrorHint } from './vision'

export const openaiAdapter: AIAdapter = {
  async chat(params, onChunk, signal, onUsage) {
    const { baseUrl, apiKey, model, temperature, topP, maxTokens,
            frequencyPenalty, presencePenalty, stream } = params
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

    // Vision：带图片的消息转换为 content 数组格式（无图片消息保持字符串，兼容非视觉服务）
    const messages = toOpenAIContent(params.messages)

    const lowerModel = model.toLowerCase()
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
      stream,
    }

    // 采样参数限制与推理控制无关：o 系 / R1 不接受 temperature/top_p 等字段
    // L-01 修复：用词边界正则避免误匹配（如 gpt-3.5-turbo-1106 含 "o1"）
    const reasoningOnlySampling = /\bo[134](?:-mini)?\b/.test(lowerModel) || lowerModel.includes('deepseek-r1')
    if (reasoningOnlySampling) {
      delete body.temperature
      delete body.top_p
      delete body.frequency_penalty
      delete body.presence_penalty
    }

    // 阶段8（§4.3）：统一门控指令 → 请求体字段。适配器只做机械映射，
    // 不自行猜测档位；缺省时保持现行行为（kill switch 关闭路径，W11 清理旧分支）。
    const gateProbes: GateFieldProbe[] = []
    const gate = params.reasoningGate
    const gateSignal: GateProbeSignal | undefined = gate ? { knob: gate.knob } : undefined
    if (gate) {
      if (gate.knob === 'thinking-disable' && gate.level === 'off') {
        body.thinking = { type: 'disabled' }
        gateProbes.push({
          path: ['thinking'],
          knob: 'thinking-disable',
          isRejected: (text) => /thinking/i.test(text),
        })
      } else if (gate.knob === 'reasoning-effort') {
        const effort = gate.level === 'off' ? 'minimal' : gate.level === 'low' ? 'low' : undefined
        if (effort) {
          body.reasoning_effort = effort
          gateProbes.push({
            path: ['reasoning_effort'],
            knob: 'reasoning-effort',
            isRejected: (text) => /reasoning_effort|reasoning effort/i.test(text),
          })
        }
      } else if (gate.knob === 'thinking-budget') {
        // Qwen3 兼容端：off → enable_thinking:false；其余档位下发 thinking_budget
        if (gate.level === 'off') {
          body.enable_thinking = false
          gateProbes.push({
            path: ['enable_thinking'],
            knob: 'thinking-budget',
            isRejected: (text) => /enable_thinking|enable thinking/i.test(text),
          })
        } else if (gate.tokens != null && gate.tokens > 0) {
          body.thinking_budget = gate.tokens
          gateProbes.push({
            path: ['thinking_budget'],
            knob: 'thinking-budget',
            isRejected: (text) => /thinking_budget|thinking budget/i.test(text),
          })
        }
      }
    } else {
      // 旧分支（kill switch 关闭）：DeepSeek V4 的辅助请求显式关闭思考
      if (params.reasoningMode === 'disabled' && lowerModel.includes('deepseek-v4')) {
        body.thinking = { type: 'disabled' }
        // 旧路径同样纳入字段级降级表（400 明确拒绝才去参重发一次，行为与门控路径一致）
        gateProbes.push({
          path: ['thinking'],
          knob: 'thinking-disable',
          isRejected: (text) => /thinking/i.test(text),
        })
      }
      // 旧分支：o 系 / R1 硬编码 medium（门控在场时改为按档位下发，standard/full 不下发）
      if (reasoningOnlySampling) {
        body.reasoning_effort = 'medium'
      }
    }

    // OpenCode Go 上游约束：kimi-k3 采样参数固定（temperature 仅允许 1、top_p 仅允许 0.95），
    // 不修正会直接 400（invalid temperature / invalid top_p），已全量实测确认
    if (model === 'kimi-k3' || model.endsWith('/kimi-k3')) {
      body.temperature = 1
      body.top_p = 0.95
    }

    // C-03 修复：传递工具定义给 API
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools
      if (params.toolChoice) body.tool_choice = params.toolChoice
    }

    // 流式请求时请求 usage 信息
    if (stream) {
      body.stream_options = { include_usage: true }
    }

    const internalAbort = withInternalAbort(signal)
    const sendRequest = () => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: internalAbort.signal,
    })

    let response = await sendRequest()
    if (!response.ok) {
      const errText = await response.text()
      // 阶段8（§4.3）字段级降级表：仅当 400 明确指向本轮下发的门控字段时才去参重发一次。
      // 聚合代理未必透传 DeepSeek 的 thinking 扩展参数；网络错误与其他 400 不进入该分支。
      const rejected = matchRejectedGateField({ status: response.status, errText, probes: gateProbes })
      if (rejected) {
        deleteGateField(body, rejected.path)
        if (gateSignal) gateSignal.knobAccepted = false
        response = await sendRequest()
        if (!response.ok) {
          const retryText = await response.text()
          throw new Error(`OpenAI API 错误 ${response.status}: ${sanitizeApiKey(retryText)}${imageErrorHint(params.messages)}`)
        }
      } else {
        throw new Error(`OpenAI API 错误 ${response.status}: ${sanitizeApiKey(errText)}${imageErrorHint(params.messages)}`)
      }
    }

    if (!stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json()
      const choice = data.choices?.[0]
      const content = choice?.message?.content ?? ''
      // reasoning_content / reasoning 是供应商推理，不是角色心理描写。
      // 角色内心独白只能来自最终 content 中由提示词约定生成的 <thought> 块。
      const fullContent = stripVendorThinking(content)
      // 解析 usage（即使正文为空也记录，保留 token 消耗统计）
      if (onUsage && data.usage) {
        onUsage({
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
          reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
        })
      }
      // 阶段3契约：length 是完成状态，随 AICompletion 返回，不再抛错
      const finishReason = normalizeFinishReason(choice?.finish_reason)
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
          }
        : undefined
      // 阶段8（§4.3/§4.6）：off 档仍返回推理内容 → 该端点静默忽略了 disable
      if (gate?.level === 'off' && choice?.message?.reasoning_content && gateSignal) {
        gateSignal.disableIgnored = true
      }
      if (usage?.reasoningTokens !== undefined && gateSignal) {
        gateSignal.reportsReasoningUsage = true
      }
      // C-03 修复：检测 tool_calls 并附加标记供 toolLoop 解析
      const toolCalls = choice?.message?.tool_calls
      if (toolCalls && toolCalls.length > 0) {
        onChunk(fullContent)
        return {
          text: fullContent + '[TOOL_CALL:' + JSON.stringify(toolCalls) + ']',
          finishReason: 'tool_calls',
          usage,
          ...(gateSignal ? { gateProbe: gateSignal } : {}),
        }
      }
      if (!fullContent.trim()) {
        // 上游 200 但消息体为空（审核拦截 / 思考未透出 / 上游异常）：
        // 此前被静默当作成功，表现为“请求完成却是空内容”，现在显式报错。
        throw attachGateProbe(new Error(
          isReasoningBudgetExhausted({
            finishReason: choice?.finish_reason,
            maxTokens,
            completionTokens: usage?.completionTokens,
            reasoningTokens: usage?.reasoningTokens,
          })
            ? REASONING_BUDGET_EXHAUSTED_MESSAGE
            : choice?.finish_reason === 'content_filter'
            ? '模型响应被上游内容审核拦截（content_filter），请调整对话内容或更换模型'
            : '模型未返回任何内容，请重试或检查模型是否可用',
        ), gateSignal)
      }
      onChunk(fullContent)
      return { text: fullContent, finishReason, usage, ...(gateSignal ? { gateProbe: gateSignal } : {}) }
    }

    // 阶段8（§4.4，2026-09-13 G1 取证后修订）：推理越线提前中止的观测线 =
    // requestMaxTokens − 正文绝对下限（可证明的徒劳点），不再使用"上限 85%"魔数，
    // 也不再把 gateTokens 当止损线（它是预算承诺）。正文一出现即解除资格。
    const runawayGuard = createReasoningRunawayGuard({
      enabled: gate != null && (gate.knob === 'none' || gate.level === 'off'),
      requestMaxTokens: maxTokens,
    })
    // 流式解析（修复 SSE 分隔符：使用更稳健的行解析）
    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''
    const visibleTextFilter = createVendorThinkingStreamFilter()
    let streamUsage: AICompletion['usage'] | undefined
    // 流级观测：上游常把错误/审核结果塞进 SSE 事件体而不是 HTTP 状态码，
    // 此前被静默忽略，表现为“请求完成但内容全空”（长记忆/续写无内容）。
    const STREAM_ERROR_FLAG = '__openaiStreamError'
    let sawAnyDelta = false
    let finishReason: string | null = null
    // C-03 修复：收集流式 tool_calls delta
    // BUG-14 修复：key 不再默认 0——index 缺失时优先用 id 关联，再退化为自增键，避免互相覆盖
    const streamedToolCalls = new Map<string, { id: string; type: string; function: { name: string; arguments: string } }>()

    // BUG-29：解析单个 SSE 事件（多 data: 行已合并为 data）
    // 合并后的多行 JSON 解析失败时，回退逐行解析以兼容仅用 \n 分隔的非标准服务器
    const processOpenAIEvent = (rawData: string) => {
      const data = rawData.trim()
      if (!data || data === '[DONE]') return
      const handleParsed = (parsed: ReturnType<typeof JSON.parse>) => {
        // 流内错误事件（OpenRouter 等代理会把上游错误作为 data 事件下发）：必须透出
        if (parsed && typeof parsed === 'object' && parsed.error) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw: any = parsed.error
          const msg = typeof raw === 'string' ? raw : (raw?.message || JSON.stringify(raw))
          const err = new Error(`模型流式返回错误：${msg}`) as Error & Record<string, unknown>
          err[STREAM_ERROR_FLAG] = true
          throw err
        }
        // 解析 usage（最后 chunk）
        if (parsed.usage) {
          const usage = {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens as number | undefined,
          }
          onUsage?.({ ...usage, totalTokens: parsed.usage.total_tokens ?? 0 })
          streamUsage = usage
          if (usage.reasoningTokens !== undefined && gateSignal) gateSignal.reportsReasoningUsage = true
        }
        const choice = parsed.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta
        if (!delta) return

        // reasoning_content / reasoning 仅供模型内部推理，禁止透传到正文或流式 UI。
        // 阶段8（§4.3/§4.6）：off 档仍出现推理 delta → 记录该端点静默忽略 disable。
        const reasoningDelta: string = delta.reasoning_content ?? delta.reasoning ?? ''
        if (reasoningDelta && gate?.level === 'off' && gateSignal) {
          gateSignal.disableIgnored = true
        }
        if (reasoningDelta) {
          runawayGuard.addReasoning(reasoningDelta)
          if (runawayGuard.shouldAbort()) {
            runawayGuard.markAborted()
            internalAbort.abort()
            return
          }
        }

        if (choice?.finish_reason) runawayGuard.markFinished()

        // 正常内容
        if (delta.content) {
          sawAnyDelta = true
          runawayGuard.addBody(delta.content.length)
          const visible = visibleTextFilter.push(delta.content)
          if (visible) {
            fullText += visible
            onChunk(visible)
          }
        }

        // C-03 修复：收集流式 tool_calls delta
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // BUG-14：index 缺失时优先用 id 关联同一 tool call，再退化为自增键
            let key: string
            if (tc.index !== undefined) {
              key = String(tc.index)
            } else if (tc.id) {
              // M-4 修复：无 index 时统一用 id 关联（此前先查"id 已存在"再退化为 n:size，
              // 同一 tool call 的后续 chunk 因 size 增长生成新键，被拆散成多个残缺条目）
              key = `id:${tc.id}`
            } else {
              key = `n:${streamedToolCalls.size}`
            }
            if (!streamedToolCalls.has(key)) {
              streamedToolCalls.set(key, { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } })
            }
            const existing = streamedToolCalls.get(key)!
            if (tc.id) existing.id = tc.id
            // name 取首次出现（兼容每 chunk 重复发送完整 name 的实现，避免重复拼接）
            if (tc.function?.name && !existing.function.name) existing.function.name = tc.function.name
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          }
        }
      }
      try {
        handleParsed(JSON.parse(data))
      } catch (err) {
        // 流内错误必须中止整个解析；其余解析失败才走逐行回退
        if ((err as Error & Record<string, unknown>)?.[STREAM_ERROR_FLAG]) throw err
        for (const line of data.split('\n')) {
          try { handleParsed(JSON.parse(line)) }
          catch (inner) {
            if ((inner as Error & Record<string, unknown>)?.[STREAM_ERROR_FLAG]) throw inner
            /* 忽略解析错误（可能是注释行或心跳） */
          }
        }
      }
    }

    try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // BUG-29 修复：按 SSE 事件（空行分隔）解析，事件内多行 data: 合并后再解析；
      // 合并失败时回退逐行解析，兼容仅用 \n 分隔的非标准服务器
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const dataLines = event.split(/\r?\n/).filter(l => l.trim().startsWith('data:'))
        if (dataLines.length === 0) continue
        processOpenAIEvent(dataLines.map(l => l.trim().slice(5).trim()).join('\n'))
      }
    }

    // 处理剩余 buffer
    if (buffer.trim()) {
      const dataLines = buffer.split(/\r?\n/).filter(l => l.trim().startsWith('data:'))
      if (dataLines.length > 0) {
        processOpenAIEvent(dataLines.map(l => l.trim().slice(5).trim()).join('\n'))
      }
    }
    const trailingVisible = visibleTextFilter.flush()
    if (trailingVisible) {
      fullText += trailingVisible
      onChunk(trailingVisible)
    }
    } catch (err) {
      // 阶段8（§4.4）：内部中止（推理越线、正文为空）→ 结构化终局，不抛普通错误
      if (internalAbort.abortedByUs() && runawayGuard.aborted) {
        return {
          text: '',
          finishReason: 'length',
          earlyAbort: true,
          ...(gateSignal ? { gateProbe: gateSignal } : {}),
        }
      }
      throw err
    } finally {
      internalAbort.cleanup()
      try { reader.releaseLock() } catch { /* ignore */ }
    }

    // 阶段3契约：length 是完成状态，随 AICompletion 返回，不再抛错
    const normalizedReason = normalizeFinishReason(finishReason)

    // 零输出防御：流正常结束但没有任何 content/推理增量（流内错误已在上方抛出，
    // 剩下的是审核拦截、上游异常提前终止等）。此前按“成功但空内容”静默返回，
    // 长记忆/续写表现为“完成却无内容”，现在转为明确错误供上层展示真实原因。
    const sanitizedText = stripVendorThinking(fullText)
    if ((!sawAnyDelta || !sanitizedText.trim()) && streamedToolCalls.size === 0) {
      throw attachGateProbe(new Error(
        isReasoningBudgetExhausted({
          finishReason: normalizedReason,
          maxTokens,
          completionTokens: streamUsage?.completionTokens,
          reasoningTokens: streamUsage?.reasoningTokens,
        })
          ? REASONING_BUDGET_EXHAUSTED_MESSAGE
          : normalizedReason === 'content_filter'
          ? '模型响应被上游内容审核拦截（content_filter），请调整对话内容或更换模型'
          : '模型未返回任何内容，请重试或检查模型是否可用',
      ), gateSignal)
    }
    // C-03 修复：如有 tool_calls，附加标记供 toolLoop 解析
    let text = ''
    if (streamedToolCalls.size > 0) {
      const toolCallsArray = Array.from(streamedToolCalls.values())
      text = sanitizedText + '[TOOL_CALL:' + JSON.stringify(toolCallsArray) + ']'
      return { text, finishReason: 'tool_calls', usage: streamUsage, ...(gateSignal ? { gateProbe: gateSignal } : {}) }
    }
    return {
      text: sanitizedText,
      finishReason: normalizedReason,
      usage: streamUsage,
      ...(gateSignal ? { gateProbe: gateSignal } : {}),
    }
  },

  async listModels(baseUrl, apiKey) {
    const url = `${baseUrl.replace(/\/$/, '')}/models`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) throw new Error(`获取模型列表失败: ${response.status}`)
    const data = (await response.json()) as { data?: { id: string }[] }
    return (data.data ?? []).map((m: { id: string }) => m.id)
  },

  async testConnection(baseUrl, apiKey) {
    try {
      await this.listModels(baseUrl, apiKey)
      return true
    } catch {
      return false
    }
  },
}
