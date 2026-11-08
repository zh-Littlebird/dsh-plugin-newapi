/** `newapi_site`: gateway configuration, self-check, and account quota. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { cliCommand } from '../config.js'
import { NewApiError } from '../errors.js'
import { normalizeBaseUrl } from '../site.js'
import { credentialStatus, quotaCheck, selfCheck } from '../self-check.js'
import {
  AUTH_CHECK_SCHEMA,
  ERROR_SCHEMA,
  NULLABLE_BOOLEAN,
  NULLABLE_NUMBER,
  NULLABLE_STRING,
  SITE_SUMMARY_SCHEMA,
  USER_SUMMARY_SCHEMA,
} from './schemas.js'

const CREDENTIAL_STATUS = S.string({ required: true, enum: ['available', 'missing', 'unavailable'] })

const SOURCE_SCHEMA = S.object(
  {
    baseUrl: NULLABLE_STRING,
    userId: S.string({ required: true }),
    apiKey: S.string({ required: true }),
    accessToken: S.string({ required: true }),
  },
  { additionalProperties: false },
)

const CREDENTIALS_SCHEMA = S.object(
  {
    apiKey: CREDENTIAL_STATUS,
    accessToken: CREDENTIAL_STATUS,
  },
  { additionalProperties: false },
)

const CONFIG_SCHEMA = S.object(
  {
    secretsBackend: S.string({ required: true }),
    timeoutMs: S.integer({ required: true }),
    maxResponseBytes: S.integer({ required: true }),
    allowManagementWrites: S.boolean({ required: true }),
    audit: S.boolean({ required: true }),
  },
  { additionalProperties: false },
)

const AUTH_SCHEMA = S.object(
  {
    management: AUTH_CHECK_SCHEMA,
    ai: AUTH_CHECK_SCHEMA,
  },
  { additionalProperties: false },
)

const QUOTA_SCHEMA = S.object(
  {
    quotaPerUnit: NULLABLE_NUMBER,
    approxAmount: NULLABLE_NUMBER,
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    action: S.string({ required: true, enum: ['show', 'set', 'test', 'quota'] }),
    configured: S.boolean({ required: true }),
    saved: S.boolean({ required: true }),
    baseUrl: NULLABLE_STRING,
    userId: S.string({ required: true }),
    source: SOURCE_SCHEMA,
    credentials: CREDENTIALS_SCHEMA,
    dataDir: S.string({ required: true }),
    config: CONFIG_SCHEMA,
    reachable: NULLABLE_BOOLEAN,
    site: S.oneOf([SITE_SUMMARY_SCHEMA, S.null()]),
    auth: S.oneOf([AUTH_SCHEMA, S.null()]),
    user: S.oneOf([USER_SUMMARY_SCHEMA, S.null()]),
    quota: S.oneOf([QUOTA_SCHEMA, S.null()]),
    durationMs: S.integer({ required: true }),
    hint: NULLABLE_STRING,
    error: S.oneOf([ERROR_SCHEMA, S.null()]),
  },
  { additionalProperties: false },
)

function hintFor(settings, baseUrl) {
  if (baseUrl === null) {
    return `尚未配置网关地址。请让用户在本机运行：${cliCommand('setup --base-url https://api.example.com --user-id 1')}，或在 设置 → New API 里填写。`
  }
  const missing = []
  if (settings.apiKeySource === 'missing') missing.push(cliCommand('set --api-key'))
  if (settings.accessTokenSource === 'missing') missing.push(cliCommand('set --access-token'))
  if (missing.length > 0) {
    return `缺少凭据。请让用户在本机运行：${missing.join('；')}，或在 设置 → New API 里填写。`
  }
  if (settings.baseUrlSource === 'config') {
    return '当前 baseUrl 来自插件配置，优先级高于 site.json；要修改请编辑插件配置。'
  }
  return null
}

/** The non-network part of every action's result. */
function baseView(action, settings, saved) {
  const baseUrl = settings.baseUrl.length > 0 ? settings.baseUrl : null
  return {
    action,
    configured: baseUrl !== null,
    saved,
    baseUrl,
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
      maxResponseBytes: settings.config.maxResponseBytes,
      allowManagementWrites: settings.config.allowManagementWrites,
      audit: settings.config.audit,
    },
    reachable: null,
    site: null,
    auth: null,
    user: null,
    quota: null,
    durationMs: 0,
    hint: hintFor(settings, baseUrl),
    error: null,
  }
}

