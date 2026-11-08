/** Deliver a newly created token without putting it in the session transcript. */

import { join } from 'node:path'
import { createFileExclusive, ensureDir } from './fs-util.js'
import { NewApiError } from './errors.js'

function safeName(value) {
  return String(value ?? 'token')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'token'
}

/**
 * Write `sk-...` plus delivery metadata into a 0600 file under the plugin data
 * directory. Returns the absolute path, never the key.
 */
export async function writeIssuedToken(options) {
  const dir = options.dir
  await ensureDir(dir, 0o700)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `token-${safeName(options.id)}-${stamp}-${safeName(options.name)}`
  const body = [
    '# New API token (plaintext, handle as a secret)',
    `# name: ${options.name}`,
    `# id: ${options.id ?? 'unknown'}`,
    `# site: ${options.baseUrl}`,
    `# created: ${new Date().toISOString()}`,
    '# Delete this file after handing the key to its application.',
    '',
    options.key,
    '',
  ].join('\n')

  for (let attempt = 0; attempt < 20; attempt++) {
    const file = join(dir, attempt === 0 ? `${base}.txt` : `${base}-${attempt}.txt`)
    try {
      await createFileExclusive(file, body, 0o600)
      return file
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw new NewApiError('TOKEN_FILE_FAILED', `无法写入令牌文件：${file}`, {
        hint: '请检查数据目录权限，或改用 delivery="inline"（会进入会话记录，不推荐）。',
        cause: error,
      })
    }
  }
  throw new NewApiError('TOKEN_FILE_FAILED', '无法生成不重复的令牌文件名', {
    hint: '请清理数据目录 issued/ 下的旧文件后重试。',
  })
}
