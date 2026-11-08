/**
 * Loopback-only HTTP surface for the New API settings page.
 *
 * A local bundle has no generated Remote namespace, so the Settings → New API
 * page talks to this Host half over a same-origin prefix route. The route
 * exposes exactly what the page needs — state, site write, credential write,
 * and the shared self-check — and nothing that would let a page read a secret
 * back out.
 */

import { NewApiError } from './errors.js'
import { credentialStatus, selfCheck } from './self-check.js'
import { normalizeBaseUrl } from './site.js'

const PREFIX = '/newapi'
const UI_HEADER = 'x-newapi-ui'
const MAX_BODY_BYTES = 16 * 1024
const MAX_API_KEY = 512
const MAX_ACCESS_TOKEN = 2048
const USER_ID = /^[A-Za-z0-9_-]{1,32}$/

/** Everything the page renders; never includes a credential value. */
async function readState(deps) {
  const settings = await deps.runtime.resolveSettings({ tolerateSecretErrors: true })
  const baseUrl = settings.baseUrl.length > 0 ? settings.baseUrl : null
  return {
    configured: baseUrl !== null,
    baseUrl: baseUrl ?? '',
    userId: settings.userId,
    source: {
      baseUrl: settings.baseUrlSource,
      userId: settings.userIdSource,
      apiKey: settings.apiKeySource,
      accessToken: settings.accessTokenSource,
    },
    credentials: {
      apiKey: credentialStatus(settings.apiKeySource, settings.apiKeyError),
      accessToken: credentialStatus(settings.accessTokenSource, settings.accessTokenError),
    },
    dataDir: settings.dataDir,
    config: {
      secretsBackend: settings.config.secretsBackend,
      timeoutMs: settings.config.timeoutMs,
      allowManagementWrites: settings.config.allowManagementWrites,
      audit: settings.config.audit,
    },
  }
}

function requireString(value, field, maximum) {
  if (typeof value !== 'string') {
    throw new NewApiError('INVALID_ARGS', `${field} 必须是字符串`, { hint: '请重新填写后再保存。' })
  }
  const text = value.trim()
  if (text.length === 0) {
    throw new NewApiError('INVALID_ARGS', `${field} 不能为空`, { hint: '留空表示不修改；要删除请用清除。' })
  }
  if (text.length > maximum) {
    throw new NewApiError('INVALID_ARGS', `${field} 太长（上限 ${maximum} 字符）`, { hint: '请确认是否粘贴了多余内容。' })
  }
  if (/[\r\n]/.test(text)) {
    throw new NewApiError('INVALID_ARGS', `${field} 不能包含换行`, { hint: '粘贴时请只保留凭据本身。' })
  }
  return text
}

async function writeSite(deps, body) {
  if (!Object.hasOwn(body, 'baseUrl') && !Object.hasOwn(body, 'userId')) {
    throw new NewApiError('INVALID_ARGS', '至少需要 baseUrl 或 userId', { hint: '请填写后重试。' })
  }
  const current = await deps.runtime.siteStore.read().catch(() => ({ baseUrl: null, userId: null }))
  const baseUrl =
    body.baseUrl === undefined ? current.baseUrl ?? undefined : normalizeBaseUrl(requireString(body.baseUrl, 'baseUrl', 2048))
  if (baseUrl === undefined) {
    throw new NewApiError('CONFIG_INVALID', '还没有可保存的网关地址', { hint: '请先填写网关根地址。' })
  }
  const userId = body.userId === undefined ? undefined : requireString(body.userId, 'userId', 32)
  if (userId !== undefined && !USER_ID.test(userId)) {
    throw new NewApiError('INVALID_ARGS', 'userId 只能是字母、数字、下划线或短横线', { hint: 'root 通常为 1。' })
  }
  await deps.runtime.siteStore.write({ baseUrl, ...(userId === undefined ? {} : { userId }) })
  deps.record('newapi.settings', {
    api: 'local',
    method: 'POST',
    path: '/newapi/site',
    ok: true,
  })
  return readState(deps)
}

