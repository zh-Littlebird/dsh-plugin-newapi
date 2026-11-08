/**
 * HTTP transport shared by AI and management operations.
 *
 * - Authorization is selected per endpoint family; `sk-` keys never touch
 *   `/api/*`, and system access tokens never touch `/v1/*`.
 * - Redirects are refused so a compromised gateway cannot bounce an
 *   Authorization header to another origin.
 * - Response bodies are capped before parsing; oversized JSON fails loudly
 *   instead of being silently truncated into an invalid document.
 */

import { NewApiError } from './errors.js'
import { requireAccessToken, requireApiKey, requireBaseUrl, PLUGIN_VERSION } from './config.js'
import { redactText } from './redact.js'

const AI_PREFIXES = ['/v1', '/v1beta', '/kling', '/jimeng', '/pg']
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key'])

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name)
  return undefined
}

/** Serialize a query object; arrays become comma-separated lists. */
export function buildQuery(query) {
  const params = new URLSearchParams()
  if (query === undefined || query === null) return params
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw new NewApiError('INVALID_QUERY', 'query 必须是对象', { hint: '例如 {"p":1,"page_size":20}。' })
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      params.set(key, value.map((entry) => String(entry)).join(','))
    } else if (typeof value === 'boolean') {
      params.set(key, value ? 'true' : 'false')
    } else {
      params.set(key, String(value))
    }
  }
  return params
}

/** Decide whether a path belongs to the AI surface or the management surface. */
export function detectApi(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new NewApiError('INVALID_PATH', 'path 不能为空', { hint: '例如 /v1/models 或 /api/status。' })
  }
  if (path.startsWith('/api/') || path === '/api') return 'admin'
  if (AI_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return 'ai'
  return null
}

/** Validate a path and add the family prefix when the caller omitted it. */
export function normalizePath(api, input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new NewApiError('INVALID_PATH', 'path 不能为空', { hint: '例如 /v1/models 或 /api/status。' })
  }
  let path = input.trim()
  if (path.includes('?') || path.includes('#')) {
    throw new NewApiError('INVALID_PATH', 'path 不能包含查询参数或锚点', {
      hint: '请把查询参数放进 query 字段，例如 {"path":"/api/log/","query":{"p":1}}。',
    })
  }
  if (path.includes('\\') || path.includes('..') || path.startsWith('//') || /[\u0000-\u001f]/.test(path)) {
    throw new NewApiError('INVALID_PATH', `path 含不允许的字符：${path}`, {
      hint: '只填写网关内的绝对路径，例如 /api/token/。',
    })
  }
  if (!path.startsWith('/')) path = `/${path}`
  let family = api
  if (family === 'auto') {
    family = detectApi(path)
    if (family === null) {
      throw new NewApiError('INVALID_PATH', `无法判断 path 属于 AI 还是管理接口：${path}`, {
        hint: '请显式传 api="ai" 或 api="management"；AI 路径通常以 /v1 开头，管理路径以 /api 开头。',
      })
    }
    if (family === 'admin' && path === '/api/status') {
      // `/api/status` is public; callers that wanted management auth can pass
      // api="management" explicitly. Auto keeps it public for diagnostics.
      return { api: 'public', path }
    }
    return { api: family, path }
  }
  if (family === 'ai') {
    if (!AI_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      path = `/v1${path}`
    }
    return { api: 'ai', path }
  }
  if (family === 'management' || family === 'admin') {
    if (!path.startsWith('/api')) path = `/api${path}`
    return { api: 'admin', path }
  }
  if (family === 'public') {
    if (!path.startsWith('/api')) path = `/api${path}`
    return { api: 'public', path }
  }
  throw new NewApiError('INVALID_PATH', `未知的 api 类型：${String(api)}`, {
    hint: '可选 auto、ai、management、public。',
  })
}

/** Combine a base URL, path, and query into a validated URL. */
export function buildUrl(baseUrl, path, query) {
  let base
  try {
    base = new URL(baseUrl)
  } catch {
    throw new NewApiError('CONFIG_INVALID', `baseUrl 不是合法的 URL：${baseUrl}`, {
      hint: '请运行 scripts/dsh-newapi.mjs setup 重新配置。',
    })
  }
  let url
  try {
    url = new URL(`${base.toString().replace(/\/$/, '')}${path}`)
  } catch {
    throw new NewApiError('INVALID_PATH', `无法拼接请求地址：${path}`, { hint: '请检查 path 是否合法。' })
  }
  if (url.origin !== base.origin) {
    throw new NewApiError('INVALID_PATH', 'path 不能指向其他站点', {
      hint: '只允许访问配置的网关同源地址。',
    })
  }
  const params = buildQuery(query)
  const queryText = params.toString()
  if (queryText.length > 0) url.search = queryText
  return url
}

