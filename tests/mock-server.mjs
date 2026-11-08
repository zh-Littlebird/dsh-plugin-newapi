/** Minimal New API mock used by the integration tests. */

import { createServer } from 'node:http'

const ACCESS = 'test-access'
const API_KEY = 'sk-test'

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function adminAuthorized(req) {
  return req.headers.authorization === `Bearer ${ACCESS}` && req.headers['new-api-user'] === '1'
}

function aiAuthorized(req) {
  return req.headers.authorization === `Bearer ${API_KEY}`
}

/** Start a loopback server; call `close()` in a test teardown. */
export async function startMock() {
  const requests = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers })
    const path = url.pathname

    if (path === '/api/status') {
      send(res, 200, {
        success: true,
        data: {
          system_name: 'Mock New API',
          version: '0.9.0',
          setup: true,
          quota_per_unit: 500000,
          log_max_range_days: 30,
          start_time: 1760000000,
        },
      })
      return
    }

    if (path.startsWith('/api/') && !adminAuthorized(req)) {
      send(res, 401, { success: false, message: 'unauthorized: bad access token' })
      return
    }
    if (path.startsWith('/v1/') && !aiAuthorized(req)) {
      send(res, 401, { error: { message: 'invalid token', type: 'invalid_request_error' } })
      return
    }

    if (path === '/api/user/self') {
      send(res, 200, {
        success: true,
        data: {
          id: 1,
          username: 'root',
          display_name: 'Root',
          role: 100,
          status: 1,
          group: 'default',
          quota: 1000000,
          used_quota: 250000,
          request_count: 12,
          aff_quota: 0,
          aff_count: 0,
        },
      })
      return
    }

    if (path === '/api/token/' && req.method === 'GET') {
      send(res, 200, {
        success: true,
        data: {
          total: 1,
          items: [
            {
              id: 7,
              name: 'demo',
              key: 'secret-token-value-1234567890',
              status: 1,
              remain_quota: 500000,
              used_quota: 10,
              unlimited_quota: false,
              group: 'default',
              expired_time: -1,
              created_time: 1760000000,
              accessed_time: 1760000100,
              model_limits: 'gpt-4o-mini',
              allow_ips: '',
            },
          ],
        },
      })
      return
    }

    if (path === '/api/token/search' && req.method === 'GET') {
      send(res, 200, {
        success: true,
        data: [{ id: 7, name: 'demo', key: 'secret-token-value-1234567890', status: 1, remain_quota: 1 }],
      })
      return
    }

    if (path === '/api/token/' && req.method === 'POST') {
      send(res, 200, { success: true, data: { id: 8, key: 'newsecretvalue123456' } })
      return
    }

    if (path === '/api/token/8' && req.method === 'DELETE') {
      send(res, 200, { success: true, message: 'deleted' })
      return
    }

    if (path === '/api/channel/' && req.method === 'GET') {
      send(res, 200, {
        success: true,
        data: {
          total: 1,
          items: [
            {
              id: 1,
              name: 'openai-main',
              type: 1,
              status: 1,
              group: 'default',
              models: 'gpt-4o-mini,deepseek-chat',
              priority: 10,
              weight: 5,
              base_url: 'https://upstream.example.com',
              key: 'upstream-secret-key-123456',
              balance: 12.5,
              used_quota: 100,
              response_time: 320,
              test_time: 1760000200,
              tag: 'prod',
              auto_ban: true,
            },
          ],
        },
      })
      return
    }

    if (path === '/api/channel/' && req.method === 'POST') {
      send(res, 200, { success: true, message: 'created', data: { id: 2 } })
      return
    }

    if (path === '/api/channel/test/1') {
      send(res, 200, { success: true, message: 'test ok', data: { response_time: 120 } })
      return
    }
    if (path === '/api/channel/test/2') {
      send(res, 200, { success: false, message: 'invalid upstream key' })
      return
    }

    if (path === '/api/log/' && req.method === 'GET') {
      send(res, 200, {
        success: true,
        data: {
          total: 2,
          items: [
            {
              id: 11,
              created_at: 1760000300,
              type: 2,
              username: 'root',
              token_name: 'demo',
              model_name: 'gpt-4o-mini',
              quota: 120,
              prompt_tokens: 10,
              completion_tokens: 20,
              channel: 1,
              group: 'default',
              request_id: 'req-1',
              content: 'hello',
            },
            {
              id: 12,
              created_at: 1760000400,
              type: 2,
              username: 'root',
              token_name: 'demo',
              model_name: 'deepseek-chat',
              quota: 80,
              prompt_tokens: 5,
              completion_tokens: 10,
              channel: 1,
              group: 'default',
              request_id: 'req-2',
            },
          ],
        },
      })
      return
    }

    if (path === '/api/log/stat') {
      send(res, 200, { success: true, data: { quota: 200, rpm: 1.5, tpm: 90 } })
      return
    }

    if (path === '/api/option/') {
      send(res, 200, {
        success: true,
        data: [
          { key: 'GroupRatio', value: '{"default":1,"vip":0.8}' },
          { key: 'ModelRatio', value: '{"gpt-4o-mini":0.075}' },
          { key: 'QuotaForInviter', value: '500000' },
        ],
      })
      return
    }

    if (path === '/api/secure') {
      send(res, 403, { success: false, message: 'forbidden' })
      return
    }

    if (path === '/v1/models' && req.method === 'GET') {
      send(res, 200, {
        object: 'list',
        data: [
          { id: 'deepseek-chat', object: 'model', created: 1760000000, owned_by: 'deepseek' },
          { id: 'gpt-4o-mini', object: 'model', created: 1760000000, owned_by: 'openai' },
        ],
      })
      return
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      if (body?.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', model: body.model, choices: [{ index: 0, delta: { content: '你' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', model: body.model, choices: [{ index: 0, delta: { content: '好' } }] })}\n\n`)
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          })}\n\n`,
        )
        res.end('data: [DONE]\n\n')
        return
      }
      send(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1760000000,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '你好，这是 mock 回复。' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
      })
      return
    }

    if (path === '/v1/embeddings' && req.method === 'POST') {
      send(res, 200, {
        object: 'list',
        model: body.model,
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      })
      return
    }

    send(res, 404, { success: false, message: `not found: ${path}` })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export const MOCK_ACCESS = ACCESS
export const MOCK_API_KEY = API_KEY
