/** `newapi_embed`: text embeddings. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { USAGE_SCHEMA } from './schemas.js'

const EMBEDDING_SCHEMA = S.object(
  {
    index: S.integer({ required: true }),
    vector: S.array(S.number(), { required: true }),
    preview: S.array(S.number(), { required: true }),
  },
  { additionalProperties: false },
)

const OUTPUT_SCHEMA = S.object(
  {
    model: S.string({ required: true }),
    count: S.integer({ required: true }),
    dimensions: S.integer({ required: true }),
    embeddings: S.array(EMBEDDING_SCHEMA, { required: true }),
    usage: S.oneOf([USAGE_SCHEMA, S.null()]),
    durationMs: S.integer({ required: true }),
  },
  { additionalProperties: false },
)

function render(value) {
  if (value.count === 0) {
    return [{ type: 'text', text: `模型 ${value.model} 没有返回向量。请检查模型是否支持 /v1/embeddings。` }]
  }
  const lines = [
    `向量完成：model=${value.model}，${value.count} 条，维度 ${value.dimensions}`,
    '说明：模型可见的是每条向量的前 8 个值；完整向量保存在工具返回值中，供程序化调用读取。',
  ]
  for (const entry of value.embeddings) {
    lines.push(`  [${entry.index}] [${entry.preview.map((number) => number.toFixed(6)).join(', ')}${entry.vector.length > entry.preview.length ? ', ...' : ''}]`)
  }
  if (value.usage !== null) {
    lines.push(`用量：prompt=${value.usage.promptTokens ?? '?'} total=${value.usage.totalTokens ?? '?'}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the embeddings tool. */
export function registerEmbedTool(ctx, deps, options) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_embed',
      description:
        '调用 /v1/embeddings 生成文本向量，input 可为单条字符串或数组。返回完整向量与维度，但对话里只显示前 8 维。模型必须支持 embeddings。',
      parameters: S.object(
        {
          model: S.string({ required: true, description: '向量模型名，如 text-embedding-3-small。' }),
          input: S.oneOf([S.string(), S.array(S.string())], {
            required: true,
            description: '单条文本或文本数组。',
          }),
          dimensions: S.integer({ description: '部分模型支持指定输出维度。' }),
          encodingFormat: S.string({ description: '编码格式，通常 float；不要用 base64，除非调用方自行解码。' }),
          user: S.string({ description: '终端用户标识。' }),
          extra: S.any({ description: '额外请求体字段（对象）。' }),
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
        try {
          const result = await ai.embed({
            model: args.model,
            input: args.input,
            dimensions: args.dimensions,
            encodingFormat: args.encodingFormat,
            user: args.user,
            extra: args.extra,
            signal: exec.signal,
            timeoutMs: args.timeoutMs,
          })
          deps.record('newapi_embed', {
            api: 'ai',
            method: 'POST',
            path: '/v1/embeddings',
            ok: true,
            durationMs: result.durationMs,
          })
          return {
            model: result.model,
            count: result.count,
            dimensions: result.dimensions,
            embeddings: result.embeddings,
            usage: result.usage,
            durationMs: result.durationMs,
          }
        } catch (error) {
          deps.record('newapi_embed', {
            api: 'ai',
            method: 'POST',
            path: '/v1/embeddings',
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