function authHeaders(api, authStyle, settings) {
  const common = {
    accept: 'application/json',
    'user-agent': `dsh-plugin-newapi/${PLUGIN_VERSION} (+https://github.com/deepseek-ai/deepseek-harness)`,
  }
  if (api === 'public') return common
  if (api === 'admin') {
    const token = requireAccessToken(settings)
    return {
      ...common,
      authorization: `Bearer ${token}`,
      'new-api-user': settings.userId,
    }
  }
  const key = requireApiKey(settings)
  if (authStyle === 'anthropic') {
    return {
      ...common,
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }
  }
  if (authStyle === 'gemini') {
    return { ...common, 'x-goog-api-key': key }
  }
  return { ...common, authorization: `Bearer ${key}` }
}

function networkCode(error) {
  const code = error?.cause?.code ?? error?.code
  return typeof code === 'string' ? code : null
}

function networkHint(code) {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败：请检查 baseUrl 的域名与当前网络/DNS。'
    case 'ECONNREFUSED':
      return '连接被拒绝：请确认网关地址和端口正确，服务已启动。'
    case 'ECONNRESET':
      return '连接被重置：网关或中间代理中断了连接，可稍后重试。'
    case 'ETIMEDOUT':
      return 'TCP 连接超时：请检查网络、防火墙或代理。'
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS 证书校验失败：请使用受信任的 HTTPS 证书，不要关闭校验。'
    default:
      return '请检查 baseUrl、网络连通性和代理设置。'
  }
}

/** Read a response body with a hard byte cap. */
export async function readLimited(response, maxBytes) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 8 * 1024 * 1024
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const text = await response.text()
    const bytes = Buffer.byteLength(text, 'utf8')
    return {
      text: bytes > limit ? text.slice(0, limit) : text,
      bytes,
      truncated: bytes > limit,
    }
  }
  const chunks = []
  let bytes = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    bytes += value.byteLength
    if (bytes > limit) {
      const previous = bytes - value.byteLength
      const keep = Math.max(0, limit - previous)
      if (keep > 0) chunks.push(value.subarray(0, keep))
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    bytes,
    truncated,
  }
}

function payloadMessage(json, text) {
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    const candidates = [
      json.error?.message,
      json.message,
      json.msg,
      typeof json.error === 'string' ? json.error : null,
      json.data?.message,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
    }
    if (json.success === false && typeof json.message === 'string' && json.message.trim().length > 0) {
      return json.message.trim()
    }
  }
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length > 0) return trimmed.slice(0, 500)
  return '上游没有返回错误详情'
}

function statusHint(api, status) {
  if (status === 401) {
    return api === 'admin'
      ? '管理接口需要系统访问令牌 + New-Api-User 请求头；sk- 密钥不能调用管理接口。请核对 access token 与 userId。'
      : '请核对 AI 密钥是否 sk- 开头、未过期、未被禁用。'
  }
  if (status === 403) {
    return '权限不足：该接口需要 Admin/Root 账号，或访问令牌对应的 user id 与账号不一致。'
  }
  if (status === 404) {
    return '端点或模型不存在；模型名请先调用 newapi_models 核对网关实际暴露的名字。'
  }
  if (status === 429) {
    return '触发限流或分组负载饱和：降低并发、稍后重试，或更换分组/渠道。'
  }
  if (status === 400 || status === 422) {
    return '请求参数被网关拒绝：请按接口字段说明核对参数，不要猜测字段名。'
  }
  if (status >= 500) {
    return '网关或上游异常：检查渠道状态、上游可用性与 /api/log/ 中的错误字段。'
  }
  return '请结合网关日志与 /api/log/ 排查。'
}

function httpError(api, status, json, text) {
  const message = payloadMessage(json, text)
  return new NewApiError(`HTTP_${status}`, `HTTP ${status}：${message}`, {
    status,
    hint: statusHint(api, status),
  })
}

export class HttpTransport {
  /** @param {{settings: any, debug: (message: string) => void}} options */
  constructor(options) {
    this.settings = options.settings
    this.debug = options.debug
  }

  /**
   * Open a request without reading the body. The caller must consume or
   * discard `response.body`.
   */
  async open(request) {
    const baseUrl = requireBaseUrl(this.settings)
    const method = String(request.method ?? 'GET').toUpperCase()
    const { api, path } = normalizePath(request.api ?? 'auto', request.path)
    const url = buildUrl(baseUrl, path, request.query)
    const headers = {
      ...authHeaders(api, request.authStyle, this.settings),
      ...(request.headers ?? {}),
    }
    let body
    if (request.body !== undefined) {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json'
      }
    }

