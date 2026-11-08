/** `newapi_channels`: channel inventory and connectivity test. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { NewApiError } from '../errors.js'
import { listFrom, totalFrom } from '../admin.js'
import { redactValue } from '../redact.js'
import { errorInfo, maskKey, renderJson } from './common.js'
import {
  ERROR_SCHEMA,
  NULLABLE_BOOLEAN,
  NULLABLE_INTEGER,
  NULLABLE_NUMBER,
  NULLABLE_STRING,
} from './schemas.js'

const CHANNEL_SCHEMA = S.object(
  {
    id: NULLABLE_INTEGER,
    name: NULLABLE_STRING,
    type: NULLABLE_INTEGER,
    status: NULLABLE_INTEGER,
    statusLabel: S.string({ required: true }),
    group: NULLABLE_STRING,
    models: S.array(S.string(), { required: true }),
    priority: NULLABLE_NUMBER,
    weight: NULLABLE_NUMBER,
    baseUrl: NULLABLE_STRING,
    balance: NULLABLE_NUMBER,
    usedQuota: NULLABLE_NUMBER,
    responseTime: NULLABLE_NUMBER,
    testTime: NULLABLE_NUMBER,
    tag: NULLABLE_STRING,
    autoBan: NULLABLE_BOOLEAN,
    keyMasked: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    action: S.string({ required: true, enum: ['list', 'test'] }),
    count: NULLABLE_INTEGER,
    total: NULLABLE_INTEGER,
    page: NULLABLE_INTEGER,
    pageSize: NULLABLE_INTEGER,
    channels: S.oneOf([S.array(CHANNEL_SCHEMA), S.null()]),
    ok: NULLABLE_BOOLEAN,
    id: NULLABLE_INTEGER,
    status: NULLABLE_INTEGER,
    message: NULLABLE_STRING,
    data: S.any(),
    nextStep: NULLABLE_STRING,
    durationMs: S.integer({ required: true }),
    error: S.oneOf([ERROR_SCHEMA, S.null()]),
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
    channels: null,
    ok: null,
    id: null,
    status: null,
    message: null,
    data: null,
    nextStep: null,
    durationMs: 0,
    error: null,
  }
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function modelsOf(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return []
}

/** Channel status values are not the same as token status values. */
function channelStatusLabel(status) {
  if (status === 1) return '启用'
  if (status === 2) return '禁用'
  if (status === 3) return '自动禁用'
  if (typeof status === 'number') return `状态 ${status}`
  return '未知'
}

function safeBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    if (url.username.length > 0 || url.password.length > 0) {
      return `${url.protocol}//${url.host}`
    }
    return value
  } catch {
    return value
  }
}

function channelView(channel) {
  if (channel === null || typeof channel !== 'object') {
    return {
      id: null,
      name: null,
      type: null,
      status: null,
      statusLabel: '未知',
      group: null,
      models: [],
      priority: null,
      weight: null,
      baseUrl: null,
      balance: null,
      usedQuota: null,
      responseTime: null,
      testTime: null,
      tag: null,
      autoBan: null,
      keyMasked: null,
    }
  }
  return {
    id: number(channel.id),
    name: typeof channel.name === 'string' ? channel.name : null,
    type: number(channel.type),
    status: number(channel.status),
    statusLabel: channelStatusLabel(channel.status),
    group: typeof channel.group === 'string' ? channel.group : null,
    models: modelsOf(channel.models),
    priority: number(channel.priority),
    weight: number(channel.weight),
    baseUrl: safeBaseUrl(channel.base_url),
    balance: number(channel.balance),
    usedQuota: number(channel.used_quota),
    responseTime: number(channel.response_time),
    testTime: number(channel.test_time),
    tag: typeof channel.tag === 'string' ? channel.tag : null,
    autoBan: typeof channel.auto_ban === 'boolean' ? channel.auto_ban : null,
    keyMasked: maskKey(channel.key),
  }
}

async function runList(deps, args) {
  const value = base('list')
  const { admin } = await deps.context()
  const page = typeof args.page === 'number' && args.page > 0 ? Math.floor(args.page) : 1
  const pageSize =
    typeof args.pageSize === 'number' && args.pageSize > 0 ? Math.min(100, Math.floor(args.pageSize)) : 20
  const result = await admin.channels({
    page,
    pageSize,
    keyword: args.keyword,
    status: args.status,
    type: args.type,
    signal: args.signal,
    timeoutMs: args.timeoutMs,
  })
  const channels = listFrom(result.data).map(channelView)
  value.count = channels.length
  value.total = totalFrom(result.data, channels.length)
  value.page = page
  value.pageSize = pageSize
  value.channels = channels
  value.nextStep = channels.length === 0 ? '没有渠道：请确认访问令牌属于管理员账号，或先新增渠道。' : null
  value.durationMs = result.durationMs
  return value
}

