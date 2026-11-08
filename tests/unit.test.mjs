import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeBaseUrl } from '../lib/site.js'
import { SecretStore } from '../lib/secrets.js'
import { maskSecret, redactValue, registerSecret } from '../lib/redact.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(import.meta.dirname, '.tmp-unit-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('normalizes gateway roots and rejects unsafe URLs', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com')
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com')
  assert.equal(normalizeBaseUrl('https://api.example.com/api'), 'https://api.example.com')
  assert.equal(normalizeBaseUrl('https://api.example.com/gateway/v1'), 'https://api.example.com/gateway')
  // A bare IP:port is the common internal deployment; it implies http.
  assert.equal(normalizeBaseUrl('192.0.2.10:3000'), 'http://192.0.2.10:3000')
  assert.equal(normalizeBaseUrl('192.0.2.10:3000/'), 'http://192.0.2.10:3000')
  assert.equal(normalizeBaseUrl('192.0.2.10:3000/v1/'), 'http://192.0.2.10:3000')
  assert.equal(normalizeBaseUrl('10.0.0.8'), 'http://10.0.0.8')
  assert.equal(normalizeBaseUrl('localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeBaseUrl('[::1]:3000'), 'http://[::1]:3000')
  // A bare public hostname stays https; an explicit scheme always wins.
  assert.equal(normalizeBaseUrl('api.example.com'), 'https://api.example.com')
  assert.equal(normalizeBaseUrl('api.example.com:8443'), 'http://api.example.com:8443')
  assert.equal(normalizeBaseUrl('http://192.0.2.10:3000'), 'http://192.0.2.10:3000')
  assert.throws(() => normalizeBaseUrl('ftp://api.example.com'), /http\/https/)
  assert.throws(() => normalizeBaseUrl('https://user:pass@api.example.com'), /用户名或密码/)
  assert.throws(() => normalizeBaseUrl('https://api.example.com/?x=1'), /查询参数/)
  assert.throws(() => normalizeBaseUrl('not a url'), /不是合法的 URL/)
})

test('masks short and sk- secrets without echoing the value', () => {
  assert.equal(maskSecret('short'), '***')
  assert.equal(maskSecret('sk-1234567890abcdef'), 'sk-1234********cdef')
  assert.ok(!maskSecret('sk-1234567890abcdef').includes('567890ab'))
})

test('redacts credential keys but leaves option keys readable', () => {
  const token = redactValue({ id: 7, key: 'secret-token-value-1234567890', remain_quota: 1 })
  assert.ok(!JSON.stringify(token).includes('secret-token-value'))
  const channel = redactValue({ id: 1, key: 'upstream-secret-value-123456', models: 'gpt-4o' })
  assert.ok(!JSON.stringify(channel).includes('upstream-secret-value'))
  const option = redactValue({ key: 'GroupRatio', value: '{"default":1}' })
  assert.equal(option.key, 'GroupRatio')
  const nested = redactValue({ auth: { api_key: 'abcdef123456' }, accessToken: 'abcdef123456' })
  assert.equal(nested.auth.api_key, '***')
  assert.equal(nested.accessToken, '***')
})

test('registered secrets are scrubbed from arbitrary text', () => {
  registerSecret('unique-secret-987654321')
  const value = redactValue({ message: 'leaked unique-secret-987654321 here' })
  assert.ok(!JSON.stringify(value).includes('unique-secret-987654321'))
})

test('encrypted secret store round-trips without plaintext on disk', async () => {
  await withTempDir(async (dir) => {
    const store = new SecretStore({ dir })
    assert.equal(await store.status('site:apiKey'), 'missing')
    await store.set('site:apiKey', 'sk-very-secret-value')
    assert.equal(await store.status('site:apiKey'), 'available')
    assert.equal(await store.get('site:apiKey'), 'sk-very-secret-value')
    const credentials = await readFile(store.credentialsFile, 'utf8')
    assert.ok(!credentials.includes('sk-very-secret-value'))
    const master = await readFile(store.masterKeyFile, 'utf8')
    assert.equal(Buffer.from(master.trim(), 'base64').length, 32)
    assert.equal(await store.delete('site:apiKey'), true)
    assert.equal(await store.status('site:apiKey'), 'missing')
  })
})

test('a mismatched master key produces a structured error', async () => {
  await withTempDir(async (dir) => {
    const store = new SecretStore({ dir })
    await store.set('site:accessToken', 'access-value')
    await writeFile(store.masterKeyFile, `${Buffer.alloc(32, 7).toString('base64')}\n`, 'utf8')
    await assert.rejects(() => store.get('site:accessToken'), /凭据解密失败/)
  })
})
