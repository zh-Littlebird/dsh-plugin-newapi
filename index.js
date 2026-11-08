/**
 * dsh-plugin-newapi — New API gateway tools and settings page.
 *
 * Nine tools cover the site entry (`newapi_site`) and the operations behind a
 * configured gateway: models, chat, embeddings, tokens, channels, logs, system
 * options, and a raw escape hatch. Tools that need a gateway are registered
 * with a `when` condition, so an unconfigured install only exposes the setup
 * tool instead of nine unusable ones.
 *
 * The Web half (Settings → New API) writes through a loopback route to the same
 * `site.json` and encrypted credential store the tools and CLI read.
 *
 * Credentials stay outside tool arguments and out of the transcript. All state
 * lives under `$DSH_HOME/newapi` (site.json, encrypted credentials, audit.log,
 * issued/).
 */

import { createRuntime } from './lib/config.js'
import { AuditLog } from './lib/audit.js'
import { HttpTransport } from './lib/http.js'
import { AiClient } from './lib/ai.js'
import { AdminClient } from './lib/admin.js'
import { createDebug } from './lib/tools/common.js'
import { registerSiteTool } from './lib/tools/site.js'
import { registerModelsTool } from './lib/tools/models.js'
import { registerChatTool } from './lib/tools/chat.js'
import { registerEmbedTool } from './lib/tools/embeddings.js'
import { registerTokensTool } from './lib/tools/tokens.js'
import { registerChannelsTool } from './lib/tools/channels.js'
import { registerLogsTool } from './lib/tools/logs.js'
import { registerOptionsTool } from './lib/tools/options.js'
import { registerRawTool } from './lib/tools/raw.js'
import { mountSettingsRoute } from './lib/settings-route.js'

export const name = 'newapi'

/** The tool registry is the only required service; `webServer` is optional. */
export const inject = ['tools']

/**
 * Build the per-mount dependencies. Exported so the settings-route test can
 * drive the same object the Host hands to the tools and the browser route.
 *
 * @param {{runtime: ReturnType<typeof createRuntime>, debug?: Function, audit?: {append: Function}}} options
 */
export function createDeps(options) {
  const { runtime } = options
  const debug = typeof options.debug === 'function' ? options.debug : () => {}
  const audit = options.audit ?? { append() {} }

  return {
    runtime,
    debug,
    audit,
    /** Resolve settings and build clients for one invocation. */
    async context(contextOptions = {}) {
      const settings = await runtime.resolveSettings(contextOptions)
      const transport = new HttpTransport({ settings, debug })
      return {
        settings,
        transport,
        ai: new AiClient({ settings, transport, debug }),
        admin: new AdminClient({ settings, transport, debug }),
      }
    },
    /** Append one redacted audit record; never includes bodies or query strings. */
    record(tool, entry) {
      audit.append({ tool, ...entry })
    },
  }
}

/**
 * Mount the New API tools and settings route.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown> | undefined} rawConfig
 */
export function apply(ctx, rawConfig) {
  const runtime = createRuntime(rawConfig)
  const debug = createDebug(runtime.config.debug)
  const audit = new AuditLog({
    dataDir: runtime.dataDir,
    enabled: runtime.config.audit,
    debug,
  })
  const deps = createDeps({ runtime, debug, audit })

  // Only the site tool is always callable; it is what configures the rest.
  registerSiteTool(ctx, deps)

  // Resolve the gateway once per step for the remaining registrations: when no
  // baseUrl is configured they stay hidden instead of costing prompt space and
  // returning CONFIG_MISSING on every call.
  const needsGateway = {
    when: () => runtime.isConfigured(),
  }

  registerModelsTool(ctx, deps, needsGateway)
  registerChatTool(ctx, deps, needsGateway)
  registerEmbedTool(ctx, deps, needsGateway)
  registerTokensTool(ctx, deps, needsGateway)
  registerChannelsTool(ctx, deps, needsGateway)
  registerLogsTool(ctx, deps, needsGateway)
  registerOptionsTool(ctx, deps, needsGateway)
  registerRawTool(ctx, deps, needsGateway)

  // Settings → New API lives in the Web UI; it writes the same site.json and
  // encrypted credential store the tools and CLI read, so all three stay one
  // source of truth.
  mountSettingsRoute(ctx, deps)

  // There are no sockets or timers to close; flush queued audit writes.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void audit.flush()
    })
  }
  debug(`mounted with dataDir=${runtime.dataDir} backend=${runtime.config.secretsBackend}`)
}
