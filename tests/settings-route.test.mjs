/** The Settings → New API route: state, site write, credential write, self-check. */

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { startMock, MOCK_ACCESS, MOCK_API_KEY } from './mock-server.mjs'
import { createRuntime } from '../lib/config.js'
import { createDeps } from '../index.js'
import { handleSettingsRequest, mountSettingsRoute } from '../lib/settings-route.js'

const savedEnv = {
  NEWAPI_BASE_URL: process.env.NEWAPI_BASE_URL,
  NEWAPI_API_KEY: process.env.NEWAPI_API_KEY,
  NEWAPI_ACCESS_TOKEN: process.env.NEWAPI_ACCESS_TOKEN,
}

let mock
let dataDir
let deps

before(async () => {
  for (const key of Object.keys(savedEnv)) delete process.env[key]
  mock = await startMock()
  dataDir = await mkdtemp(join(import.meta.dirname, '.tmp-settings-'))
  const runtime = createRuntime({ baseUrl: '', dataDir, secretsBackend: 'file', audit: false })
  deps = createDeps({ runtime })
})

after(async () => {
  await mock?.close()
  await rm(dataDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function request(options) {
  const { method = 'GET', path, body, header = false, remoteAddress = '127.0.0.1' } = options
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.url = path
  req.headers = header ? { 'x-newapi-ui': '1', 'content-type': 'application/json' } : {}
  req.socket = { remoteAddress }
  const res = {
    status: 0,
    headers: {},
    text: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
    },
    end(text) {
      res.text = text ?? ''
    },
  }
  await handleSettingsRequest(req, res, deps)
  let json = null
  try {
    json = JSON.parse(res.text)
  } catch {
    json = null
  }
  return { status: res.status, json, text: res.text, headers: res.headers }
}

test('state reports the site without any secret value', async () => {
  const response = await request({ path: '/newapi/state' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.state.configured, false)
  assert.equal(response.json.state.credentials.apiKey, 'missing')
  assert.equal(response.json.state.credentials.accessToken, 'missing')
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('a non-loopback caller is refused', async () => {
  const response = await request({ path: '/newapi/state', remoteAddress: '10.1.2.3' })
  assert.equal(response.status, 403)
  assert.equal(response.json.error.code, 'FORBIDDEN')
})

test('writes require the settings-page header', async () => {
  const response = await request({
    method: 'POST',
    path: '/newapi/site',
    body: { baseUrl: 'https://api.example.com' },
  })
  assert.equal(response.status, 403)
  assert.equal(response.json.error.code, 'MISSING_UI_HEADER')
  await assert.rejects(() => readFile(join(dataDir, 'site.json'), 'utf8'), /ENOENT/)
})

test('the site write normalizes a bare IP:port and persists it', async () => {
  const bare = mock.baseUrl.replace(/^http:\/\//, '')
  const response = await request({
    method: 'POST',
    path: '/newapi/site',
    header: true,
    body: { baseUrl: `${bare}/v1/`, userId: '1' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.state.baseUrl, mock.baseUrl)
  assert.equal(response.json.state.configured, true)
  assert.equal(response.json.state.userId, '1')
  const site = JSON.parse(await readFile(join(dataDir, 'site.json'), 'utf8'))
  assert.equal(site.baseUrl, mock.baseUrl)
})

test('an invalid gateway URL is rejected before it is written', async () => {
  const response = await request({
    method: 'POST',
    path: '/newapi/site',
    header: true,
    body: { baseUrl: 'ftp://api.example.com' },
  })
  assert.equal(response.status, 400)
  assert.equal(response.json.error.code, 'CONFIG_INVALID')
})

test('credentials are stored encrypted and never echoed back', async () => {
  const apiKey = await request({
    method: 'POST',
    path: '/newapi/credential',
    header: true,
    body: { field: 'apiKey', value: MOCK_API_KEY },
  })
  assert.equal(apiKey.status, 200)
  assert.equal(apiKey.json.state.credentials.apiKey, 'available')
  assert.ok(!apiKey.text.includes(MOCK_API_KEY))

  const token = await request({
    method: 'POST',
    path: '/newapi/credential',
    header: true,
    body: { field: 'accessToken', value: MOCK_ACCESS },
  })
  assert.equal(token.status, 200)
  assert.equal(token.json.state.credentials.accessToken, 'available')

  const state = await request({ path: '/newapi/state' })
  assert.ok(!state.text.includes(MOCK_API_KEY))
  assert.ok(!state.text.includes(MOCK_ACCESS))

  const stored = await readFile(join(dataDir, 'credentials.json'), 'utf8')
  assert.ok(!stored.includes(MOCK_API_KEY))
  assert.ok(!stored.includes(MOCK_ACCESS))
  if (process.platform !== 'win32') {
    const mode = (await stat(join(dataDir, 'credentials.json'))).mode
    assert.equal(mode & 0o777, 0o600)
  }
})

test('the self-check endpoint reuses the tool implementation', async () => {
  const response = await request({ method: 'POST', path: '/newapi/test', header: true, body: {} })
  assert.equal(response.status, 200)
  const check = response.json.check
  assert.equal(check.reachable, true)
  assert.equal(check.site.systemName, 'Mock New API')
  assert.equal(check.auth.management.status, 'ok')
  assert.equal(check.auth.ai.status, 'ok')
  assert.equal(check.auth.ai.modelCount, 2)
  assert.equal(check.user.username, 'root')
})

test('clearing a credential flips it back to missing', async () => {
  const response = await request({
    method: 'POST',
    path: '/newapi/credential',
    header: true,
    body: { field: 'accessToken', clear: true },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.state.credentials.accessToken, 'missing')

  const empty = await request({
    method: 'POST',
    path: '/newapi/credential',
    header: true,
    body: { field: 'accessToken', value: '   ' },
  })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error.code, 'INVALID_ARGS')
})

test('unknown routes and methods are explicit', async () => {
  const notFound = await request({ method: 'POST', path: '/newapi/nope', header: true, body: {} })
  assert.equal(notFound.status, 404)
  const method = await request({ method: 'PUT', path: '/newapi/site' })
  assert.equal(method.status, 405)
})

test('mounting registers one prefix route on the web server', () => {
  const routes = []
  const disposers = []
  const webServer = {
    register(route) {
      routes.push(route)
      const dispose = () => routes.splice(routes.indexOf(route), 1)
      disposers.push(dispose)
      return dispose
    },
  }
  const ctx = {
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    effect(fn) {
      return fn()
    },
  }
  mountSettingsRoute(ctx, deps)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/newapi')
  assert.equal(typeof routes[0].handler, 'function')
})

test('a headless context without a web server still mounts', () => {
  const ctx = { effect(fn) { return fn() } }
  mountSettingsRoute(ctx, deps)
})
