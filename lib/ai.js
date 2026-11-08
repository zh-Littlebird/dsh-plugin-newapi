/**
 * AI-surface client: model discovery, Chat Completions (including aggregated
 * streaming), and embeddings.
 */

import { NewApiError } from './errors.js'
import { readLimited } from './http.js'

/** Extract plain text from OpenAI-style string or content-part arrays. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (typeof part === 'string') parts.push(part)
      else if (part !== null && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text)
    }
    return parts.join('')
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/** Normalize token usage across OpenAI-compatible spellings. */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const prompt = number(usage.prompt_tokens) ?? number(usage.input_tokens)
  const completion = number(usage.completion_tokens) ?? number(usage.output_tokens)
  const total = number(usage.total_tokens)
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total ?? (prompt !== null && completion !== null ? prompt + completion : null),
    reasoningTokens: number(usage.completion_tokens_details?.reasoning_tokens),
    cachedTokens: number(usage.prompt_tokens_details?.cached_tokens),
  }
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : null,
      type: typeof entry.type === 'string' ? entry.type : 'function',
      name: typeof entry.function?.name === 'string' ? entry.function.name : typeof entry.name === 'string' ? entry.name : '',
      arguments:
        typeof entry.function?.arguments === 'string'
          ? entry.function.arguments
          : typeof entry.arguments === 'string'
            ? entry.arguments
            : '',
    }))
}

function toEpochSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  }
  return null
}

/** Normalize one non-streaming Chat Completions response. */
export function normalizeChatResponse(json) {
  if (json === null || typeof json !== 'object') {
    throw new NewApiError('API_ERROR', '网关返回的对话响应不是对象', { hint: '请检查网关/渠道是否支持 /v1/chat/completions。' })
  }
  if (json.error !== undefined) {
    const message =
      typeof json.error === 'string' ? json.error : typeof json.error?.message === 'string' ? json.error.message : '上游返回 error'
    throw new NewApiError('API_ERROR', message, { hint: '请检查模型名、内容审核与渠道状态。' })
  }
  const choices = Array.isArray(json.choices) ? json.choices : []
  if (choices.length === 0) {
    throw new NewApiError('API_ERROR', '对话响应没有 choices', {
      hint: '网关可能返回了非标准结构；请用 newapi_raw 查看原始响应。',
      details: { id: json.id ?? null, model: json.model ?? null },
    })
  }
  const choice = choices[0] ?? {}
  const message = choice.message ?? choice.delta ?? {}
  return {
    id: typeof json.id === 'string' ? json.id : null,
    model: typeof json.model === 'string' ? json.model : null,
    created: toEpochSeconds(json.created),
    content: contentText(message.content),
    reasoning:
      typeof message.reasoning_content === 'string'
        ? message.reasoning_content
        : typeof message.reasoning === 'string'
          ? message.reasoning
          : null,
    refusal: typeof message.refusal === 'string' ? message.refusal : null,
    toolCalls: normalizeToolCalls(message.tool_calls),
    finishReason:
      typeof choice.finish_reason === 'string'
        ? choice.finish_reason
        : typeof choice.stop_reason === 'string'
          ? choice.stop_reason
          : null,
    usage: normalizeUsage(json.usage),
    streamed: false,
    streamFallback: false,
    chunks: 0,
  }
}

function parseModels(json, format) {
  if (json === null || typeof json !== 'object') return []
  const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []
  const models = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      models.push({
        id: entry,
        displayName: null,
        ownedBy: null,
        createdAt: null,
      })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    let id = entry.id ?? entry.name ?? entry.model
    if (typeof id !== 'string' || id.length === 0) continue
    if (format === 'gemini' && id.startsWith('models/')) id = id.slice('models/'.length)
    models.push({
      id,
      displayName:
        typeof entry.display_name === 'string'
          ? entry.display_name
          : typeof entry.displayName === 'string'
            ? entry.displayName
            : null,
      ownedBy:
        typeof entry.owned_by === 'string'
          ? entry.owned_by
          : typeof entry.owner === 'string'
            ? entry.owner
            : typeof entry.publisher === 'string'
              ? entry.publisher
              : null,
      createdAt: toEpochSeconds(entry.created ?? entry.created_at ?? entry.createTime),
    })
  }
  return models.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Read an SSE stream and aggregate Chat Completions deltas.
 * @param {ReadableStream<Uint8Array>} body
 */
