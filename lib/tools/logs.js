/** `newapi_logs`: usage log query plus optional quota/RPM/TPM statistics. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { NewApiError } from '../errors.js'
import { listFrom, totalFrom } from '../admin.js'
import { redactValue } from '../redact.js'
import { errorInfo, formatTime, truncateText } from './common.js'
import {
  ERROR_SCHEMA,
  NULLABLE_INTEGER,
  NULLABLE_NUMBER,
  NULLABLE_STRING,
} from './schemas.js'

function timestamp(value, label) {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (/^\d+$/.test(text)) {
    const number = Number(text)
    if (!Number.isSafeInteger(number)) {
      throw new NewApiError('INVALID_ARGS', `${label} 时间戳过大`, { hint: '请用 Unix 秒或 ISO 8601 时间。' })
    }
    return number > 1e12 ? Math.floor(number / 1000) : number
  }
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new NewApiError('INVALID_ARGS', `${label} 不是合法时间：${value}`, {
      hint: '示例：2026-11-01T00:00:00+08:00 或 Unix 秒 1761926400。',
    })
  }
  return Math.floor(parsed / 1000)
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function logView(log, includeContent) {
  if (log === null || typeof log !== 'object') {
    return {
      id: null,
      createdAt: null,
      time: null,
      type: null,
      username: null,
      tokenName: null,
      modelName: null,
      quota: null,
      promptTokens: null,
      completionTokens: null,
      channel: null,
      group: null,
      requestId: null,
      content: null,
    }
  }
  const createdAt = number(log.created_at)
  return {
    id: typeof log.id === 'string' ? log.id : typeof log.id === 'number' ? String(log.id) : null,
    createdAt,
    time: formatTime(createdAt),
    type: number(log.type),
    username: typeof log.username === 'string' ? log.username : null,
    tokenName: typeof log.token_name === 'string' ? log.token_name : null,
    modelName: typeof log.model_name === 'string' ? log.model_name : null,
    quota: number(log.quota),
    promptTokens: number(log.prompt_tokens),
    completionTokens: number(log.completion_tokens),
    channel: number(log.channel),
    group: typeof log.group === 'string' ? log.group : null,
    requestId: typeof log.request_id === 'string' ? log.request_id : null,
    content:
      includeContent && typeof log.content === 'string'
        ? truncateText(log.content, 2_000)
        : null,
  }
}

const LOG_SCHEMA = S.object(
  {
    id: NULLABLE_STRING,
    createdAt: NULLABLE_INTEGER,
    time: NULLABLE_STRING,
    type: NULLABLE_INTEGER,
    username: NULLABLE_STRING,
    tokenName: NULLABLE_STRING,
    modelName: NULLABLE_STRING,
    quota: NULLABLE_NUMBER,
    promptTokens: NULLABLE_INTEGER,
    completionTokens: NULLABLE_INTEGER,
    channel: NULLABLE_INTEGER,
    group: NULLABLE_STRING,
    requestId: NULLABLE_STRING,
    content: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

const STAT_SCHEMA = S.object(
  {
    quota: NULLABLE_NUMBER,
    rpm: NULLABLE_NUMBER,
    tpm: NULLABLE_NUMBER,
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    count: S.integer({ required: true }),
    total: S.integer({ required: true }),
    page: S.integer({ required: true }),
    pageSize: S.integer({ required: true }),
    items: S.array(LOG_SCHEMA, { required: true }),
    stat: S.oneOf([STAT_SCHEMA, S.null()]),
    statError: S.oneOf([ERROR_SCHEMA, S.null()]),
    durationMs: S.integer({ required: true }),
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = [`日志 ${value.count} 条（总数 ${value.total}，第 ${value.page} 页，每页 ${value.pageSize}）`]
  if (value.stat !== null) {
    lines.push(`统计：quota=${value.stat.quota ?? '?'} rpm=${value.stat.rpm ?? '?'} tpm=${value.stat.tpm ?? '?'}`)
  }
  if (value.statError !== null) {
    lines.push(`统计不可用：[${value.statError.code}] ${value.statError.message}`)
  }
  if (value.count === 0) {
    lines.push('没有匹配的日志。请放宽时间范围或筛选条件；日志时间跨度受站点 log_max_range_days 限制。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  lines.push('')
  for (const item of value.items) {
    lines.push(
      `${item.time ?? item.createdAt ?? '?'}  type=${item.type ?? '?'} user=${item.username ?? '?'} token=${item.tokenName ?? '?'} ` +
        `model=${item.modelName ?? '?'} prompt=${item.promptTokens ?? '?'} completion=${item.completionTokens ?? '?'} ` +
        `quota=${item.quota ?? '?'} channel=${item.channel ?? '?'} group=${item.group ?? '?'}`,
    )
    if (item.content !== null) lines.push(`    ${item.content.replace(/\n/g, '\n    ')}`)
  }
  if (value.total > value.pageSize) {
    lines.push('', `提示：还有更多结果，可增大 page 或 pageSize（最多 100）继续查询。`)
  }
  return [{ type: 'text', text: truncateText(lines.join('\n'), 30_000) }]
}

/** Register `newapi_logs`. */
export function registerLogsTool(ctx, deps, options) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_logs',
      description:
        '查询使用日志（需要 Admin），默认同时取 quota/RPM/TPM 统计。时间用 ISO 8601 或 Unix 秒，跨度受站点 log_max_range_days 限制。' +
        '默认不返回 content（可能含请求内容）；排查失败时先按 channel/modelName 过滤再缩小时间窗。',
      parameters: S.object(
        {
          page: S.integer({ description: '页码，默认 1。' }),
          pageSize: S.integer({ description: '每页条数，默认 20，最多 100。' }),
          type: S.integer({ description: '日志类型（充值/消费/管理/系统等，取值以实例为准）。' }),
          startTime: S.string({ description: '起始时间：ISO 8601 或 Unix 秒。' }),
          endTime: S.string({ description: '结束时间：ISO 8601 或 Unix 秒。' }),
          modelName: S.string({ description: '按模型名筛选。' }),
          tokenName: S.string({ description: '按令牌名筛选。' }),
          group: S.string({ description: '按分组筛选。' }),
          username: S.string({ description: '按用户名筛选（仅管理员）。' }),
          channel: S.integer({ description: '按渠道 ID 筛选（仅管理员）。' }),
          requestId: S.string({ description: '按请求 ID 精确筛选。' }),
          includeStat: S.boolean({ description: '是否同时查询 /api/log/stat，默认 true。' }),
          includeContent: S.boolean({ description: '是否返回日志 content（截断 2000 字），默认 false。' }),
          timeoutMs: S.integer({ description: '请求超时（毫秒），默认 120000。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const { admin } = await deps.context()
        const page = typeof args.page === 'number' && args.page > 0 ? Math.floor(args.page) : 1
        const pageSize = typeof args.pageSize === 'number' && args.pageSize > 0 ? Math.min(100, Math.floor(args.pageSize)) : 20
        const startTimestamp = timestamp(args.startTime, 'startTime')
        const endTimestamp = timestamp(args.endTime, 'endTime')
        const filters = {
          ...(args.type === undefined ? {} : { type: args.type }),
          ...(startTimestamp === undefined ? {} : { start_timestamp: startTimestamp }),
          ...(endTimestamp === undefined ? {} : { end_timestamp: endTimestamp }),
          ...(args.modelName === undefined ? {} : { model_name: args.modelName }),
          ...(args.tokenName === undefined ? {} : { token_name: args.tokenName }),
          ...(args.group === undefined ? {} : { group: args.group }),
          ...(args.username === undefined ? {} : { username: args.username }),
          ...(args.channel === undefined ? {} : { channel: args.channel }),
          ...(args.requestId === undefined ? {} : { request_id: args.requestId }),
        }
        try {
          const result = await admin.logs({ p: page, page_size: pageSize, ...filters }, {
            signal: exec.signal,
            timeoutMs: args.timeoutMs,
          })
          const items = listFrom(result.data).map((log) => logView(log, args.includeContent === true))
          let stat = null
          let statError = null
          if (args.includeStat !== false) {
            try {
              const statResult = await admin.logStat(filters, {
                signal: exec.signal,
                timeoutMs: args.timeoutMs,
              })
              const data = statResult.data !== null && typeof statResult.data === 'object' ? statResult.data : {}
              stat = {
                quota: number(data.quota),
                rpm: number(data.rpm),
                tpm: number(data.tpm),
              }
            } catch (error) {
              statError = errorInfo(error)
            }
          }
          deps.record('newapi_logs', {
            api: 'admin',
            method: 'GET',
            path: '/api/log/',
            ok: true,
            durationMs: result.durationMs,
          })
          return redactValue({
            count: items.length,
            total: totalFrom(result.data, items.length),
            page,
            pageSize,
            items,
            stat,
            statError,
            durationMs: result.durationMs,
          })
        } catch (error) {
          deps.record('newapi_logs', {
            api: 'admin',
            method: 'GET',
            path: '/api/log/',
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
