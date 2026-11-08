/**
 * Site metadata persisted next to the encrypted credentials.
 *
 * The base URL and user id are not secrets; keeping them in a small JSON file
 * lets the CLI configure the plugin without editing cordis.patch.yml.
 */

import { join } from 'node:path'
import { atomicWriteFile, ensureDir, readJson } from './fs-util.js'
import { NewApiError } from './errors.js'

export class SiteStore {
  /** @param {{dir: string}} options */
  constructor(options) {
    this.dir = options.dir
    this.file = join(options.dir, 'site.json')
  }

  /** @returns {Promise<{baseUrl: string|null, userId: string|null, updatedAt: string|null}>} */
  async read() {
    let document
    try {
      document = await readJson(this.file, null)
    } catch (error) {
      throw new NewApiError('SITE_INVALID', `站点配置文件无法解析：${this.file}`, {
        hint: '请重新写入站点：scripts/dsh-newapi.mjs setup --base-url <URL>，或 newapi_site action="set"（会覆盖该文件）。',
        cause: error,
      })
    }
    if (document === null) return { baseUrl: null, userId: null, updatedAt: null }
    if (typeof document !== 'object' || Array.isArray(document)) {
      throw new NewApiError('SITE_INVALID', `站点配置文件格式无效：${this.file}`, {
        hint: '请运行 scripts/dsh-newapi.mjs setup 重新写入，或删除该文件。',
      })
    }
    return {
      baseUrl: typeof document.baseUrl === 'string' && document.baseUrl.length > 0 ? document.baseUrl : null,
      userId:
        typeof document.userId === 'string' || typeof document.userId === 'number'
          ? String(document.userId)
          : null,
      updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : null,
    }
  }

  /** Merge and persist site metadata; `undefined` leaves a field unchanged. */
  async write(patch) {
    // Writing is also the repair path, so a broken current file must not block it.
    let current = { baseUrl: null, userId: null, updatedAt: null }
    try {
      current = await this.read()
    } catch {
      // Overwrite the unreadable file with a valid one below.
    }
    const baseUrl = patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl
    const userId = patch.userId === undefined ? current.userId : patch.userId
    if (baseUrl === null || baseUrl.length === 0) {
      throw new NewApiError('SITE_INVALID', 'baseUrl 不能为空', { hint: '请提供网关根地址，例如 https://api.example.com。' })
    }
    const document = {
      version: 1,
      baseUrl,
      userId: userId ?? '1',
      updatedAt: new Date().toISOString(),
    }
    await ensureDir(this.dir, 0o700)
    await atomicWriteFile(this.file, `${JSON.stringify(document, null, 2)}\n`, 0o600)
    return document
  }
}

const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

/**
 * Add the scheme a bare `host[:port]` implies.
 *
 * A gateway is usually typed as `192.0.2.10:3000` or `localhost:3000`; those
 * are internal HTTP services, while a bare public hostname is HTTPS. An explicit
 * scheme always wins, so `http://`/`https://` remain the escape hatch.
 */
function withDefaultScheme(text) {
  if (HAS_SCHEME.test(text)) return text
  const body = text.replace(/^\/+/, '')
  const authority = body.split(/[/?#]/)[0] ?? body
  const hostname = authority.replace(/:\d+$/, '')
  const lower = hostname.toLowerCase()
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
  const isIpv6 = /^\[[0-9a-fA-F:]+\]$/.test(hostname)
  const isLocal = lower === 'localhost' || lower.endsWith('.localhost')
  const hasPort = /:\d+$/.test(authority)
  const scheme = isIpv4 || isIpv6 || isLocal || hasPort ? 'http' : 'https'
  return `${scheme}://${body}`
}

/** Validate and normalize a gateway root URL. */
export function normalizeBaseUrl(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new NewApiError('CONFIG_INVALID', 'baseUrl 为空', {
      hint: '请提供网关根地址，例如 192.0.2.10:3000 或 https://api.example.com（不要带 /v1 或 /api）。',
    })
  }
  let url
  try {
    url = new URL(withDefaultScheme(input.trim()))
  } catch {
    throw new NewApiError('CONFIG_INVALID', `baseUrl 不是合法的 URL：${input}`, {
      hint: '示例：192.0.2.10:3000、http://10.0.0.8:8080、https://api.example.com；只支持 http/https。',
    })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NewApiError('CONFIG_INVALID', `baseUrl 只支持 http/https，当前为 ${url.protocol}`, {
      hint: '请使用 https:// 或 http:// 开头的网关地址。',
    })
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new NewApiError('CONFIG_INVALID', 'baseUrl 不能包含用户名或密码', {
      hint: '凭据应通过 scripts/dsh-newapi.mjs 单独录入，不要写进 URL。',
    })
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new NewApiError('CONFIG_INVALID', 'baseUrl 不能包含查询参数或锚点', {
      hint: '只填写站点根地址，例如 192.0.2.10:3000。',
    })
  }
  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/(v1|v1beta|api)$/, '')
  url.pathname = path === '' ? '/' : path
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
