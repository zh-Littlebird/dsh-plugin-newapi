/** `newapi_options`: read system settings (Root) with targeted key filtering. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { redactValue } from '../redact.js'
import { truncateText } from './common.js'

const OPTION_SCHEMA = S.object(
  {
    key: S.string({ required: true }),
    value: S.string({ required: true }),
    truncated: S.boolean({ required: true }),
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    count: S.integer({ required: true }),
    total: S.integer({ required: true }),
    truncated: S.boolean({ required: true }),
    options: S.array(OPTION_SCHEMA, { required: true }),
    durationMs: S.integer({ required: true }),
    nextStep: S.oneOf([S.string(), S.null()]),
  },
  { additionalProperties: false },
)

function stringify(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function render(value) {
  if (value.count === 0) {
    return [
      {
        type: 'text',
        text:
          `没有匹配的系统设置（共 ${value.total} 项）。/api/option/ 需要 Root 权限；普通 Admin 访问会被拒绝。` +
          '可用 keys 精确筛选，如 ["GroupRatio","ModelRatio","billing_setting.billing_mode"]。',
      },
    ]
  }
  const lines = [`系统设置 ${value.count}/${value.total} 项（值可能已截断）：`]
  for (const option of value.options) {
    lines.push(`  ${option.key} = ${option.value}${option.truncated ? ' …' : ''}`)
  }
  if (value.nextStep !== null) lines.push('', value.nextStep)
  return [{ type: 'text', text: truncateText(lines.join('\n'), 30_000) }]
}

/** Register `newapi_options`. */
export function registerOptionsTool(ctx, deps, options) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_options',
      description:
        '读取系统设置（需要 Root），value 统一为字符串。用 keys 精确筛选，避免整份设置进入上下文。本工具只读，不修改设置。',
      parameters: S.object(
        {
          keys: S.array(S.string(), { description: '要读取的设置键名列表；省略则返回全部。' }),
          maxValueLength: S.integer({ description: '单个 value 的最大字符数，默认 4000。' }),
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
        const limit =
          typeof args.maxValueLength === 'number' && args.maxValueLength > 0
            ? Math.min(20_000, Math.max(100, Math.floor(args.maxValueLength)))
            : 4_000
        try {
          const result = await admin.options({ signal: exec.signal, timeoutMs: args.timeoutMs })
          const raw =
            Array.isArray(result.data)
              ? result.data
              : result.data !== null && typeof result.data === 'object' && Array.isArray(result.data.options)
                ? result.data.options
                : []
          const wanted = Array.isArray(args.keys) ? new Set(args.keys) : null
          const options = []
          let truncated = false
          for (const entry of raw) {
            if (entry === null || typeof entry !== 'object') continue
            const key = typeof entry.key === 'string' ? entry.key : String(entry.key ?? '')
            if (wanted !== null && !wanted.has(key)) continue
            const full = stringify(entry.value)
            const short = full.length > limit
            const safe = redactValue(short ? `${full.slice(0, limit)}\n… [truncated ${full.length - limit} chars]` : full)
            options.push({
              key,
              value: typeof safe === 'string' ? safe : String(safe),
              truncated: short,
            })
            if (short) truncated = true
          }
          deps.record('newapi_options', {
            api: 'admin',
            method: 'GET',
            path: '/api/option/',
            ok: true,
            durationMs: result.durationMs,
          })
          return {
            count: options.length,
            total: raw.length,
            truncated,
            options,
            durationMs: result.durationMs,
            nextStep:
              options.length === 0 && wanted !== null
                ? `没有找到这些键：${[...wanted].join('、')}。键名区分大小写，请先不带 keys 查看可用的键。`
                : null,
          }
        } catch (error) {
          deps.record('newapi_options', {
            api: 'admin',
            method: 'GET',
            path: '/api/option/',
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
