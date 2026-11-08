/**
 * Secret redaction for every value that leaves the plugin.
 *
 * Two independent protections are applied:
 * 1. Every resolved credential (AI key, access token, issued token key) is
 *    registered in-process and replaced wherever it appears verbatim.
 * 2. Object keys that conventionally carry credentials are masked, including
 *    `key` on token/channel objects even when the upstream value does not start
 *    with `sk-`.
 *
 * Redaction is best-effort and deliberately never logs the original value.
 */

const MASK = '***'
const registered = new Set()
const MAX_REGISTERED = 64

/** Remember one live secret so accidental echoes are scrubbed later. */
export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < 6) return
  if (registered.has(value)) return
  if (registered.size >= MAX_REGISTERED) {
    const oldest = registered.values().next().value
    if (oldest !== undefined) registered.delete(oldest)
  }
  registered.add(value)
}

/** Mask a secret for display; short values reveal nothing. */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.includes('*') && value.length <= 12) return value
  if (value.length <= 8) return MASK
  if (value.startsWith('sk-')) {
    const body = value.slice(3)
    if (body.length <= 8) return `sk-${MASK}`
    return `sk-${body.slice(0, 4)}${'*'.repeat(8)}${body.slice(-4)}`
  }
  if (value.length <= 12) return `${value.slice(0, 2)}${MASK}${value.slice(-2)}`
  return `${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-4)}`
}

/** Replace every registered secret inside one string. */
export function redactText(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  let text = value
  for (const secret of registered) {
    if (secret.length >= 6 && text.includes(secret)) text = text.split(secret).join(MASK)
  }
  return text
}

const SENSITIVE_KEY =
  /(^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|private[_-]?key|authorization|upstream[_-]?key|channel[_-]?key|client[_-]?secret)$/i

const TOKEN_OBJECT_HINTS = new Set([
  'remain_quota',
  'unlimited_quota',
  'model_limits',
  'allow_ips',
  'accessed_time',
  'expired_time',
])

const CHANNEL_OBJECT_HINTS = new Set([
  'models',
  'base_url',
  'channel_info',
  'priority',
  'weight',
  'auto_ban',
  'response_time',
  'test_time',
])

function looksLikeSecret(value) {
  return typeof value === 'string' && value.length >= 16 && !/\s/.test(value)
}

function looksLikeTokenOrChannelObject(object) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return false
  for (const key of Object.keys(object)) {
    if (TOKEN_OBJECT_HINTS.has(key) || CHANNEL_OBJECT_HINTS.has(key)) return true
  }
  return false
}

/**
 * Deep-copy a JSON-ish value with credentials masked.
 * @param {unknown} value
 * @param {{key?: string, parent?: unknown, seen?: WeakSet<object>}} [context]
 */
export function redactValue(value, context = {}) {
  if (typeof value === 'string') {
    const text = redactText(value)
    const key = context.key ?? ''
    if (SENSITIVE_KEY.test(key)) return MASK
    if (key === 'key') {
      if (value.startsWith('sk-')) return maskSecret(value)
      const parent = context.parent
      // Option lists use { key, value }; do not mask those key names. Other
      // objects with a secret-looking `key` are token/channel/raw payloads.
      if (looksLikeSecret(value)) {
        const optionLike =
          parent !== null &&
          typeof parent === 'object' &&
          !Array.isArray(parent) &&
          Object.hasOwn(parent, 'value') &&
          Object.keys(parent).length <= 2
        if (!optionLike || looksLikeTokenOrChannelObject(parent)) return maskSecret(value)
      }
    }
    return text
  }
  if (value === null || typeof value !== 'object') return value
  if (context.seen?.has(value)) return '[circular]'
  const seen = context.seen ?? new WeakSet()
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactValue(entry, { key: String(index), parent: value, seen }))
  }
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = redactValue(entry, { key, parent: value, seen })
  }
  return output
}

/** JSON.stringify with redaction, falling back to a readable placeholder. */
export function redactedJson(value, space = 2) {
  try {
    return JSON.stringify(redactValue(value), null, space)
  } catch {
    return '[unserializable]'
  }
}
