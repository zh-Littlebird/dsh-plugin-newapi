import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startMock, MOCK_ACCESS, MOCK_API_KEY } from './mock-server.mjs'
import { mountPlugin, call, render } from './helpers.mjs'

const originalEnv = {
  TEST_NEWAPI_KEY: process.env.TEST_NEWAPI_KEY,
  TEST_NEWAPI_TOKEN: process.env.TEST_NEWAPI_TOKEN,
  NEWAPI_BASE_URL: process.env.NEWAPI_BASE_URL,
}

let mock
let dataDir
let tools

before(async () => {
  mock = await startMock()
  dataDir = await mkdtemp(join(import.meta.dirname, '.tmp-integration-'))
  process.env.TEST_NEWAPI_KEY = MOCK_API_KEY
  process.env.TEST_NEWAPI_TOKEN = MOCK_ACCESS
  delete process.env.NEWAPI_BASE_URL
  tools = mountPlugin({
    baseUrl: mock.baseUrl,
    userId: '1',
    dataDir,
    secretsBackend: 'env',
    apiKeyEnv: 'TEST_NEWAPI_KEY',
    accessTokenEnv: 'TEST_NEWAPI_TOKEN',
    audit: false,
    debug: false,
  }).tools
})

after(async () => {
  await mock?.close()
  await rm(dataDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('newapi_site show exposes the effective site without secrets', async () => {
  const value = await call(tools, 'newapi_site', { action: 'show' })
  assert.equal(value.configured, true)
  assert.equal(value.baseUrl, mock.baseUrl)
  assert.equal(value.userId, '1')
  assert.equal(value.credentials.apiKey, 'available')
  assert.equal(value.credentials.accessToken, 'available')
  assert.equal(value.source.baseUrl, 'config')
  assert.match(render(tools, 'newapi_site', { action: 'show' }, value), /New API 站点配置/)
})

test('newapi_site set writes site.json', async () => {
  const siteDir = join(dataDir, 'config-site')
  const local = mountPlugin({
    baseUrl: mock.baseUrl,
    dataDir: siteDir,
    secretsBackend: 'none',
    audit: false,
  }).tools
  const value = await call(local, 'newapi_site', { action: 'set', userId: '2' })
  assert.equal(value.saved, true)
  assert.equal(value.userId, '2')
  const site = JSON.parse(await readFile(join(siteDir, 'site.json'), 'utf8'))
  assert.equal(site.baseUrl, mock.baseUrl)
  assert.equal(site.userId, '2')
})

test('newapi_site set repairs an unreadable site.json', async () => {
  const brokenDir = join(dataDir, 'broken-site')
  await mkdir(brokenDir, { recursive: true })
  await writeFile(join(brokenDir, 'site.json'), '{not json', 'utf8')
  const local = mountPlugin({
    baseUrl: '',
    dataDir: brokenDir,
    secretsBackend: 'none',
    audit: false,
  }).tools
  await assert.rejects(() => call(local, 'newapi_site', { action: 'show' }), /站点配置文件无法解析/)
  const value = await call(local, 'newapi_site', { action: 'set', baseUrl: 'https://api.example.com', userId: '1' })
  assert.equal(value.saved, true)
  assert.equal(value.baseUrl, 'https://api.example.com')
  const site = JSON.parse(await readFile(join(brokenDir, 'site.json'), 'utf8'))
  assert.equal(site.baseUrl, 'https://api.example.com')
})

test('newapi_site test checks public status, management auth, and AI key', async () => {
  const value = await call(tools, 'newapi_site', { action: 'test' })
  assert.equal(value.reachable, true)
  assert.equal(value.site.systemName, 'Mock New API')
  assert.equal(value.site.version, '0.9.0')
  assert.equal(value.auth.management.status, 'ok')
  assert.equal(value.auth.ai.status, 'ok')
  assert.equal(value.auth.ai.modelCount, 2)
  assert.equal(value.user.username, 'root')
  assert.match(render(tools, 'newapi_site', { action: 'test' }, value), /管理接口: ok/)
})

test('newapi_site quota summarizes quota and derives an approximate amount', async () => {
  const value = await call(tools, 'newapi_site', { action: 'quota' })
  assert.equal(value.user.username, 'root')
  assert.equal(value.user.quota, 1000000)
  assert.equal(value.quota.quotaPerUnit, 500000)
  assert.equal(value.quota.approxAmount, 2)
  assert.match(render(tools, 'newapi_site', { action: 'quota' }, value), /剩余额度/)
})

test('newapi_models lists the gateway models sorted by id', async () => {
  const value = await call(tools, 'newapi_models', {})
  assert.equal(value.count, 2)
  assert.deepEqual(value.models.map((model) => model.id), ['deepseek-chat', 'gpt-4o-mini'])
  assert.match(render(tools, 'newapi_models', {}, value), /网关暴露 2 个模型/)
})

test('newapi_chat returns normalized non-stream content and usage', async () => {
  const value = await call(tools, 'newapi_chat', {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'ping' }],
    temperature: 0.2,
    maxTokens: 32,
  })
  assert.equal(value.streamed, false)
  assert.match(value.content, /mock 回复/)
  assert.equal(value.usage.totalTokens, 12)
  assert.equal(value.finishReason, 'stop')
})

test('newapi_chat aggregates SSE deltas when stream=true', async () => {
  const value = await call(tools, 'newapi_chat', {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
  })
  assert.equal(value.streamed, true)
  assert.equal(value.content, '你好')
  assert.equal(value.chunks, 3)
  assert.equal(value.usage.totalTokens, 4)
  assert.equal(value.finishReason, 'stop')
})

test('newapi_embed returns vectors and previews', async () => {
  const value = await call(tools, 'newapi_embed', {
    model: 'text-embedding-3-small',
    input: ['hello'],
  })
  assert.equal(value.count, 1)
  assert.equal(value.dimensions, 4)
  assert.deepEqual(value.embeddings[0].vector, [0.1, 0.2, 0.3, 0.4])
})

test('newapi_tokens list masks the key and never returns plaintext', async () => {
  const value = await call(tools, 'newapi_tokens', { action: 'list' })
  assert.equal(value.count, 1)
  assert.equal(value.tokens[0].id, 7)
  assert.notEqual(value.tokens[0].keyMasked, 'secret-token-value-1234567890')
  assert.ok(!JSON.stringify(value).includes('secret-token-value-1234567890'))
  assert.match(render(tools, 'newapi_tokens', { action: 'list' }, value), /令牌 1 个/)
})

test('newapi_tokens create delivers the one-time key to a 0600 file', async () => {
  const value = await call(tools, 'newapi_tokens', {
    action: 'create',
    name: 'demo-app',
    remainQuota: 500000,
    modelLimits: ['gpt-4o-mini'],
    delivery: 'file',
  })
  assert.equal(value.created, true)
  assert.equal(value.id, 8)
  assert.equal(value.key, null)
  assert.equal(value.delivery, 'file')
  assert.ok(value.keyFile !== null)
  const content = await readFile(value.keyFile, 'utf8')
  assert.match(content, /sk-newsecretvalue123456/)
  assert.ok(!JSON.stringify(value).includes('sk-newsecretvalue123456'))
  const mode = (await stat(value.keyFile)).mode
  if (process.platform !== 'win32') assert.equal(mode & 0o777, 0o600)
})

test('newapi_tokens delete requires confirmation and deletes with it', async () => {
  await assert.rejects(() => call(tools, 'newapi_tokens', { action: 'delete', id: 8 }), /需要显式确认/)
  const value = await call(tools, 'newapi_tokens', { action: 'delete', id: 8, confirm: true })
  assert.equal(value.deleted, true)
  assert.equal(value.id, 8)
})

test('newapi_channels lists channels and masks upstream keys', async () => {
  const value = await call(tools, 'newapi_channels', { action: 'list' })
  assert.equal(value.count, 1)
  assert.equal(value.channels[0].models.length, 2)
  assert.ok(!JSON.stringify(value).includes('upstream-secret-key-123456'))
  assert.match(render(tools, 'newapi_channels', { action: 'list' }, value), /渠道 1 个/)
})

test('newapi_channels test reports both success and failure without throwing', async () => {
  const ok = await call(tools, 'newapi_channels', { action: 'test', id: 1 })
  assert.equal(ok.ok, true)
  assert.equal(ok.message, 'test ok')
  const failed = await call(tools, 'newapi_channels', { action: 'test', id: 2 })
  assert.equal(failed.ok, false)
  assert.match(failed.message, /invalid upstream key/)
  assert.match(render(tools, 'newapi_channels', { action: 'test', id: 2 }, failed), /失败/)
})

test('newapi_logs returns items and stat, with content opt-in', async () => {
  const value = await call(tools, 'newapi_logs', { page: 1, pageSize: 20 })
  assert.equal(value.count, 2)
  assert.equal(value.items[0].modelName, 'gpt-4o-mini')
  assert.equal(value.items[0].content, null)
  assert.equal(value.stat.quota, 200)
  const withContent = await call(tools, 'newapi_logs', { includeContent: true })
  assert.equal(withContent.items[0].content, 'hello')
})

test('newapi_options filters by exact key', async () => {
  const value = await call(tools, 'newapi_options', { keys: ['GroupRatio'] })
  assert.equal(value.count, 1)
  assert.equal(value.options[0].key, 'GroupRatio')
  assert.match(value.options[0].value, /default/)
})

test('newapi_raw handles public reads, write confirmation, and HTTP errors', async () => {
  const status = await call(tools, 'newapi_raw', { path: '/api/status' })
  assert.equal(status.ok, true)
  assert.equal(status.api, 'public')
  assert.equal(status.data.system_name, 'Mock New API')

  await assert.rejects(
    () => call(tools, 'newapi_raw', { method: 'POST', path: '/api/token/', body: { name: 'x' } }),
    /需要人工确认/,
  )
  const created = await call(tools, 'newapi_raw', {
    method: 'POST',
    path: '/api/token/',
    body: { name: 'x' },
    confirm: true,
  })
  assert.equal(created.ok, true)
  assert.equal(created.data.id, 8)
  assert.ok(!JSON.stringify(created).includes('newsecretvalue123456'))

  const previous = process.env.TEST_NEWAPI_TOKEN
  process.env.TEST_NEWAPI_TOKEN = 'bad-token'
  try {
    const unauthorized = await call(tools, 'newapi_raw', { path: '/api/user/self' })
    assert.equal(unauthorized.ok, false)
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.error.code, 'HTTP_401')
  } finally {
    process.env.TEST_NEWAPI_TOKEN = previous
  }
})

test('management auth failure is a structured HTTP_401 error', async () => {
  const previous = process.env.TEST_NEWAPI_TOKEN
  process.env.TEST_NEWAPI_TOKEN = 'bad-token'
  try {
    await assert.rejects(() => call(tools, 'newapi_site', { action: 'quota' }), (error) => {
      assert.equal(error.code, 'HTTP_401')
      assert.match(error.hint, /系统访问令牌/)
      return true
    })
  } finally {
    process.env.TEST_NEWAPI_TOKEN = previous
  }
})

test('missing baseUrl produces CONFIG_MISSING guidance', async () => {
  const missing = mountPlugin({
    baseUrl: '',
    dataDir: join(dataDir, 'missing-site'),
    secretsBackend: 'none',
    audit: false,
  }).tools
  const value = await call(missing, 'newapi_site', { action: 'test' })
  assert.equal(value.reachable, false)
  assert.equal(value.error.code, 'CONFIG_MISSING')
  await assert.rejects(() => call(missing, 'newapi_models', {}), /还没有配置 New API 网关地址/)
})
