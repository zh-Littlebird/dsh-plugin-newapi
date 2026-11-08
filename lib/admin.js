/**
 * Management-surface client (`/api/*`).
 *
 * Every method returns the unwrapped `data` value plus the upstream message;
 * callers decide how to summarize. Authentication errors are thrown by the
 * transport with a hint that distinguishes `sk-` keys from system tokens.
 */

import { NewApiError } from './errors.js'

/** New API list payloads appear as an array or `{ items, total }`. */
export function listFrom(data) {
  if (Array.isArray(data)) return data
  if (data !== null && typeof data === 'object') {
    if (Array.isArray(data.items)) return data.items
    if (Array.isArray(data.data)) return data.data
    if (Array.isArray(data.list)) return data.list
  }
  return []
}

/** Extract the upstream total when present. */
export function totalFrom(data, fallback) {
  if (data !== null && typeof data === 'object') {
    for (const key of ['total', 'count', 'total_count']) {
      if (typeof data[key] === 'number' && Number.isFinite(data[key])) return data[key]
    }
  }
  return fallback
}

function unwrap(response) {
  const json = response.json
  if (json !== null && typeof json === 'object' && !Array.isArray(json) && Object.hasOwn(json, 'success')) {
    return {
      success: json.success !== false,
      message: typeof json.message === 'string' ? json.message : '',
      data: json.data ?? null,
      json,
      status: response.status,
      durationMs: response.durationMs,
      requestId: response.requestId,
    }
  }
  return {
    success: true,
    message: '',
    data: json,
    json,
    status: response.status,
    durationMs: response.durationMs,
    requestId: response.requestId,
  }
}

export class AdminClient {
  /** @param {{settings: any, transport: any, debug: (message: string) => void}} options */
  constructor(options) {
    this.settings = options.settings
    this.transport = options.transport
    this.debug = options.debug
  }

  async status(options = {}) {
    const response = await this.transport.request({
      api: 'public',
      method: 'GET',
      path: '/api/status',
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 20_000,
    })
    return unwrap(response)
  }

  async self(options = {}) {
    const response = await this.transport.request({
      api: 'admin',
      method: 'GET',
      path: '/api/user/self',
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    return unwrap(response)
  }

  async tokens(args) {
    const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : ''
    const response = await this.transport.request({
      api: 'admin',
      method: 'GET',
      path: keyword.length > 0 ? '/api/token/search' : '/api/token/',
      query:
        keyword.length > 0
          ? { keyword }
          : { p: args.page ?? 1, page_size: args.pageSize ?? 20 },
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    })
    return unwrap(response)
  }

  async tokenCreate(body, options = {}) {
    const response = await this.transport.request({
      api: 'admin',
      method: 'POST',
      path: '/api/token/',
      body,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    return unwrap(response)
  }

  async tokenDelete(id, options = {}) {
    const response = await this.transport.request({
      api: 'admin',
      method: 'DELETE',
      path: `/api/token/${encodeURIComponent(String(id))}`,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    return unwrap(response)
  }

  async channels(args) {
    const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : ''
    const query = keyword.length > 0
      ? { keyword }
      : {
          p: args.page ?? 1,
          page_size: args.pageSize ?? 20,
          id_sort: true,
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.type === undefined ? {} : { type: args.type }),
        }
    const response = await this.transport.request({
      api: 'admin',
      method: 'GET',
      path: keyword.length > 0 ? '/api/channel/search' : '/api/channel/',
      query,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    })
    return unwrap(response)
  }

  async channelTest(id, options = {}) {
    const response = await this.transport.request({
      api: 'admin',
      method: 'GET',
      path: `/api/channel/test/${encodeURIComponent(String(id))}`,
      allowApiFailure: true,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 60_000,
    })
    const result = unwrap(response)
    return { ...result, ok: result.success }
  }

  async logs(query, options = {}) {
    const response = await this.transport.request({
      api: 'admin',
      method: 'GET',
      path: '/api/log/',
      query,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    return unwrap(response)
  }

  async logStat(query, options = {}) {
    const response = await this.transport.request({
      api: 'admin',
      method: 'GET',
      path: '/api/log/stat',
      query,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    return unwrap(response)
  }

  async options(options = {}) {
    const response = await this.transport.request({
      api: 'admin',
      method: 'GET',
      path: '/api/option/',
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    return unwrap(response)
  }

  /** Escape hatch used by `newapi_raw`; the caller owns path/body validation. */
  async raw(args) {
    const response = await this.transport.request({
      api: args.api,
      method: args.method,
      path: args.path,
      query: args.query,
      body: args.body,
      allowApiFailure: true,
      allowText: true,
      allowTruncated: args.allowTruncated === true,
      maxBytes: args.maxBytes,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    })
    const result = unwrap(response)
    return { ...result, text: response.text }
  }
}

/** Throw unless a management response reports success. */
export function assertSuccess(result, action) {
  if (result.success === false) {
    throw new NewApiError('API_ERROR', result.message.length > 0 ? result.message : `${action}失败`, {
      hint: '网关返回 success=false；请按 message 调整请求。',
    })
  }
  return result.data
}
