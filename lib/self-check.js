/**
 * Site inspection shared by the `newapi_site` tool and the settings page.
 *
 * One implementation, two callers: the tool renders it as text for the model,
 * the loopback route returns it as JSON for the browser. Neither path talks to
 * the gateway on its own.
 */

import { errorInfo, roleLabel } from './tools/common.js'

/** Credential availability as the model and the UI both report it. */
export function credentialStatus(source, error) {
  if (error !== null) return 'unavailable'
  if (source === 'none') return 'unavailable'
  if (source === 'missing') return 'missing'
  return 'available'
}

export function siteSummary(data) {
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      systemName: null,
      version: null,
      setup: null,
      quotaPerUnit: null,
      logMaxRangeDays: null,
      startTime: null,
    }
  }
  return {
    systemName: typeof data.system_name === 'string' ? data.system_name : null,
    version: typeof data.version === 'string' ? data.version : null,
    setup: typeof data.setup === 'boolean' ? data.setup : null,
    quotaPerUnit: number(data.quota_per_unit),
    logMaxRangeDays: number(data.log_max_range_days),
    startTime: number(data.start_time),
  }
}

export function userSummary(data) {
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      id: null,
      username: null,
      displayName: null,
      role: null,
      roleLabel: '未知',
      status: null,
      group: null,
      quota: null,
      usedQuota: null,
      requestCount: null,
      affQuota: null,
      affCount: null,
    }
  }
  return {
    id: number(data.id),
    username: typeof data.username === 'string' ? data.username : null,
    displayName: typeof data.display_name === 'string' ? data.display_name : null,
    role: number(data.role),
    roleLabel: roleLabel(data.role),
    status: number(data.status),
    group: typeof data.group === 'string' ? data.group : null,
    quota: number(data.quota),
    usedQuota: number(data.used_quota),
    requestCount: number(data.request_count),
    affQuota: number(data.aff_quota),
    affCount: number(data.aff_count),
  }
}

/**
 * Public status, management auth, AI key, and the current user.
 *
 * @param {{settings: any, ai: any, admin: any}} clients resolved for this call
 * @param {{checkAi?: boolean, timeoutMs?: number, signal?: AbortSignal}} [options]
 */
export async function selfCheck(clients, options = {}) {
  const started = Date.now()
  const { settings, ai, admin } = clients
  const result = {
    baseUrl: settings.baseUrl.length > 0 ? settings.baseUrl : null,
    credentials: {
      apiKey: credentialStatus(settings.apiKeySource, settings.apiKeyError),
      accessToken: credentialStatus(settings.accessTokenSource, settings.accessTokenError),
    },
    reachable: false,
    site: siteSummary(null),
    auth: {
      management: { status: 'skipped', message: null, modelCount: null },
      ai: { status: 'skipped', message: null, modelCount: null },
    },
    user: null,
    error: null,
    durationMs: 0,
  }

  if (settings.baseUrl.length === 0) {
    result.auth.management =
      result.credentials.accessToken === 'available'
        ? { status: 'skipped', message: '没有 baseUrl，未发起管理接口请求', modelCount: null }
        : { status: 'missing', message: '未配置系统访问令牌', modelCount: null }
    result.auth.ai =
      result.credentials.apiKey === 'available'
        ? { status: 'skipped', message: '没有 baseUrl，未发起 AI 接口请求', modelCount: null }
        : { status: 'missing', message: '未配置 AI 密钥', modelCount: null }
    result.error = {
      code: 'CONFIG_MISSING',
      message: '还没有配置 New API 网关地址',
      hint: '先保存网关地址，再测试连接。',
      status: null,
    }
    result.durationMs = Date.now() - started
    return result
  }

  try {
    const status = await admin.status({ timeoutMs: options.timeoutMs, signal: options.signal })
    result.reachable = true
    result.site = siteSummary(status.data)
  } catch (error) {
    result.error = errorInfo(error)
    result.durationMs = Date.now() - started
    return result
  }

  if (typeof settings.accessToken === 'string' && settings.accessToken.length > 0) {
    try {
      const self = await admin.self({ timeoutMs: options.timeoutMs, signal: options.signal })
      result.user = userSummary(self.data)
      result.auth.management = {
        status: 'ok',
        message: self.message.length > 0 ? self.message : null,
        modelCount: null,
      }
    } catch (error) {
      const info = errorInfo(error)
      result.auth.management = { status: 'failed', message: `[${info.code}] ${info.message}`, modelCount: null }
    }
  } else {
    result.auth.management = { status: 'missing', message: '未配置系统访问令牌', modelCount: null }
  }

  if (options.checkAi === false) {
    result.auth.ai = { status: 'skipped', message: 'checkAi=false，已跳过', modelCount: null }
  } else if (typeof settings.apiKey === 'string' && settings.apiKey.length > 0) {
    try {
      const models = await ai.models({ timeoutMs: options.timeoutMs ?? 20_000, signal: options.signal })
      result.auth.ai = { status: 'ok', message: null, modelCount: models.count }
    } catch (error) {
      const info = errorInfo(error)
      result.auth.ai = { status: 'failed', message: `[${info.code}] ${info.message}`, modelCount: null }
    }
  } else {
    result.auth.ai = { status: 'missing', message: '未配置 AI 密钥', modelCount: null }
  }

  result.durationMs = Date.now() - started
  return result
}

/** Current user quota plus the site's own quota-per-unit conversion. */
export async function quotaCheck(clients, options = {}) {
  const { admin } = clients
  const self = await admin.self({ signal: options.signal, timeoutMs: options.timeoutMs })
  const data = self.data !== null && typeof self.data === 'object' && !Array.isArray(self.data) ? self.data : {}
  const user = userSummary(data)
  const quotaPerUnit = await admin
    .status({ signal: options.signal, timeoutMs: options.timeoutMs ?? 20_000 })
    .then((status) => (typeof status.data?.quota_per_unit === 'number' ? status.data.quota_per_unit : null))
    .catch(() => null)
  const quota = typeof data.quota === 'number' && Number.isFinite(data.quota) ? data.quota : null
  return {
    user,
    quota: {
      quotaPerUnit,
      approxAmount: quota !== null && quotaPerUnit !== null && quotaPerUnit > 0 ? quota / quotaPerUnit : null,
    },
    durationMs: self.durationMs,
  }
}