function renderShow(value) {
  const lines = [
    `New API 站点配置${value.saved ? '（已保存 site.json）' : ''}`,
    `  网关: ${value.baseUrl ?? '（未配置）'}`,
    `  用户 ID: ${value.userId}（来源 ${value.source.userId}）`,
    `  凭据: AI Key=${value.credentials.apiKey}，管理令牌=${value.credentials.accessToken}`,
    `  数据目录: ${value.dataDir}`,
    `  配置: backend=${value.config.secretsBackend} timeout=${value.config.timeoutMs}ms 管理写=${value.config.allowManagementWrites ? '允许' : '禁止'}`,
  ]
  if (value.hint !== null) lines.push('', value.hint)
  return lines
}

function renderTest(value) {
  const lines = [
    `New API 自检：${value.baseUrl ?? '（未配置网关）'}`,
    `  可达: ${value.reachable ? '是' : '否'}`,
    `  站点: ${value.site?.systemName ?? '未知'}${value.site?.version ? `  v${value.site.version}` : ''}`,
    `  管理接口: ${value.auth?.management.status ?? '未执行'}${value.auth?.management.message ? ` — ${value.auth.management.message}` : ''}`,
    `  AI 接口: ${value.auth?.ai.status ?? '未执行'}${value.auth?.ai.message ? ` — ${value.auth.ai.message}` : ''}`,
    `  凭据: AI Key=${value.credentials.apiKey}，管理令牌=${value.credentials.accessToken}`,
    `  耗时: ${value.durationMs} ms`,
  ]
  if (value.user !== null) {
    lines.push(
      `  当前用户: ${value.user.username ?? value.user.displayName ?? '未知'} (${value.user.roleLabel})`,
      `  额度: ${value.user.quota ?? '未知'}，已用: ${value.user.usedQuota ?? '未知'}，分组: ${value.user.group ?? '未知'}`,
    )
  }
  if (value.error !== null) {
    lines.push(`  错误: [${value.error.code}] ${value.error.message}${value.error.hint ? `；${value.error.hint}` : ''}`)
  }
  if (value.hint !== null) lines.push('', value.hint)
  return lines
}

function renderQuota(value) {
  const user = value.user
  const lines = [
    `账户：${user?.username ?? user?.displayName ?? '未知'}（ID ${user?.id ?? '?'}，${user?.roleLabel ?? '未知'}）`,
    `  分组: ${user?.group ?? '未知'}  状态: ${user?.status ?? '未知'}`,
    `  剩余额度: ${user?.quota ?? '未知'}  已用额度: ${user?.usedQuota ?? '未知'}`,
    `  请求数: ${user?.requestCount ?? '未知'}`,
  ]
  if (value.quota?.quotaPerUnit !== null && value.quota?.quotaPerUnit !== undefined) {
    lines.push(`  站点 quota_per_unit: ${value.quota.quotaPerUnit}`)
  }
  if (value.quota?.approxAmount !== null && value.quota?.approxAmount !== undefined) {
    lines.push(
      `  按 quota_per_unit 换算剩余: ${value.quota.approxAmount.toFixed(6)}（站点定义的货币单位，不一定是 USD）`,
    )
  } else {
    lines.push('  金额换算: 站点未提供 quota_per_unit，不能把 quota 直接当成货币金额。')
  }
  if (user?.affQuota !== null || user?.affCount !== null) {
    lines.push(`  邀请返利: quota=${user?.affQuota ?? '?'} count=${user?.affCount ?? '?'}`)
  }
  if (value.hint !== null) lines.push('', value.hint)
  return lines
}

