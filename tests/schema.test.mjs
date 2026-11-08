import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { checkSupportedSchema, validateSchema } from '../lib/tool.js'
import { mountPlugin, call } from './helpers.mjs'

const GATED = [
  'newapi_models',
  'newapi_chat',
  'newapi_embed',
  'newapi_tokens',
  'newapi_channels',
  'newapi_logs',
  'newapi_options',
  'newapi_raw',
]

test('registers the consolidated newapi_* tool surface', () => {
  const { tools } = mountPlugin({ baseUrl: 'http://127.0.0.1:1', audit: false })
  assert.equal(tools.size, GATED.length + 1)
  assert.ok(tools.has('newapi_site'))
  for (const name of GATED) assert.ok(tools.has(name), `missing ${name}`)
  for (const [name, definition] of tools) {
    assert.match(name, /^newapi_[a-z_]+$/)
    assert.ok(definition.description.length >= 30, `${name} description is too short`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.deepEqual(checkSupportedSchema(definition.parameters, `${name}.parameters`), [])
    assert.deepEqual(checkSupportedSchema(definition.output.schema, `${name}.output`), [])
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('only the site tool is visible before a gateway is configured', async () => {
  const dir = await mkdtemp(join(import.meta.dirname, '.tmp-gate-'))
  const saved = process.env.NEWAPI_BASE_URL
  delete process.env.NEWAPI_BASE_URL
  try {
    const { registrations } = mountPlugin({ baseUrl: '', dataDir: dir, secretsBackend: 'none', audit: false })
    assert.equal(registrations.get('newapi_site').when, undefined)
    for (const name of GATED) {
      const condition = registrations.get(name).when
      assert.equal(typeof condition, 'function', `${name} must be gated`)
      assert.equal(await condition({}), false, `${name} must stay hidden without a gateway`)
    }

    await call(mountPlugin({ baseUrl: '', dataDir: dir, secretsBackend: 'none', audit: false }).tools, 'newapi_site', {
      action: 'set',
      baseUrl: 'https://api.example.com',
      userId: '1',
    })
    for (const name of GATED) {
      assert.equal(await registrations.get(name).when({}), true, `${name} must appear after setup`)
    }
  } finally {
    if (saved === undefined) delete process.env.NEWAPI_BASE_URL
    else process.env.NEWAPI_BASE_URL = saved
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects unknown arguments before touching the network', async () => {
  const { tools } = mountPlugin({ baseUrl: 'http://127.0.0.1:1', audit: false })
  await assert.rejects(() => call(tools, 'newapi_models', { bogus: true }), /不是允许的参数/)
  await assert.rejects(() => call(tools, 'newapi_chat', { messages: [] }), /model 为必填项/)
  await assert.rejects(() => call(tools, 'newapi_raw', {}), /path 为必填项/)
})

test('merged actions validate their required arguments', async () => {
  const { tools } = mountPlugin({ baseUrl: 'http://127.0.0.1:1', audit: false })
  await assert.rejects(() => call(tools, 'newapi_tokens', { action: 'create' }), /需要 name/)
  await assert.rejects(() => call(tools, 'newapi_tokens', { action: 'delete' }), /需要整数 id/)
  await assert.rejects(() => call(tools, 'newapi_channels', { action: 'test' }), /需要整数 id/)
  await assert.rejects(() => call(tools, 'newapi_site', { action: 'set' }), /至少需要 baseUrl 或 userId/)
})

test('parameter validation covers enums, oneOf, and nested objects', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['a', 'b'] },
      value: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'integer' } },
        },
      },
    },
  }
  assert.deepEqual(validateSchema(schema, { kind: 'a', value: 1, items: [{ id: 1 }] }), [])
  assert.match(validateSchema(schema, { kind: 'c' }).join(';'), /取值必须是/)
  assert.match(validateSchema(schema, { kind: 'a', value: true }).join(';'), /只能匹配一种/)
  assert.match(validateSchema(schema, { kind: 'a', items: [{}] }).join(';'), /id 为必填项/)
})
