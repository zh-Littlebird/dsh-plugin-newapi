/** `newapi_models`: list the models the gateway currently exposes. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { NULLABLE_INTEGER, NULLABLE_STRING } from './schemas.js'

const MODEL_SCHEMA = S.object(
  {
    id: S.string({ required: true }),
    displayName: NULLABLE_STRING,
    ownedBy: NULLABLE_STRING,
    createdAt: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    format: S.string({ required: true, enum: ['openai', 'anthropic', 'gemini'] }),
    count: S.integer({ required: true }),
    models: S.array(MODEL_SCHEMA, { required: true }),
    durationMs: S.integer({ required: true }),
    nextStep: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function render(value) {
  if (value.count === 0) {
    return [
      {
        type: 'text',
        text:
          `网关没有返回任何模型（格式 ${value.format}）。\n` +
          '这不代表网关不可用：可能是当前密钥的分组没有可用渠道，或 /v1/models 被站点关闭。请检查令牌分组、渠道分组与渠道模型列表。',
      },
    ]
  }
  const lines = [`网关暴露 ${value.count} 个模型（格式 ${value.format}）：`]
  for (const model of value.models) {
    const extra = [model.displayName, model.ownedBy].filter((entry) => typeof entry === 'string' && entry.length > 0)
    lines.push(`  - ${model.id}${extra.length > 0 ? `  (${extra.join(' / ')})` : ''}`)
  }
  if (value.nextStep !== null) lines.push('', value.nextStep)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the models tool. */
export function registerModelsTool(ctx, deps, options) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_models',
      description:
        '列出网关实际暴露的模型（GET /v1/models）。写调用代码前先核对，不要用记忆里的模型名。' +
        'format 选择认证风格：openai（Bearer，默认）、anthropic（x-api-key）、gemini（/v1beta/models）。',
      parameters: S.object(
        {
          format: S.string({
            description: '返回格式：openai（默认）、anthropic 或 gemini。',
            enum: ['openai', 'anthropic', 'gemini'],
          }),
          timeoutMs: S.integer({ description: '请求超时（毫秒），默认 120000。' }),
        },
        { additionalProperties: false },
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => render(value),
      },
      async execute(args, exec) {
        const { ai } = await deps.context()
        const result = await ai.models({
          format: args.format ?? 'openai',
          signal: exec.signal,
          timeoutMs: args.timeoutMs,
        })
        const value = {
          format: result.format,
          count: result.count,
          models: result.models,
          durationMs: result.durationMs,
          nextStep:
            result.count === 0
              ? '没有模型可用：请检查当前令牌的分组、渠道分组与渠道模型列表是否匹配。'
              : null,
        }
        deps.record('newapi_models', {
          api: 'ai',
          method: 'GET',
          path: result.format === 'gemini' ? '/v1beta/models' : '/v1/models',
          ok: true,
          durationMs: result.durationMs,
        })
        return value
      },
    }),
    options,
  )
}