async function aggregateSse(body, options) {
  const decoder = new TextDecoder('utf-8')
  const aggregate = {
    id: null,
    model: null,
    created: null,
    content: '',
    reasoning: '',
    refusal: null,
    finishReason: null,
    usage: null,
    toolCalls: [],
    chunks: 0,
    unparsed: 0,
    truncated: false,
  }
  /** @type {Map<number, {id: string|null, type: string, name: string, arguments: string}>} */
  const toolCalls = new Map()
  let buffer = ''
  let dataLines = []
  let bytes = 0
  let done = false

  const dispatch = (payload) => {
    const trimmed = payload.trim()
    if (trimmed.length === 0) return
    if (trimmed === '[DONE]') {
      done = true
      return
    }
    let chunk
    try {
      chunk = JSON.parse(trimmed)
    } catch {
      aggregate.unparsed++
      return
    }
    if (chunk === null || typeof chunk !== 'object') return
    if (chunk.error !== undefined) {
      const message =
        typeof chunk.error === 'string' ? chunk.error : typeof chunk.error?.message === 'string' ? chunk.error.message : '流式响应返回 error'
      throw new NewApiError('API_ERROR', message, { hint: '请检查模型名、渠道状态与上游限流。' })
    }
    aggregate.chunks++
    if (typeof chunk.id === 'string') aggregate.id = chunk.id
    if (typeof chunk.model === 'string') aggregate.model = chunk.model
    if (aggregate.created === null) aggregate.created = toEpochSeconds(chunk.created)
    if (chunk.usage !== undefined) aggregate.usage = normalizeUsage(chunk.usage)
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = choices[0]
    if (choice === null || typeof choice !== 'object') return
    const delta = choice.delta ?? choice.message ?? {}
    if (delta.content !== undefined) aggregate.content += contentText(delta.content)
    if (typeof delta.reasoning_content === 'string') aggregate.reasoning += delta.reasoning_content
    else if (typeof delta.reasoning === 'string') aggregate.reasoning += delta.reasoning
    if (typeof delta.refusal === 'string') aggregate.refusal = delta.refusal
    if (Array.isArray(delta.tool_calls)) {
      for (const entry of delta.tool_calls) {
        if (entry === null || typeof entry !== 'object') continue
        const index = typeof entry.index === 'number' ? entry.index : 0
        const current = toolCalls.get(index) ?? { id: null, type: 'function', name: '', arguments: '' }
        if (typeof entry.id === 'string' && entry.id.length > 0) current.id = entry.id
        if (typeof entry.type === 'string') current.type = entry.type
        if (typeof entry.function?.name === 'string' && entry.function.name.length > 0) current.name = entry.function.name
        if (typeof entry.function?.arguments === 'string') current.arguments += entry.function.arguments
        toolCalls.set(index, current)
      }
    }
    if (typeof choice.finish_reason === 'string') aggregate.finishReason = choice.finish_reason
    else if (typeof choice.stop_reason === 'string') aggregate.finishReason = choice.stop_reason
  }

  const processLines = (final) => {
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) {
        if (dataLines.length > 0) {
          const payload = dataLines.join('\n')
          dataLines = []
          dispatch(payload)
        }
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''))
    }
    if (final && buffer.length > 0) {
      let line = buffer
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''))
      buffer = ''
    }
    if (final && dataLines.length > 0) {
      const payload = dataLines.join('\n')
      dataLines = []
      dispatch(payload)
    }
  }

  const maxBytes = options.maxBytes
  for await (const chunk of body) {
    if (done) break
    if (chunk === undefined) continue
    bytes += chunk.byteLength
    if (bytes > maxBytes) {
      aggregate.truncated = true
      break
    }
    buffer += decoder.decode(chunk, { stream: true })
    processLines(false)
  }
  if (!done && !aggregate.truncated) {
    buffer += decoder.decode()
    processLines(true)
  }

  aggregate.toolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
  return aggregate
}

export class AiClient {
  /** @param {{settings: any, transport: any, debug: (message: string) => void}} options */
  constructor(options) {
    this.settings = options.settings
    this.transport = options.transport
    this.debug = options.debug
  }