    const timeoutMs = Math.max(
      1_000,
      Math.min(600_000, Number.isFinite(request.timeoutMs) ? Math.floor(request.timeoutMs) : this.settings.config.timeoutMs),
    )
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combined =
      request.signal === undefined ? timeoutSignal : AbortSignal.any([request.signal, timeoutSignal])
    const startedAt = Date.now()

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: combined,
      })
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw new NewApiError('ABORTED', '请求已被取消', { hint: '这是调用方取消，不是网关错误。' })
      }
      if (timeoutSignal.aborted) {
        throw new NewApiError('TIMEOUT', `请求超时（${timeoutMs} ms）`, {
          hint: '可提高 timeoutMs，或缩小请求范围（如减少 max_tokens、分页查询日志）。',
        })
      }
      const code = networkCode(error)
      if (error instanceof Error && error.name === 'TypeError' && /redirect/i.test(error.message)) {
        throw new NewApiError('REDIRECT_REFUSED', '网关返回了重定向，已拒绝跟随', {
          hint: '请把 baseUrl 改为最终地址，避免 Authorization 头被转发到其他站点。',
          cause: error,
        })
      }
      throw new NewApiError(
        'NETWORK_ERROR',
        `无法连接网关：${error instanceof Error ? error.message : String(error)}`,
        { hint: networkHint(code), cause: error },
      )
    }

    this.debug(`${method} ${url.origin}${url.pathname} -> ${response.status}`)
    return {
      response,
      url,
      api,
      method,
      path,
      timeoutSignal,
      callerSignal: request.signal,
      startedAt,
      headers,
      redactedHeaders: Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key, SENSITIVE_HEADERS.has(key.toLowerCase()) ? '***' : value]),
      ),
    }
  }

  /** Read a response body, throwing a structured error for an HTTP failure. */
  async finish(opened, options = {}) {
    const { response } = opened
    const maxBytes = options.maxBytes ?? this.settings.config.maxResponseBytes
    let read
    try {
      read = await readLimited(response, maxBytes)
    } catch (error) {
      if (opened.callerSignal?.aborted === true) {
        throw new NewApiError('ABORTED', '请求已被取消', { hint: '这是调用方取消，不是网关错误。' })
      }
      if (opened.timeoutSignal?.aborted) {
        throw new NewApiError('TIMEOUT', '读取响应超时', {
          hint: '可提高 timeoutMs，或缩小请求范围（分页、减少 max_tokens）。',
          cause: error,
        })
      }
      throw new NewApiError('NETWORK_ERROR', `读取响应失败：${error instanceof Error ? error.message : String(error)}`, {
        hint: '连接可能被网关或代理中断，可稍后重试。',
        cause: error,
      })
    }
    const contentType = headerValue(response.headers, 'content-type') ?? ''
    let json = null
    let parseError = null
    if (read.text.trim().length > 0) {
      try {
        json = JSON.parse(read.text)
      } catch (error) {
        parseError = error
      }
    }

    if (!response.ok) {
      throw httpError(opened.api, response.status, json, read.text)
    }
    if (read.truncated && options.allowTruncated !== true) {
      throw new NewApiError('RESPONSE_TOO_LARGE', `响应超过 ${maxBytes} 字节上限，已中断读取`, {
        hint: '请缩小请求范围（分页、减少 max_tokens、过滤字段），或提高插件配置 maxResponseBytes。',
      })
    }
    if (json === null && read.text.trim().length > 0) {
      if (options.allowText === true) {
        return {
          status: response.status,
          ok: response.ok,
          json: null,
          text: redactText(read.text),
          bytes: read.bytes,
          truncated: read.truncated,
          contentType,
          requestId: headerValue(response.headers, 'x-request-id') ?? headerValue(response.headers, 'request-id') ?? null,
          durationMs: Date.now() - opened.startedAt,
        }
      }
      throw new NewApiError('INVALID_JSON', `网关返回了非 JSON 内容（${contentType || '未知 Content-Type'}）`, {
        hint: `响应片段：${redactText(read.text).slice(0, 300)}`,
        details: { parseError: parseError instanceof Error ? parseError.message : null },
      })
    }
    if (json !== null && typeof json === 'object' && !Array.isArray(json) && json.success === false && options.allowApiFailure !== true) {
      throw new NewApiError('API_ERROR', payloadMessage(json, read.text), {
        hint: '网关返回 success=false；请按 message 调整请求，或先查 /api/log/ 定位上游错误。',
        details: { code: json.code ?? null },
      })
    }

    return {
      status: response.status,
      ok: response.ok,
      json,
      text: options.includeText === true ? redactText(read.text) : null,
      bytes: read.bytes,
      truncated: read.truncated,
      contentType,
      requestId: headerValue(response.headers, 'x-request-id') ?? headerValue(response.headers, 'request-id') ?? null,
      durationMs: Date.now() - opened.startedAt,
    }
  }

  /** Open, read, and parse one request in a single call. */
  async request(request) {
    const opened = await this.open(request)
    return this.finish(opened, {
      maxBytes: request.maxBytes,
      allowTruncated: request.allowTruncated,
      allowText: request.allowText,
      allowApiFailure: request.allowApiFailure,
      includeText: request.includeText,
    })
  }
}