function render(value) {
  const lines =
    value.action === 'test' ? renderTest(value) : value.action === 'quota' ? renderQuota(value) : renderShow(value)
  return [{ type: 'text', text: lines.join('\n') }]
}

async function runTest(deps, args, exec) {
  const clients = await deps.context({ tolerateSecretErrors: true })
  const value = baseView('test', clients.settings, false)
  const result = await selfCheck(clients, {
    checkAi: args.checkAi,
    timeoutMs: args.timeoutMs,
    signal: exec.signal,
  })
  value.reachable = result.reachable
  value.site = result.site
  value.auth = result.auth
  value.user = result.user
  value.error = result.error
  value.durationMs = result.durationMs
  return value
}

async function runQuota(deps, args, exec) {
  const clients = await deps.context()
  const value = baseView('quota', clients.settings, false)
  const result = await quotaCheck(clients, { timeoutMs: args.timeoutMs, signal: exec.signal })
  value.user = result.user
  value.quota = result.quota
  value.durationMs = result.durationMs
  return value
}

/** Register the site tool. */
export function registerSiteTool(ctx, deps) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_site',
      description:
        'New API 站点入口：action=show 查看配置；set 写入 baseUrl/userId；test 自检连通性、管理令牌与 AI 密钥；quota 查账户额度。' +
        '本工具不接收密钥，密钥由用户在本机运行 scripts/dsh-newapi.mjs 或打开 设置 → New API 录入。未配置网关时其余 newapi_* 工具不会注册。',
      parameters: S.object(
        {
          action: S.string({
            description: 'show（默认）/ set / test / quota。',
            enum: ['show', 'set', 'test', 'quota'],
          }),
          baseUrl: S.string({
            description: '仅 set：网关根地址，可只写 IP:端口（如 192.0.2.10:3000，默认 http://），也可写完整 URL；不要带 /v1 或 /api。',
          }),
          userId: S.string({ description: '仅 set：管理接口的 New-Api-User；root 通常为 1。' }),
          checkAi: S.boolean({ description: '仅 test：是否用 AI 密钥请求 /v1/models，默认 true。' }),
          timeoutMs: S.integer({ description: '单项超时（毫秒）；默认 test 每条 20000。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const action = args.action ?? 'show'

        if (action === 'set') {
          if (args.baseUrl === undefined && args.userId === undefined) {
            throw new NewApiError('INVALID_ARGS', 'action=set 至少需要 baseUrl 或 userId', {
              hint: '例如 {"action":"set","baseUrl":"https://api.example.com","userId":"1"}。',
            })
          }
          const before = await deps.runtime
            .resolveSettings({ tolerateSecretErrors: true })
            .catch(() => null)
          const baseUrl =
            args.baseUrl !== undefined
              ? normalizeBaseUrl(args.baseUrl)
              : before !== null && before.baseUrl.length > 0
                ? before.baseUrl
                : undefined
          if (baseUrl === undefined) {
            throw new NewApiError('CONFIG_MISSING', '还没有可保存的 baseUrl', {
              hint: '请同时提供 baseUrl，例如 {"action":"set","baseUrl":"https://api.example.com"}。',
            })
          }
          const userId = args.userId === undefined ? undefined : args.userId.trim()
          if (userId !== undefined && userId.length === 0) {
            throw new NewApiError('INVALID_ARGS', 'userId 不能为空', { hint: 'root 通常为 1。' })
          }
          await deps.runtime.siteStore.write({ baseUrl, ...(userId === undefined ? {} : { userId }) })
          const settings = await deps.runtime.resolveSettings({ tolerateSecretErrors: true })
          return baseView('set', settings, true)
        }

        if (action === 'test') return runTest(deps, args, exec)
        if (action === 'quota') return runQuota(deps, args, exec)

        const { settings } = await deps.context({ tolerateSecretErrors: true })
        return baseView('show', settings, false)
      },
    }),
  )
}
