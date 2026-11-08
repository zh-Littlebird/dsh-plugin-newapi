/** Rendering and field-normalization helpers shared by tool modules. */

import { maskSecret, redactText, redactValue } from '../redact.js'

export function createDebug(enabled) {
  return (message) => {
    if (!enabled) return
    try {
      console.error(`[newapi] ${redactText(String(message))}`)
    } catch {
      // Diagnostics must never break a tool call.
    }
  }
}

/** Trim a JSON rendering to a model-friendly size. */
export function renderJson(value, maxChars = 6_000) {
  let text
  try {
    text = JSON.stringify(redactValue(value), null, 2)
  } catch {
    text = String(value)
  }
  if (text === undefined) return 'null'
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`
}

export function truncateText(value, maxChars) {
  if (typeof value !== 'string') return ''
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`
}

export function formatTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000
    try {
      return new Date(milliseconds).toISOString()
    } catch {
      return null
    }
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return null
}

export function asString(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? null : String(value)
}

export function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

export function splitList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return []
}

export function maskKey(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return maskSecret(value)
}

export function statusLabel(status) {
  if (status === 1) return '启用'
  if (status === 2) return '禁用'
  if (status === 3) return '已过期'
  if (status === 4) return '额度耗尽'
  if (typeof status === 'number') return `状态 ${status}`
  return '未知'
}

export function roleLabel(role) {
  if (role === 100) return 'Root'
  if (role === 10) return 'Admin'
  if (role === 1) return 'User'
  return role === null || role === undefined ? '未知' : String(role)
}

export function renderError(error) {
  if (error === null || error === undefined) return ''
  const code = error.code ?? 'ERROR'
  const message = error.message ?? String(error)
  const hint = error.hint ? `\n提示：${error.hint}` : ''
  return `[${code}] ${message}${hint}`
}

/** Build the standard structured error block; callers must have already handled it. */
export function errorInfo(error) {
  if (error === null || typeof error !== 'object') {
    return { code: 'INTERNAL_ERROR', message: String(error), hint: null, status: null }
  }
  return {
    code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
    message: typeof error.message === 'string' ? error.message : String(error),
    hint: typeof error.hint === 'string' ? error.hint : null,
    status: typeof error.status === 'number' ? error.status : null,
  }
}