async function writeCredential(deps, body) {
  const field = body.field
  if (field !== 'apiKey' && field !== 'accessToken') {
    throw new NewApiError('INVALID_ARGS', 'field 必须是 apiKey 或 accessToken', { hint: '请刷新页面后重试。' })
  }
  const ref = field === 'apiKey' ? 'site:apiKey' : 'site:accessToken'
  if (body.clear === true) {
    await deps.runtime.secretStore.delete(ref)
    deps.record('newapi.settings', { api: 'local', method: 'DELETE', path: `/newapi/credential/${field}`, ok: true })
    return readState(deps)
  }
  const maximum = field === 'apiKey' ? MAX_API_KEY : MAX_ACCESS_TOKEN
  const value = requireString(body.value, field === 'apiKey' ? 'AI 密钥' : '系统访问令牌', maximum)
  await deps.runtime.secretStore.set(ref, value)
  deps.record('newapi.settings', { api: 'local', method: 'POST', path: `/newapi/credential/${field}`, ok: true })
  return readState(deps)
}

async function runCheck(deps, body) {
  const clients = await deps.context({ tolerateSecretErrors: true })
  const check = await selfCheck(clients, {
    checkAi: body.checkAi !== false,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
  })
  deps.record('newapi.settings', {
    api: 'local',
    method: 'POST',
    path: '/newapi/test',
    ok: check.error === null,
    errorCode: check.error?.code ?? null,
  })
  return check
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function hasUiHeader(req) {
  const header = req.headers[UI_HEADER]
  return Array.isArray(header) ? header[0] === '1' : header === '1'
}

async function readJsonBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw new NewApiError('INVALID_ARGS', '请求体过大', { hint: '只发送需要更新的字段。' })
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new NewApiError('INVALID_ARGS', '请求体不是合法 JSON', { hint: '请刷新页面后重试。' })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NewApiError('INVALID_ARGS', '请求体必须是 JSON 对象', { hint: '请刷新页面后重试。' })
  }
  return value
}

function failure(error) {
  if (error instanceof NewApiError) {
    return { code: error.code, message: error.message, hint: error.hint }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    hint: '设置页请求失败，可查看宿主日志后重试。',
  }
}

/**
 * One request against the settings route.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{runtime: any, context: Function, record: Function}} deps
 */
export async function handleSettingsRequest(req, res, deps) {
  try {
    if (!isLoopbackAddress(req.socket?.remoteAddress ?? undefined)) {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '只允许本机访问设置页接口', hint: null } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(PREFIX.length).replace(/\/+$/, '')

    if (req.method === 'GET' && path === '/state') {
      sendJson(res, 200, { ok: true, state: await readState(deps) })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的方法', hint: null } })
      return
    }
    if (!hasUiHeader(req)) {
      sendJson(res, 403, {
        ok: false,
        error: { code: 'MISSING_UI_HEADER', message: '缺少设置页请求头', hint: '请从 设置 → New API 页面操作。' },
      })
      return
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES)

    if (path === '/site') {
      sendJson(res, 200, { ok: true, state: await writeSite(deps, body) })
      return
    }
    if (path === '/credential') {
      sendJson(res, 200, { ok: true, state: await writeCredential(deps, body) })
      return
    }
    if (path === '/test') {
      sendJson(res, 200, { ok: true, check: await runCheck(deps, body) })
      return
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知端点', hint: null } })
  } catch (error) {
    const info = failure(error)
    const status = info.code === 'INVALID_ARGS' || info.code === 'CONFIG_INVALID' ? 400 : 500
    try {
      sendJson(res, status, { ok: false, error: info })
    } catch {
      // The socket may already be gone.
    }
  }
}

/**
 * Register the settings route when this deployment serves a browser UI.
 * A headless harness has no `webServer`, and the tools keep working there.
 */
export function mountSettingsRoute(ctx, deps) {
  const route = {
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => handleSettingsRequest(req, res, deps),
  }
  const attach = (scope) => {
    let webServer
    try {
      webServer = typeof scope.get === 'function' ? scope.get('webServer') : undefined
    } catch {
      webServer = undefined
    }
    if (webServer === undefined || typeof webServer.register !== 'function') return
    scope.effect(() => webServer.register(route))
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (inner) => attach(inner))
      return
    }
  } catch {
    // Older contexts: fall through to a direct read.
  }
  attach(ctx)
}
