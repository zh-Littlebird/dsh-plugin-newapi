/** `newapi_chat`: Chat Completions with optional aggregated streaming. */

import { defineTool } from '../tool.js'
import { S } from '../schema.js'
import { redactValue } from '../redact.js'
import { renderJson, truncateText } from './common.js'
import { NULLABLE_INTEGER, NULLABLE_NUMBER, NULLABLE_STRING, TOOL_CALL_SCHEMA, USAGE_SCHEMA } from './schemas.js'

const MESSAGE_SCHEMA = S.object(
  {
    role: S.string({
      required: true,
      enum: ['system', 'developer', 'user', 'assistant', 'tool'],
      description: '消息角色。',
    }),
    content: S.any({
      description: '字符串或 OpenAI 多模态 content part 数组；tool 消息放工具结果。',
    }),
    name: S.string({ description: '可选的参与者名称。' }),
    tool_call_id: S.string({ description: 'tool 消息对应的 tool_call id。' }),
    tool_calls: S.any({ description: 'assistant 消息携带的工具调用数组。' }),
  },
  { additionalProperties: true },
)

const OUTPUT_SCHEMA = S.object(
  {
    id: NULLABLE_STRING,
    model: NULLABLE_STRING,
    created: NULLABLE_NUMBER,
    content: S.string({ required: true }),
    reasoning: NULLABLE_STRING,
    refusal: NULLABLE_STRING,
    toolCalls: S.array(TOOL_CALL_SCHEMA, { required: true }),
    finishReason: NULLABLE_STRING,
    usage: S.oneOf([USAGE_SCHEMA, S.null()]),
    streamed: S.boolean({ required: true }),
    streamFallback: S.boolean({ required: true }),
    chunks: S.integer({ required: true }),
    unparsedChunks: S.integer({ required: true }),
    truncated: S.boolean({ required: true }),
    durationMs: S.integer({ required: true }),
    requestId: NULLABLE_STRING,
  },
  { additionalProperties: false },
)

function render(value) {
  const lines = [
    `对话完成：model=${value.model ?? '未知'}${value.streamed ? '（流式已聚合）' : ''}${value.streamFallback ? '（网关不支持流式，已回退普通响应）' : ''}`,
    '',
  ]
  if (value.content.length > 0) {
    lines.push(truncateText(value.content, 12_000))
  } else {
    lines.push('（模型没有返回文本内容）')
  }
  if (value.reasoning !== null && value.reasoning.length > 0) {
    lines.push('', '推理内容：', truncateText(value.reasoning, 4_000))
  }
  if (value.toolCalls.length > 0) {
    lines.push('', `工具调用 ${value.toolCalls.length} 个：`, renderJson(value.toolCalls, 4_000))
  }
  if (value.usage !== null) {
    lines.push(
      '',
      `用量：prompt=${value.usage.promptTokens ?? '?'} completion=${value.usage.completionTokens ?? '?'} total=${value.usage.totalTokens ?? '?'}`,
    )
  }
  if (value.finishReason !== null) lines.push(`结束原因：${value.finishReason}`)
  if (value.truncated) lines.push('注意：流式响应超过上限，内容已截断。')
  lines.push(`耗时：${value.durationMs} ms`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Register the chat tool. */
export function registerChatTool(ctx, deps, options) {
  ctx.tools.register(
    defineTool({
      name: 'newapi_chat',
      description:
        '调用 /v1/chat/completions：网关联调、模型对比，或让另一个模型做子任务。messages 用 OpenAI 格式，多模态 content 数组可直接传。' +
        '供应商特有字段（如 reasoning_effort、service_tier）放 extra。stream=true 会聚合 SSE 后一次返回，不提供实时输出。',
      parameters: S.object(
        {
          model: S.string({ required: true, description: '网关实际暴露的模型名；先调用 newapi_models 核对。' }),
          messages: S.array(MESSAGE_SCHEMA, { required: true, description: 'OpenAI Chat Completions 消息数组。' }),
          stream: S.boolean({ description: '是否请求流式；插件会聚合后返回，默认 false。' }),
          temperature: S.number({ description: '采样温度。' }),
          topP: S.number({ description: 'top_p。' }),
          maxTokens: S.integer({ description: '最大生成 token 数（max_tokens）。' }),
          stop: S.oneOf([S.string(), S.array(S.string())], { description: '停止序列。' }),
          presencePenalty: S.number({ description: 'presence_penalty。' }),
          frequencyPenalty: S.number({ description: 'frequency_penalty。' }),
          seed: S.integer({ description: '随机种子（上游支持时）。' }),
          tools: S.array(S.any(), { description: 'OpenAI tools 数组；每项通常是 {type:"function",function:{...}}。' }),
          toolChoice: S.any({ description: 'tool_choice，可为 "auto"/"none"/"required" 或对象。' }),
          responseFormat: S.any({ description: 'response_format 对象，如 {"type":"json_object"}。' }),
          user: S.string({ description: '终端用户标识。' }),
          n: S.integer({ description: '生成候选数；插件只返回第一个 choice。' }),
          extra: S.any({
            description: '额外请求体字段（对象），如 reasoning_effort、service_tier、parallel_tool_calls；标准字段优先。',
          }),
          timeoutMs: S.integer({ description: '请求超时（毫秒），默认 120000；长推理可调大。' }),
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
          const result = await ai.chat({
            model: args.model,
            messages: args.messages,
            stream: args.stream === true,
            temperature: args.temperature,
            topP: args.topP,
            maxTokens: args.maxTokens,
            stop: args.stop,
            presencePenalty: args.presencePenalty,
            frequencyPenalty: args.frequencyPenalty,
            seed: args.seed,
            tools: args.tools,
            toolChoice: args.toolChoice,
            responseFormat: args.responseFormat,
            user: args.user,
            n: args.n,
            extra: args.extra,
            signal: exec.signal,
            timeoutMs: args.timeoutMs,
          })
          const value = {
            id: result.id ?? null,
            model: result.model ?? null,
            created: result.created ?? null,
            content: typeof result.content === 'string' ? result.content : '',
            reasoning: typeof result.reasoning === 'string' ? result.reasoning : null,
            refusal: typeof result.refusal === 'string' ? result.refusal : null,
            toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
            finishReason: typeof result.finishReason === 'string' ? result.finishReason : null,
            usage: result.usage ?? null,
            streamed: result.streamed === true,
            streamFallback: result.streamFallback === true,
            chunks: typeof result.chunks === 'number' ? result.chunks : 0,
            unparsedChunks: typeof result.unparsedChunks === 'number' ? result.unparsedChunks : 0,
            truncated: result.truncated === true,
            durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
            requestId: typeof result.requestId === 'string' ? result.requestId : null,
          }
          deps.record('newapi_chat', {
            api: 'ai',
            method: 'POST',
            path: '/v1/chat/completions',
            ok: true,
            durationMs: value.durationMs,
          })
          return redactValue(value)
        } catch (error) {
          deps.record('newapi_chat', {
            api: 'ai',
            method: 'POST',
            path: '/v1/chat/completions',
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
