#!/usr/bin/env node
/**
 * Local provisioning for dsh-plugin-newapi.
 *
 * The model never runs this script and never sees its input. Run it in your own
 * terminal:
 *
 *   node scripts/dsh-newapi.mjs setup --base-url 192.0.2.10:3000 --user-id 1
 *   node scripts/dsh-newapi.mjs set --api-key
 *   node scripts/dsh-newapi.mjs set --access-token
 *   node scripts/dsh-newapi.mjs status
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { SecretStore } from '../lib/secrets.js'
import { SiteStore, normalizeBaseUrl } from '../lib/site.js'

function dataDirFrom(option) {
  if (typeof option === 'string' && option.trim().length > 0) return resolve(option)
  const override = process.env.DSH_NEWAPI_DATA_DIR
  if (typeof override === 'string' && override.trim().length > 0) return resolve(override)
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'newapi')
}

async function promptHidden(question) {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const chunks = []
    for await (const chunk of stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  process.stdout.write(question)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  let value = ''
  return new Promise((resolvePromise, reject) => {
    const finish = (error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      if (error) reject(error)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          process.stdout.write('\n')
          finish()
          resolvePromise(value)
          return
        }
        if (char === '\u0003') {
          process.stdout.write('\n')
          finish(new Error('已取消'))
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    stdin.on('data', onData)
  })
}

async function readSecret(values, kind) {
  if (values.stdin === true) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  if (typeof values.env === 'string') {
    const value = process.env[values.env]
    if (value === undefined || value.length === 0) throw new Error(`环境变量 ${values.env} 为空`)
    return value
  }
  return promptHidden(kind === 'accessToken' ? '系统访问令牌（输入不回显）：' : 'AI 密钥 sk-...（输入不回显）：')
}

async function main() {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string' },
      'base-url': { type: 'string' },
      'user-id': { type: 'string' },
      'api-key': { type: 'boolean' },
      'access-token': { type: 'boolean' },
      stdin: { type: 'boolean' },
      env: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  const command = parsed.positionals[0] ?? 'help'
  const values = parsed.values
  const dataDir = dataDirFrom(values['data-dir'])
  const siteStore = new SiteStore({ dir: dataDir })
  const secretStore = new SecretStore({ dir: dataDir })

  if (command === 'help' || values.help === true) {
    console.log('dsh-plugin-newapi 配置工具')
    console.log('')
    console.log('  setup --base-url <地址> [--user-id <id>]   写入站点地址与用户 ID（可只写 IP:端口）')
    console.log('  set --api-key                             录入 AI 密钥（隐藏输入）')
    console.log('  set --access-token                        录入系统访问令牌（隐藏输入）')
    console.log('  status                                    查看配置与凭据状态')
    console.log('  clear --api-key | --access-token          删除凭据')
    console.log('  paths                                     打印数据目录')
    console.log('')
    console.log('通用参数：--data-dir <DIR>；set 还支持 --stdin 或 --env <NAME>（脚本化时避免命令行明文）。')
    console.log(`当前数据目录：${dataDir}`)
    return
  }

  if (command === 'setup') {
    // setup doubles as the repair path for an unreadable site.json.
    const current = await siteStore.read().catch(() => ({ baseUrl: null, userId: null }))
    const baseUrl = values['base-url'] === undefined ? current.baseUrl : normalizeBaseUrl(values['base-url'])
    if (baseUrl === null) throw new Error('缺少 --base-url；示例：--base-url 192.0.2.10:3000 或 https://api.example.com')
    const userId = values['user-id'] === undefined ? current.userId ?? '1' : values['user-id'].trim()
    if (userId.length === 0) throw new Error('--user-id 不能为空；root 通常为 1')
    const document = await siteStore.write({ baseUrl, userId })
    console.log(`已写入 ${siteStore.file}`)
    console.log(`  baseUrl: ${document.baseUrl}`)
    console.log(`  userId : ${document.userId}`)
    console.log('下一步：node scripts/dsh-newapi.mjs set --api-key；再 set --access-token。')
    return
  }

  if (command === 'status') {
    const site = await siteStore.read()
    console.log(`数据目录: ${dataDir}`)
    console.log(`站点文件: ${siteStore.file}`)
    console.log(`凭据文件: ${secretStore.credentialsFile}`)
    console.log(`baseUrl: ${site.baseUrl ?? '(未配置)'}`)
    console.log(`userId : ${site.userId ?? '(默认 1)'}`)
    console.log(`AI 密钥: ${await secretStore.status('site:apiKey')}`)
    console.log(`访问令牌: ${await secretStore.status('site:accessToken')}`)
    if (process.env.NEWAPI_API_KEY) console.log('AI 密钥: 环境变量 NEWAPI_API_KEY 已设置（优先于文件）')
    if (process.env.NEWAPI_ACCESS_TOKEN) console.log('访问令牌: 环境变量 NEWAPI_ACCESS_TOKEN 已设置（优先于文件）')
    return
  }

  if (command === 'set') {
    const kinds = []
    if (values['api-key'] === true) kinds.push({ kind: 'apiKey', ref: 'site:apiKey', label: 'AI 密钥' })
    if (values['access-token'] === true) kinds.push({ kind: 'accessToken', ref: 'site:accessToken', label: '访问令牌' })
    if (kinds.length === 0) throw new Error('请指定 --api-key 或 --access-token')
    if (kinds.length > 1 && values.stdin === true) throw new Error('--stdin 一次只能录入一种凭据')
    for (const entry of kinds) {
      const value = await readSecret(values, entry.kind)
      if (value.trim().length === 0) throw new Error(`${entry.label}为空`)
      await secretStore.set(entry.ref, value.trim())
      console.log(`已加密保存${entry.label}：${entry.ref}`)
    }
    console.log('提示：凭据已写入本机加密文件；不会进入插件配置或会话记录。')
    return
  }

  if (command === 'clear') {
    if (values['api-key'] === true) {
      console.log(`AI 密钥: ${(await secretStore.delete('site:apiKey')) ? '已删除' : '不存在'}`)
    }
    if (values['access-token'] === true) {
      console.log(`访问令牌: ${(await secretStore.delete('site:accessToken')) ? '已删除' : '不存在'}`)
    }
    if (values['api-key'] !== true && values['access-token'] !== true) {
      throw new Error('请指定 --api-key 或 --access-token')
    }
    return
  }

  if (command === 'paths') {
    console.log(`数据目录: ${dataDir}`)
    console.log(`站点文件: ${siteStore.file}`)
    console.log(`凭据文件: ${secretStore.credentialsFile}`)
    return
  }

  throw new Error(`未知命令：${command}；运行 node scripts/dsh-newapi.mjs help`)
}

main().catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
