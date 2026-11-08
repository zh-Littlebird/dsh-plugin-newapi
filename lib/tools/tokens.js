/** `newapi_tokens`: list/search, create (one-time delivery), and delete tokens. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { NewApiError } from '../errors.js'
import { writeIssuedToken } from '../issued.js'
import { assertSuccess, listFrom, totalFrom } from '../admin.js'
import { maskKey, statusLabel, truncateText } from './common.js'
import { NULLABLE_BOOLEAN, NULLABLE_INTEGER, NULLABLE_NUMBER, NULLABLE_STRING } from './schemas.js'

const TOKEN_SCHEMA = S.object(
  {
    id: NULLABLE_INTEGER,
    name: NULLABLE_STRING,
    keyMasked: NULLABLE_STRING,
    status: NULLABLE_INTEGER,
    statusLabel: S.string({ required: true }),
    group: NULLABLE_STRING,
    remainQuota: NULLABLE_NUMBER,
    usedQuota: NULLABLE_NUMBER,
    unlimitedQuota: NULLABLE_BOOLEAN,
    expiredTime: NULLABLE_INTEGER,
    createdTime: NULLABLE_INTEGER,
    accessedTime: NULLABLE_INTEGER,
    modelLimits: NULLABLE_STRING,
    allowIps: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    action: S.string({ required: true, enum: ['list', 'create', 'delete'] }),
    count: NULLABLE_INTEGER,
    total: NULLABLE_INTEGER,
    page: NULLABLE_INTEGER,
    pageSize: NULLABLE_INTEGER,
    tokens: S.oneOf([S.array(TOKEN_SCHEMA), S.null()]),
    created: NULLABLE_BOOLEAN,
    id: NULLABLE_INTEGER,
    name: NULLABLE_STRING,
    keyMasked: NULLABLE_STRING,
    key: NULLABLE_STRING,
    delivery: S.oneOf([S.string({ enum: ['file', 'inline', 'none'] }), S.null()]),
    keyFile: NULLABLE_STRING,
    deleted: NULLABLE_BOOLEAN,
    message: NULLABLE_STRING,
    hint: NULLABLE_STRING,
    nextStep: NULLABLE_STRING,
    durationMs: S.integer({ required: true }),
  },
  { additionalProperties: false },
)

function base(action) {
  return {
    action,
    count: null,
    total: null,
    page: null,
    pageSize: null,
    tokens: null,
    created: null,
    id: null,
    name: null,
    keyMasked: null,
    key: null,
    delivery: null,
    keyFile: null,
    deleted: null,
    message: null,
    hint: null,
    nextStep: null,
    durationMs: 0,
  }
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function tokenView(token) {
  if (token === null || typeof token !== 'object') {
    return {
      id: null,
      name: null,
      keyMasked: null,
      status: null,
      statusLabel: '未知',
      group: null,
      remainQuota: null,
      usedQuota: null,
      unlimitedQuota: null,
      expiredTime: null,
      createdTime: null,
      accessedTime: null,
      modelLimits: null,
      allowIps: null,
    }
  }
  return {
    id: number(token.id),
    name: typeof token.name === 'string' ? token.name : null,
    keyMasked: maskKey(token.key),
    status: number(token.status),
    statusLabel: statusLabel(token.status),
    group: typeof token.group === 'string' ? token.group : null,
    remainQuota: number(token.remain_quota),
    usedQuota: number(token.used_quota),
    unlimitedQuota: typeof token.unlimited_quota === 'boolean' ? token.unlimited_quota : null,
    expiredTime: number(token.expired_time),
    createdTime: number(token.created_time),
    accessedTime: number(token.accessed_time),
    modelLimits: typeof token.model_limits === 'string' ? token.model_limits : null,
    allowIps: typeof token.allow_ips === 'string' ? token.allow_ips : null,
  }
}

async function runList(deps, args) {
  const value = base('list')
  const { admin } = await deps.context()
  const page = typeof args.page === 'number' && args.page > 0 ? Math.floor(args.page) : 1
  const pageSize =
    typeof args.pageSize === 'number' && args.pageSize > 0 ? Math.min(100, Math.floor(args.pageSize)) : 20
  const result = await admin.tokens({
    page,
    pageSize,
    keyword: args.keyword,
    signal: args.signal,
    timeoutMs: args.timeoutMs,
  })
  const tokens = listFrom(result.data).map(tokenView)
  value.count = tokens.length
  value.total = totalFrom(result.data, tokens.length)
  value.page = page
  value.pageSize = pageSize
  value.tokens = tokens
  value.nextStep =
    tokens.length === 0 ? '没有令牌：可以用 action="create" 创建一个，再交给应用使用。' : null
  value.durationMs = result.durationMs
  return value
}

async function runCreate(deps, args) {
  if (typeof args.name !== 'string' || args.name.trim().length === 0) {
    throw new NewApiError('INVALID_ARGS', 'action=create 需要 name', {
      hint: '例如 {"action":"create","name":"my-app"}。',
    })
  }
  const value = base('create')
  const { settings, admin } = await deps.context()

  const body = { name: args.name }
  if (args.remainQuota !== undefined) body.remain_quota = args.remainQuota
  if (args.unlimitedQuota !== undefined) body.unlimited_quota = args.unlimitedQuota
  if (args.expiredTime !== undefined) body.expired_time = args.expiredTime
  if (typeof args.group === 'string' && args.group.trim().length > 0) body.group = args.group.trim()
  if (Array.isArray(args.modelLimits) && args.modelLimits.length > 0) {
    body.model_limits = args.modelLimits.join(',')
    body.model_limits_enabled = true
  }
  if (Array.isArray(args.allowIps) && args.allowIps.length > 0) body.allow_ips = args.allowIps.join(',')

  const result = await admin.tokenCreate(body, { signal: args.signal, timeoutMs: args.timeoutMs })
  if (result.success === false) {
    throw new NewApiError('API_ERROR', result.message.length > 0 ? result.message : '创建令牌失败', {
      hint: '请核对字段名与站点版本；可先用 action="list" 观察现有令牌结构。',
    })
  }
  const data = result.data
  const rawKey =
    typeof data === 'string'
      ? data
      : data !== null && typeof data === 'object'
        ? (data.key ?? data.token ?? null)
        : null
  const id =
    data !== null && typeof data === 'object' && typeof data.id === 'number' && Number.isFinite(data.id)
      ? data.id
      : null
  const fullKey =
    typeof rawKey === 'string' && rawKey.length > 0 && !rawKey.includes('*')
      ? rawKey.startsWith('sk-')
        ? rawKey
        : `sk-${rawKey}`
      : null
  const keyMasked =
    typeof rawKey === 'string' && rawKey.length > 0
      ? rawKey.includes('*')
        ? rawKey
        : maskKey(fullKey)
      : null

  let delivery = 'none'
  let keyFile = null
  let hint = null
  if (fullKey !== null) {
    if ((args.delivery ?? 'file') === 'inline') {
      delivery = 'inline'
      hint = '完整密钥已经进入本次工具结果与会话记录；交付后建议删除/轮换该令牌，或下次改用 delivery="file"。'
    } else {
      try {
        keyFile = await writeIssuedToken({
          dir: settings.issuedDir,
          id,
          name: args.name,
          baseUrl: settings.baseUrl,
          key: fullKey,
        })
        delivery = 'file'
        hint = '请让用户打开该文件复制密钥，并在交付后删除文件；不要把文件内容贴回对话。'
      } catch (error) {
        // The token already exists upstream; losing the only plaintext key
        // would be worse than putting it in the result, so fall back to
        // inline delivery and say why.
        delivery = 'inline'
        hint = `写入密钥文件失败（${error instanceof Error ? error.message : String(error)}），已回退为 inline 交付；该密钥会进入会话记录，请尽快轮换。`
      }
    }
  } else {
    hint = '网关没有在创建响应中返回明文 key；可能该版本不支持一次性返回。请到 Web 控制台手动查看，或检查接口字段。'
  }

  value.created = true
  value.id = id
  value.name = args.name
  value.keyMasked = keyMasked
  value.key = delivery === 'inline' ? fullKey : null
  value.delivery = delivery
  value.keyFile = keyFile
  value.message = result.message.length > 0 ? result.message : null
  value.hint = hint
  value.durationMs = result.durationMs
  return value
}

async function runDelete(deps, args) {
  if (typeof args.id !== 'number' || !Number.isInteger(args.id)) {
    throw new NewApiError('INVALID_ARGS', 'action=delete 需要整数 id', {
      hint: '先用 action="list" 查出 id，再删除。',
    })
  }
  if (args.confirm !== true) {
    throw new NewApiError('CONFIRM_REQUIRED', '删除令牌需要显式确认', {
      hint: '请先向用户确认 id 与名称，然后传 confirm=true 重试。',
    })
  }
  const value = base('delete')
  const { admin } = await deps.context()
  const result = await admin.tokenDelete(args.id, { signal: args.signal, timeoutMs: args.timeoutMs })
  assertSuccess(result, '删除令牌')
  value.deleted = true
  value.id = args.id
  value.message = result.message.length > 0 ? result.message : null
  value.durationMs = result.durationMs
  return value
}

function renderList(value) {
  if (value.count === 0) {
    return `没有找到令牌（第 ${value.page} 页）。令牌属于当前访问令牌对应用户，root 也只能看到自己的令牌。`
  }
  const lines = [`令牌 ${value.count} 个（总数 ${value.total}，第 ${value.page} 页）：`]
  for (const token of value.tokens) {
    lines.push(
      `  - id=${token.id ?? '?'} name=${token.name ?? '(未命名)'} key=${token.keyMasked ?? '(未返回)'} status=${token.statusLabel} ` +
        `quota=${token.unlimitedQuota === true ? '无限' : (token.remainQuota ?? '?')} group=${token.group ?? '(默认)'}` +
        `${token.modelLimits ? ` models=${token.modelLimits}` : ''}`,
    )
  }
  if (value.nextStep !== null) lines.push('', value.nextStep)
  return lines.join('\n')
}

function renderCreate(value) {
  const lines = [`令牌创建结果：${value.created ? '成功' : '未确认'}  id=${value.id ?? '?'}  name=${value.name}`]
  if (value.keyMasked !== null) lines.push(`  掩码: ${value.keyMasked}`)
  if (value.delivery === 'file' && value.keyFile !== null) {
    lines.push(`  完整密钥已写入: ${value.keyFile}`, '  请由用户把该文件内容交给应用，然后删除文件；文件权限已尽量收紧为 0600。')
  } else if (value.delivery === 'inline' && value.key !== null) {
    lines.push(`  完整密钥（会进入会话记录，用完请轮换）: ${value.key}`)
  } else if (value.message !== null) {
    lines.push(`  网关消息: ${truncateText(value.message, 1_000)}`)
  }
  if (value.hint !== null) lines.push('', value.hint)
  return lines.join('\n')
}

function render(value) {
  const text =
    value.action === 'create'
      ? renderCreate(value)
      : value.action === 'delete'
        ? `已删除令牌 id=${value.id}${value.message !== null ? `：${value.message}` : '。'}使用该令牌的应用会立即失败，请确认已经切换到新令牌。`
        : renderList(value)
  return [{ type: 'text', text }]
}

/** Register the tokens tool. */
export function registerTokensTool(ctx, deps, options) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_tokens',
      description:
        '管理当前用户的令牌：action=list 列出/搜索（key 始终掩码）；create 创建，明文密钥默认一次性写入 0600 文件；delete 永久删除，需 confirm=true。' +
        '令牌额度与账户额度是两套额度。',
      parameters: S.object(
        {
          action: S.string({ description: 'list（默认）/ create / delete。', enum: ['list', 'create', 'delete'] }),
          page: S.integer({ description: '仅 list：页码，默认 1。' }),
          pageSize: S.integer({ description: '仅 list：每页条数，默认 20，最多 100。' }),
          keyword: S.string({ description: '仅 list：按名称搜索；非空时走 /api/token/search。' }),
          name: S.string({ description: '仅 create：令牌名称。' }),
          remainQuota: S.integer({ description: '仅 create：剩余额度（quota 单位）；不传由网关默认。' }),
          unlimitedQuota: S.boolean({ description: '仅 create：是否无限额度。' }),
          expiredTime: S.integer({ description: '仅 create：过期时间（Unix 秒）；-1 通常为永不过期。' }),
          group: S.string({ description: '仅 create：令牌分组，留空用用户默认分组。' }),
          modelLimits: S.array(S.string(), { description: '仅 create：模型白名单，写入 model_limits 并启用限制。' }),
          allowIps: S.array(S.string(), { description: '仅 create：IP 白名单。' }),
          delivery: S.string({
            description: '仅 create：file（默认，写 0600 文件）或 inline（进入会话记录）。',
            enum: ['file', 'inline'],
          }),
          id: S.integer({ description: '仅 delete：令牌 ID，先用 action="list" 查。' }),
          confirm: S.boolean({ description: '仅 delete：必须为 true。' }),
          timeoutMs: S.integer({ description: '请求超时（毫秒），默认 120000。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const action = args.action ?? 'list'
        try {
          const value =
            action === 'create'
              ? await runCreate(deps, { ...args, signal: exec.signal })
              : action === 'delete'
                ? await runDelete(deps, { ...args, signal: exec.signal })
                : await runList(deps, { ...args, signal: exec.signal })
          deps.record('newapi_tokens', {
            api: 'admin',
            method: action === 'create' ? 'POST' : action === 'delete' ? 'DELETE' : 'GET',
            path: action === 'list' ? '/api/token/' : '/api/token/',
            ok: true,
            status: null,
            durationMs: value.durationMs,
          })
          return value
        } catch (error) {
          deps.record('newapi_tokens', {
            api: 'admin',
            method: action === 'create' ? 'POST' : action === 'delete' ? 'DELETE' : 'GET',
            path: '/api/token/',
            ok: false,
            errorCode: typeof error?.code === 'string' ? error.code : 'ERROR',
          })
          throw error
        }
      },
    }),
    options,
  )
}
