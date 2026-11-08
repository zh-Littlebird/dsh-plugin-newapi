/** `newapi_raw`: escape hatch for endpoints not covered by typed tools. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { NewApiError } from '../errors.js'
import { normalizePath } from '../http.js'
import { redactValue } from '../redact.js'
import { errorInfo, renderJson, truncateText } from './common.js'
import { ERROR_SCHEMA, NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const OUTPUT_SCHEMA = S.object(
  {
    ok: S.boolean({ required: true }),
    status: NULLABLE_INTEGER,
    api: S.string({ required: true }),
    method: S.string({ required: true }),
    path: S.string({ required: true }),
    data: S.any(),
    text: NULLABLE_STRING,
    message: NULLABLE_STRING,
    truncated: S.boolean({ required: true }),
    durationMs: S.integer({ required: true }),
    requestId: NULLABLE_STRING,
    error: S.oneOf([ERROR_SCHEMA, S.null()]),
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = [`${value.method} ${value.path} -> HTTP ${value.status ?? '无'}  ${value.ok ? '成功' : '失败'}`]
  if (value.message !== null) lines.push(`消息：${value.message}`)
  if (value.data !== null && value.data !== undefined) {
    lines.push('数据：', renderJson(value.data, 12_000))
  }
  if (value.text !== null) {
    lines.push('响应文本：', truncateText(value.text, 12_000))
  }
  if (value.truncated) lines.push('注意：响应超过 maxBytes，内容已截断，不能当成完整响应。')
  if (value.error !== null) {
    lines.push(`错误：[${value.error.code}] ${value.error.message}${value.error.hint ? `；${value.error.hint}` : ''}`)
  }
  lines.push(`耗时：${value.durationMs} ms`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the raw-call tool. */
export function registerRawTool(ctx, deps, options) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_raw',
      description:
        '任意端点兜底：typed 工具没覆盖的接口（渠道增改、令牌更新、系统设置修改等）用它。auto 按路径选认证：/api/* 管理，/v1、/v1beta、/kling、/jimeng、/pg 用 AI 密钥。' +
        '管理写操作必须 confirm=true；只发 JSON，不支持 multipart；HTTP 失败以 ok=false 返回，密钥字段脱敏。',
      parameters: S.object(
        {
          api: S.string({
            description: 'auto（默认）/ ai / management / public。auto 会按 path 判断。',
            enum: ['auto', 'ai', 'management', 'public'],
          }),
          method: S.string({
            description: 'HTTP 方法，默认 GET。',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          }),
          path: S.string({ required: true, description: '网关内绝对路径，如 /api/channel/ 或 /v1/rerank。' }),
          query: S.any({ description: '查询参数对象，如 {"p":1,"page_size":20}。' }),
          body: S.any({ description: 'JSON 请求体（对象或数组）；GET 通常不需要。' }),
          confirm: S.boolean({ description: '管理/公开写操作必须为 true；AI POST 不需要。' }),
          authStyle: S.string({
            description: 'AI 认证方式：bearer（默认）、anthropic（x-api-key）、gemini（x-goog-api-key）。',
            enum: ['bearer', 'anthropic', 'gemini'],
          }),
          maxBytes: S.integer({ description: '本次响应读取上限（字节），不能超过插件配置 maxResponseBytes。' }),
          timeoutMs: S.integer({ description: '请求超时（毫秒），默认 120000。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const { settings, transport } = await deps.context()
        const apiMap = { auto: 'auto', ai: 'ai', management: 'admin', public: 'public' }
        const normalized = normalizePath(apiMap[args.api ?? 'auto'] ?? 'auto', args.path)
        const method = String(args.method ?? 'GET').toUpperCase()
        const writing = method !== 'GET'

        if (writing && normalized.api === 'admin' && settings.config.allowManagementWrites !== true) {
          throw new NewApiError('WRITES_DISABLED', '插件配置已禁止管理接口写操作', {
            hint: '请让用户把 allowManagementWrites 改为 true，或改用只读查询。',
          })
        }
        if (writing && normalized.api !== 'ai' && args.confirm !== true) {
          throw new NewApiError('CONFIRM_REQUIRED', `${method} ${normalized.path} 需要人工确认`, {
            hint: '先向用户说明目标与影响，确认后传 confirm=true 重试。AI POST（推理）不需要 confirm。',
          })
        }
        if (args.body !== undefined && args.body !== null && typeof args.body !== 'object') {
          throw new NewApiError('INVALID_ARGS', 'body 必须是 JSON 对象或数组', {
            hint: '例如 {"name":"demo"}；multipart 文件上传不在本工具范围内。',
          })
        }

        const maxBytes =
          typeof args.maxBytes === 'number' && args.maxBytes > 0
            ? Math.min(settings.config.maxResponseBytes, Math.max(1_024, Math.floor(args.maxBytes)))
            : undefined
        const started = Date.now()
        try {
          const response = await transport.request({
            api: normalized.api,
            authStyle: args.authStyle ?? 'bearer',
            method,
            path: normalized.path,
            query: args.query,
            body: args.body,
            allowApiFailure: true,
            allowText: true,
            allowTruncated: true,
            includeText: true,
            maxBytes,
            signal: exec.signal,
            timeoutMs: args.timeoutMs,
          })
          const json = response.json
          const wrapped =
            json !== null && typeof json === 'object' && !Array.isArray(json) && Object.hasOwn(json, 'success')
          const ok =
            !response.truncated &&
            (wrapped ? json.success !== false : response.status >= 200 && response.status < 300)
          const value = {
            ok,
            status: response.status,
            api: normalized.api,
            method,
            path: normalized.path,
            data: redactValue(wrapped ? json.data ?? null : json),
            text: json === null ? truncateText(response.text ?? '', 20_000) : null,
            message:
              wrapped && typeof json.message === 'string' && json.message.length > 0
                ? json.message
                : null,
            truncated: response.truncated,
            durationMs: response.durationMs,
            requestId: response.requestId,
            error: null,
          }
          deps.record('newapi_raw', {
            api: normalized.api,
            method,
            path: normalized.path,
            status: response.status,
            ok,
            durationMs: response.durationMs,
          })
          return value
        } catch (error) {
          const info = errorInfo(error)
          const value = {
            ok: false,
            status: info.status,
            api: normalized.api,
            method,
            path: normalized.path,
            data: null,
            text: null,
            message: info.message,
            truncated: false,
            durationMs: Date.now() - started,
            requestId: null,
            error: info,
          }
          deps.record('newapi_raw', {
            api: normalized.api,
            method,
            path: normalized.path,
            status: info.status,
            ok: false,
            errorCode: info.code,
            durationMs: value.durationMs,
          })
          return value
        }
      },
    }),
    options,
  )
}