  async models(options = {}) {
    const format = options.format ?? 'openai'
    const formats = new Set(['openai', 'anthropic', 'gemini'])
    if (!formats.has(format)) {
      throw new NewApiError('INVALID_ARGS', `不支持的模型列表格式：${format}`, { hint: '可选 openai、anthropic、gemini。' })
    }
    const path = format === 'gemini' ? '/v1beta/models' : '/v1/models'
    const authStyle = format === 'anthropic' ? 'anthropic' : format === 'gemini' ? 'gemini' : 'bearer'
    const response = await this.transport.request({
      api: 'ai',
      authStyle,
      method: 'GET',
      path,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    const models = parseModels(response.json, format)
    return { format, count: models.length, models, durationMs: response.durationMs }
  }

  /** Build the Chat Completions body; `extra` carries provider-specific keys. */
  static chatBody(args, stream) {
    const body = { ...(args.extra ?? {}) }
    body.model = args.model
    body.messages = args.messages
    body.stream = stream
    const optional = {
      temperature: args.temperature,
      top_p: args.topP,
      max_tokens: args.maxTokens,
      stop: args.stop,
      presence_penalty: args.presencePenalty,
      frequency_penalty: args.frequencyPenalty,
      seed: args.seed,
      tools: args.tools,
      tool_choice: args.toolChoice,
      response_format: args.responseFormat,
      user: args.user,
      n: args.n,
    }
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined && value !== null) body[key] = value
    }
    return body
  }

  async chat(args) {
    const body = AiClient.chatBody(args, args.stream === true)
    if (args.stream === true) return this.#chatStream(body, args)

    const response = await this.transport.request({
      api: 'ai',
      method: 'POST',
      path: '/v1/chat/completions',
      body,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    })
    return {
      ...normalizeChatResponse(response.json),
      durationMs: response.durationMs,
      requestId: response.requestId,
    }
  }

  async #chatStream(body, args) {
    const opened = await this.transport.open({
      api: 'ai',
      method: 'POST',
      path: '/v1/chat/completions',
      body,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    })
    if (!opened.response.ok) {
      await this.transport.finish(opened, {})
      throw new NewApiError('API_ERROR', '流式请求失败', { hint: '请检查网关日志。' })
    }
    const contentType = opened.response.headers.get('content-type') ?? ''
    if (contentType.includes('json')) {
      const response = await this.transport.finish(opened, {})
      return {
        ...normalizeChatResponse(response.json),
        streamed: false,
        streamFallback: true,
        durationMs: response.durationMs,
        requestId: response.requestId,
      }
    }
    if (opened.response.body === null) {
      const response = await this.transport.finish(opened, { allowText: true })
      throw new NewApiError('API_ERROR', '流式响应没有可读的 body', {
        hint: `Content-Type=${contentType || '未知'}；请用 newapi_raw 非流式调用或检查网关。`,
      })
    }
    let aggregate
    try {
      aggregate = await aggregateSse(opened.response.body, {
        maxBytes: this.settings.config.maxResponseBytes,
      })
    } catch (error) {
      if (args.signal?.aborted === true) {
        throw new NewApiError('ABORTED', '流式请求已被取消', { hint: '这是调用方取消，不是网关错误。' })
      }
      if (opened.timeoutSignal?.aborted) {
        throw new NewApiError('TIMEOUT', '流式响应读取超时', {
          hint: '可提高 timeoutMs，或关闭 stream 后缩小 max_tokens 重试。',
          cause: error,
        })
      }
      throw error
    }
    return {
      id: aggregate.id,
      model: aggregate.model,
      created: aggregate.created,
      content: aggregate.content,
      reasoning: aggregate.reasoning.length > 0 ? aggregate.reasoning : null,
      refusal: aggregate.refusal,
      toolCalls: aggregate.toolCalls,
      finishReason: aggregate.finishReason,
      usage: aggregate.usage,
      streamed: true,
      streamFallback: false,
      chunks: aggregate.chunks,
      unparsedChunks: aggregate.unparsed,
      truncated: aggregate.truncated,
      durationMs: Date.now() - opened.startedAt,
      requestId: opened.response.headers.get('x-request-id') ?? null,
    }
  }

  async embed(args) {
    const body = {
      ...(args.extra ?? {}),
      model: args.model,
      input: args.input,
    }
    if (args.dimensions !== undefined) body.dimensions = args.dimensions
    if (args.encodingFormat !== undefined) body.encoding_format = args.encodingFormat
    if (args.user !== undefined) body.user = args.user
    const response = await this.transport.request({
      api: 'ai',
      method: 'POST',
      path: '/v1/embeddings',
      body,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    })
    const json = response.json
    const list = Array.isArray(json?.data) ? json.data : []
    const embeddings = list.map((entry, index) => {
      const vector = Array.isArray(entry?.embedding)
        ? entry.embedding.filter((value) => typeof value === 'number')
        : []
      return {
        index: typeof entry?.index === 'number' ? entry.index : index,
        vector,
        preview: vector.slice(0, 8),
      }
    })
    return {
      model: typeof json?.model === 'string' ? json.model : args.model,
      count: embeddings.length,
      dimensions: embeddings[0]?.vector.length ?? 0,
      embeddings,
      usage: normalizeUsage(json?.usage),
      durationMs: response.durationMs,
    }
  }
}
