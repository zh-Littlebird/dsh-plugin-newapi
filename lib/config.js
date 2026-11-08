/**
 * Runtime configuration resolution.
 *
 * Precedence for non-secret fields: explicit plugin config > environment >
 * `$DSH_HOME/newapi/site.json`. Credentials come from the environment when the
 * backend allows it, otherwise from the encrypted file store; environment wins
 * in `auto` mode.
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NewApiError } from './errors.js'
import { SecretStore } from './secrets.js'
import { SiteStore, normalizeBaseUrl } from './site.js'

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_VERSION = '1.2.1'

export const DEFAULTS = {
  baseUrl: '',
  userId: '1',
  apiKeyEnv: 'NEWAPI_API_KEY',
  accessTokenEnv: 'NEWAPI_ACCESS_TOKEN',
  dataDir: '',
  secretsBackend: 'auto',
  timeoutMs: 120_000,
  maxResponseBytes: 8 * 1024 * 1024,
  allowManagementWrites: true,
  audit: true,
  debug: false,
}

const BACKENDS = new Set(['auto', 'env', 'file', 'none'])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInteger(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const candidate = text(value)
    if (candidate.length > 0) return candidate
  }
  return ''
}

/** `$DSH_HOME/newapi`, or an explicit `dataDir`. */
export function resolveDataDir(config = {}) {
  const override = firstNonEmpty(process.env.DSH_NEWAPI_DATA_DIR, config.dataDir)
  if (override.length > 0) return resolve(override)
  const home = firstNonEmpty(process.env.DSH_HOME) || join(homedir(), '.dsh')
  return resolve(home, 'newapi')
}

/** Normalize the raw plugin config (patch YAML or programmatic object). */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const backend = text(input.secretsBackend).toLowerCase()
  return {
    baseUrl: text(input.baseUrl),
    userId: text(input.userId),
    apiKeyEnv: firstNonEmpty(input.apiKeyEnv, DEFAULTS.apiKeyEnv),
    accessTokenEnv: firstNonEmpty(input.accessTokenEnv, DEFAULTS.accessTokenEnv),
    dataDir: text(input.dataDir),
    secretsBackend: BACKENDS.has(backend) ? backend : DEFAULTS.secretsBackend,
    timeoutMs: clampInteger(input.timeoutMs, DEFAULTS.timeoutMs, 1_000, 600_000),
    maxResponseBytes: clampInteger(
      input.maxResponseBytes,
      DEFAULTS.maxResponseBytes,
      64 * 1024,
      64 * 1024 * 1024,
    ),
    allowManagementWrites:
      typeof input.allowManagementWrites === 'boolean'
        ? input.allowManagementWrites
        : DEFAULTS.allowManagementWrites,
    audit: typeof input.audit === 'boolean' ? input.audit : DEFAULTS.audit,
    debug: typeof input.debug === 'boolean' ? input.debug : DEFAULTS.debug,
  }
}

/** Command the user can run locally to provision the missing piece. */
export function cliCommand(args) {
  return `node "${join(PLUGIN_DIR, 'scripts', 'dsh-newapi.mjs')}" ${args}`
}

/**
 * Create the per-mount runtime. `resolve()` is called per tool invocation so
 * edits to site.json or the environment do not require a host restart.
 */
