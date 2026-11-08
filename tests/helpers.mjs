/** Test harness: mount the plugin on a minimal context and call tools. */

import assert from 'node:assert/strict'
import { apply } from '../index.js'

export function mountPlugin(config) {
  const tools = new Map()
  const registrations = new Map()
  const ctx = {
    tools: {
      register(definition, options) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        tools.set(definition.name, definition)
        registrations.set(definition.name, options ?? {})
        return () => {
          tools.delete(definition.name)
          registrations.delete(definition.name)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  apply(ctx, config)
  return { tools, ctx, registrations }
}

export async function call(tools, name, args = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  return definition.execute(args, {
    signal: new AbortController().signal,
    callId: `test-${name}`,
    deferContext() {},
    concludeTurn() {},
  })
}

export function render(tools, name, args, value) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0)
  return blocks.map((block) => block.text).join('\n')
}