async function runTest(deps, args) {
  const started = Date.now()
  const value = base('test')
  if (typeof args.id !== 'number' || !Number.isInteger(args.id)) {
    throw new NewApiError('INVALID_ARGS', 'action=test 需要整数 id', {
      hint: '先用 action="list" 查渠道 id。',
    })
  }
  value.id = args.id
  const { admin } = await deps.context()
  try {
    const result = await admin.channelTest(args.id, { signal: args.signal, timeoutMs: args.timeoutMs })
    value.ok = result.ok
    value.status = result.status
    value.message = result.message.length > 0 ? result.message : null
    value.data = redactValue(result.data)
    value.durationMs = result.durationMs
    return value
  } catch (error) {
    const info = errorInfo(error)
    value.ok = false
    value.status = info.status
    value.durationMs = Date.now() - started
    value.error = info
    return value
  }
}

function renderList(value) {
  if (value.count === 0) {
    return (
      `没有找到渠道（第 ${value.page} 页）。渠道列表需要 Admin 权限的访问令牌；若刚配置完还没有渠道，请先到控制台或 newapi_raw 新增渠道。`
    )
  }
  const lines = [`渠道 ${value.count} 个（总数 ${value.total}，第 ${value.page} 页）：`]
  for (const channel of value.channels) {
    lines.push(
      `  - id=${channel.id ?? '?'} name=${channel.name ?? '(未命名)'} type=${channel.type ?? '?'} status=${channel.statusLabel} ` +
        `group=${channel.group ?? '(默认)'} models=${channel.models.length} priority=${channel.priority ?? '?'} weight=${channel.weight ?? '?'}`,
    )
  }
  if (value.nextStep !== null) lines.push('', value.nextStep)
  return lines.join('\n')
}

function render(value) {
  if (value.action === 'test') {
    const lines = [
      `渠道测试：id=${value.id}  ${value.ok ? '成功' : '失败'}  HTTP=${value.status ?? '无'}  耗时=${value.durationMs} ms`,
    ]
    if (value.message !== null) lines.push(`消息：${value.message}`)
    if (value.data !== null && value.data !== undefined) lines.push('返回：', renderJson(value.data, 3_000))
    if (value.error !== null) {
      lines.push(`错误：[${value.error.code}] ${value.error.message}${value.error.hint ? `；${value.error.hint}` : ''}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return [{ type: 'text', text: renderList(value) }]
}

/** Register the channels tool. */
export function registerChannelsTool(ctx, deps, options) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_channels',
      description:
        '管理渠道（需要 Admin）：action=list 列出/搜索，返回 id/状态/分组/模型/优先级，渠道 key 始终掩码；test 测一条渠道连通性，会真实请求上游并可能计费。' +
        '排查“无可用渠道”时，用它核对渠道分组与模型是否覆盖当前用户分组。',
      parameters: S.object(
        {
          action: S.string({ description: 'list（默认）/ test。', enum: ['list', 'test'] }),
          page: S.integer({ description: '仅 list：页码，默认 1。' }),
          pageSize: S.integer({ description: '仅 list：每页条数，默认 20，最多 100。' }),
          keyword: S.string({ description: '仅 list：按关键词搜索；非空时走 /api/channel/search。' }),
          status: S.integer({ description: '仅 list：按状态过滤（整数编码，以实例为准）。' }),
          type: S.integer({ description: '仅 list：按渠道类型过滤（整数编码，以实例为准）。' }),
          id: S.integer({ description: '仅 test：渠道 ID。' }),
          timeoutMs: S.integer({ description: '超时（毫秒）；list 默认 120000，test 默认 60000。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const action = args.action ?? 'list'
        const params = { ...args, signal: exec.signal }
        try {
          const value = action === 'test' ? await runTest(deps, params) : await runList(deps, params)
          deps.record('newapi_channels', {
            api: 'admin',
            method: 'GET',
            path:
              action === 'test'
                ? `/api/channel/test/${args.id}`
                : String(args.keyword ?? '').trim().length > 0
                  ? '/api/channel/search'
                  : '/api/channel/',
            status: value.status,
            ok: action === 'test' ? value.ok === true : true,
            durationMs: value.durationMs,
          })
          return value
        } catch (error) {
          deps.record('newapi_channels', {
            api: 'admin',
            method: 'GET',
            path: action === 'test' ? `/api/channel/test/${args.id}` : '/api/channel/',
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