export function createRuntime(rawConfig) {
  const config = normalizeConfig(rawConfig)
  const dataDir = resolveDataDir(config)
  const siteStore = new SiteStore({ dir: dataDir })
  const secretStore = new SecretStore({ dir: dataDir })

  /**
   * Cheap readiness check used by tool registration conditions: a usable
   * baseUrl exists. Credentials are deliberately not decrypted here, so the
   * condition stays cheap and never fails on a broken secret store.
   */
  async function isConfigured() {
    try {
      const site = await siteStore.read()
      const candidate = firstNonEmpty(config.baseUrl, process.env.NEWAPI_BASE_URL, site.baseUrl)
      if (candidate.length === 0) return false
      normalizeBaseUrl(candidate)
      return true
    } catch {
      return false
    }
  }

  /**
   * @param {{tolerateSecretErrors?: boolean}} [options]
   */
  async function resolveSettings(options = {}) {
    const site = await siteStore.read()

    const baseUrlInput = firstNonEmpty(config.baseUrl, process.env.NEWAPI_BASE_URL, site.baseUrl)
    const baseUrl = baseUrlInput.length > 0 ? normalizeBaseUrl(baseUrlInput) : ''
    const baseUrlSource =
      text(config.baseUrl).length > 0
        ? 'config'
        : text(process.env.NEWAPI_BASE_URL).length > 0
          ? 'env:NEWAPI_BASE_URL'
          : site.baseUrl !== null
            ? 'site.json'
            : null

    const userId = firstNonEmpty(config.userId, process.env.NEWAPI_USER_ID, site.userId, '1')
    const userIdSource =
      text(config.userId).length > 0
        ? 'config'
        : text(process.env.NEWAPI_USER_ID).length > 0
          ? 'env:NEWAPI_USER_ID'
          : site.userId !== null
            ? 'site.json'
            : 'default'

    let apiKey
    let accessToken
    let apiKeyError = null
    let accessTokenError = null

    const backend = config.secretsBackend
    const envApiKey = text(process.env[config.apiKeyEnv])
    const envAccessToken = text(process.env[config.accessTokenEnv])

    if (backend === 'env' || backend === 'auto') {
      if (envApiKey.length > 0) apiKey = envApiKey
      if (envAccessToken.length > 0) accessToken = envAccessToken
    }

    if ((apiKey === undefined && (backend === 'file' || backend === 'auto')) || (accessToken === undefined && (backend === 'file' || backend === 'auto'))) {
      try {
        if (apiKey === undefined && backend !== 'env') apiKey = await secretStore.get('site:apiKey')
        if (accessToken === undefined && backend !== 'env') accessToken = await secretStore.get('site:accessToken')
      } catch (error) {
        if (!options.tolerateSecretErrors) throw error
        const message = error instanceof Error ? error.message : String(error)
        apiKeyError = message
        accessTokenError = message
      }
    }

    const apiKeySource =
      envApiKey.length > 0 && (backend === 'env' || backend === 'auto')
        ? `env:${config.apiKeyEnv}`
        : backend === 'none'
          ? 'none'
          : apiKey !== undefined
            ? 'file'
            : 'missing'
    const accessTokenSource =
      envAccessToken.length > 0 && (backend === 'env' || backend === 'auto')
        ? `env:${config.accessTokenEnv}`
        : backend === 'none'
          ? 'none'
          : accessToken !== undefined
            ? 'file'
            : 'missing'

    return {
      config,
      dataDir,
      siteFile: siteStore.file,
      credentialsFile: secretStore.credentialsFile,
      issuedDir: join(dataDir, 'issued'),
      baseUrl,
      baseUrlSource,
      userId,
      userIdSource,
      apiKey,
      accessToken,
      apiKeySource,
      accessTokenSource,
      apiKeyError,
      accessTokenError,
      secretStore,
      siteStore,
    }
  }

  return { config, dataDir, siteStore, secretStore, resolveSettings, isConfigured }
}

export function requireBaseUrl(settings) {
  if (settings.baseUrl.length > 0) return settings.baseUrl
  throw new NewApiError('CONFIG_MISSING', '还没有配置 New API 网关地址', {
    hint: `请由用户在本机运行 ${cliCommand('setup --base-url https://api.example.com --user-id 1')}，或在插件配置中填写 baseUrl。`,
  })
}

export function requireApiKey(settings) {
  if (typeof settings.apiKey === 'string' && settings.apiKey.length > 0) return settings.apiKey
  throw new NewApiError('CONFIG_MISSING', '缺少 AI 接口密钥（sk- 开头）', {
    hint: `请由用户在本机运行 ${cliCommand('set --api-key')} 录入，或设置环境变量 ${settings.config.apiKeyEnv}。模型不会接收密钥。`,
  })
}

export function requireAccessToken(settings) {
  if (typeof settings.accessToken === 'string' && settings.accessToken.length > 0) return settings.accessToken
  throw new NewApiError('CONFIG_MISSING', '缺少管理接口访问令牌（系统访问令牌）', {
    hint: `请由用户在本机运行 ${cliCommand('set --access-token')} 录入，或设置环境变量 ${settings.config.accessTokenEnv}。sk- 密钥不能调用管理接口。`,
  })
}
