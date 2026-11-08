/**
 * dsh-plugin-newapi — Web half.
 *
 * Settings → New API: the gateway address, the user id the management API
 * needs, and the two credentials. Everything is written through this plugin's
 * loopback route to the same `site.json` and encrypted credential store the
 * tools and CLI read, so there is no second source of truth.
 *
 * The page never receives a saved secret back from the Host: it only knows
 * whether a credential is available, missing, or unusable.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-newapi',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const ENDPOINT = '/newapi'
    const UI_HEADER = 'x-newapi-ui'

    const COPY = {
      zh: {
        title: 'New API 网关',
        nav: 'New API',
        subtitle: '管理 Agent 调用 New API 时使用的网关地址与凭据。保存后立即生效，不需要重启。',
        loading: '正在读取配置…',
        loadFailed: '读取配置失败',
        retry: '重试',
        gateway: '网关地址',
        gatewayHint: '可只填 IP:端口，如 192.0.2.10:3000（默认 http://）；公网域名默认 https://；会自动去掉 /v1 与 /api。',
        userId: '用户 ID',
        userIdHint: '管理接口的 New-Api-User 请求头；root 账号通常为 1。',
        connection: '连接',
        credentials: '凭据',
        credentialsHint: '密钥只保存在本机，不会进入对话记录，也不会写进插件配置。',
        apiKey: 'AI 密钥',
        apiKeyHint: 'sk- 开头，用于 /v1 推理接口。',
        accessToken: '系统访问令牌',
        accessTokenHint: '用于 /api 管理接口，需要 Admin 或 Root 账号。',
        available: '已配置',
        missing: '未配置',
        unavailable: '不可用',
        save: '保存',
        saving: '保存中…',
        savedSite: '网关设置已保存。',
        savedCredential: '凭据已保存。',
        cleared: '凭据已清除。',
        clear: '清除',
        confirmClear: '再点一次清除',
        test: '测试连接',
        testing: '测试中…',
        testTitle: '连接自检',
        testHint: '会依次检查公开状态、管理令牌和 AI 密钥；只发起只读请求。',
        reachable: '网关可达',
        unreachable: '网关不可达',
        authManagement: '管理接口',
        authAi: 'AI 接口',
        statusOk: '正常',
        statusFailed: '失败',
        statusSkipped: '跳过',
        statusMissing: '未配置',
        statusNone: '未执行',
        currentUser: '当前用户',
        quota: '额度',
        dataDir: '数据目录',
        footer: '也可以在本机运行 scripts/dsh-newapi.mjs 录入同样的配置；两处写入的是同一份文件。',
        secretPlaceholder: '粘贴后保存；已保存的值不会回显',
        unsaved: '有未保存的修改',
        gatewayUnset: '未配置网关',
        gatewaySet: '已配置网关',
      },
      en: {
        title: 'New API gateway',
        nav: 'New API',
        subtitle: 'The gateway address and credentials the agent uses for New API. Saved changes apply immediately.',
        loading: 'Reading configuration…',
        loadFailed: 'Could not read the configuration',
        retry: 'Retry',
        gateway: 'Gateway URL',
        gatewayHint: 'A bare IP:port such as 192.0.2.10:3000 works (defaults to http://); public hostnames default to https://. /v1 and /api are stripped.',
        userId: 'User ID',
        userIdHint: 'The New-Api-User header for the management API; root accounts are usually 1.',
        connection: 'Connection',
        credentials: 'Credentials',
        credentialsHint: 'Secrets stay on this machine: never in the transcript, never in plugin configuration.',
        apiKey: 'API key',
        apiKeyHint: 'Starts with sk- and is used for /v1 inference.',
        accessToken: 'System access token',
        accessTokenHint: 'Used for the /api management surface; it needs an Admin or Root account.',
        available: 'Configured',
        missing: 'Missing',
        unavailable: 'Unavailable',
        save: 'Save',
        saving: 'Saving…',
        savedSite: 'Gateway settings saved.',
        savedCredential: 'Credential saved.',
        cleared: 'Credential cleared.',
        clear: 'Clear',
        confirmClear: 'Click again to clear',
        test: 'Test connection',
        testing: 'Testing…',
        testTitle: 'Connection check',
        testHint: 'Checks the public status, the management token, and the API key with read-only requests.',
        reachable: 'Gateway reachable',
        unreachable: 'Gateway unreachable',
        authManagement: 'Management',
        authAi: 'AI',
        statusOk: 'ok',
        statusFailed: 'failed',
        statusSkipped: 'skipped',
        statusMissing: 'missing',
        statusNone: 'not run',
        currentUser: 'Signed in as',
        quota: 'Quota',
        dataDir: 'Data directory',
        footer: 'The same configuration can be written locally with scripts/dsh-newapi.mjs; both paths share these files.',
        secretPlaceholder: 'Paste and save; a saved value is never shown again',
        unsaved: 'Unsaved changes',
        gatewayUnset: 'No gateway',
        gatewaySet: 'Gateway configured',
      },
    }

    const CSS = `
.dsh-newapi-page { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
.dsh-newapi-head h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-newapi-head p { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-newapi-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 4px 16px 12px; }
.dsh-newapi-card h3 { margin: 12px 0 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-newapi-note { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-newapi-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-newapi-row:first-of-type { border-top: none; }
.dsh-newapi-label { flex: 1 1 220px; min-width: 0; }
.dsh-newapi-label b { display: block; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-newapi-label span { display: block; margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-newapi-control { flex: 0 1 320px; min-width: 220px; display: flex; flex-direction: column; gap: 8px; }
.dsh-newapi-input { width: 100%; box-sizing: border-box; padding: 6px 10px; font-size: 13px; line-height: 20px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); outline: none; font-family: inherit; }
.dsh-newapi-input::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-newapi-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-newapi-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.dsh-newapi-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-newapi-button { border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 16px; padding: 5px 12px; cursor: pointer; font-family: inherit; }
.dsh-newapi-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-newapi-button:disabled { cursor: default; opacity: 0.55; }
.dsh-newapi-button--primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-newapi-button--danger { border-color: transparent; color: var(--dsw-alias-state-error-primary); padding-left: 4px; padding-right: 4px; }
.dsh-newapi-button--danger:hover:not(:disabled) { background: transparent; text-decoration: underline; }
.dsh-newapi-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-newapi-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.dsh-newapi-pill--ok { color: var(--dsw-alias-state-success-primary); }
.dsh-newapi-pill--warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-newapi-pill--error { color: var(--dsw-alias-state-error-primary); }
.dsh-newapi-summary { display: flex; flex-wrap: wrap; gap: 16px; padding: 12px 0 0; }
.dsh-newapi-message { font-size: 12px; line-height: 18px; }
.dsh-newapi-message--error { color: var(--dsw-alias-state-error-primary); }
.dsh-newapi-message--ok { color: var(--dsw-alias-state-success-primary); }
.dsh-newapi-foot { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-newapi-test { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-newapi-test b { color: var(--dsw-alias-label-primary); font-weight: 500; }
`

    function useCopy(ctx) {
      const locale = ctx?.locale
      const subscribe = React.useCallback(
        (listener) => (locale === undefined ? () => {} : locale.subscribe(listener)),
        [locale],
      )
      const getSnapshot = React.useCallback(() => locale?.getSnapshot(), [locale])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const active = String(snapshot?.active ?? '').toLowerCase()
      return active.startsWith('zh') ? COPY.zh : COPY.en
    }

    /** Last resort: a thrown render shows a readable line instead of a blank pane. */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { message: null }
      }

      static getDerivedStateFromError(error) {
        return { message: error instanceof Error ? error.message : String(error) }
      }

      componentDidCatch() {
        // The shell owns error reporting; this only keeps the pane readable.
      }

      render() {
        if (this.state.message !== null) {
          return h(
            'div',
            { className: 'dsh-newapi-page' },
            h(
              'div',
              { className: 'dsh-newapi-card' },
              h('h3', null, 'New API'),
              h(
                'p',
                { className: 'dsh-newapi-note dsh-newapi-message dsh-newapi-message--error', role: 'alert' },
                `New API 设置页渲染失败（render failed）：${this.state.message}`,
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    async function call(path, options = {}) {
      const body = options.body
      const response = await fetch(`${ENDPOINT}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json', [UI_HEADER]: '1' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const error = payload?.error ?? {}
        const reason = typeof error.message === 'string' && error.message.length > 0 ? error.message : `HTTP ${response.status}`
        const failure = new Error(reason)
        failure.hint = typeof error.hint === 'string' ? error.hint : null
        throw failure
      }
      return payload
    }

    function pill(copy, status) {
      const map = {
        available: { text: copy.available, kind: 'ok' },
        missing: { text: copy.missing, kind: 'warn' },
        unavailable: { text: copy.unavailable, kind: 'error' },
      }
      const entry = map[status] ?? map.missing
      return h(
        'span',
        { className: `dsh-newapi-pill dsh-newapi-pill--${entry.kind}` },
        h('span', { className: 'dsh-newapi-dot', 'aria-hidden': true }),
        entry.text,
      )
    }

    function authLabel(copy, status) {
      return {
        ok: copy.statusOk,
        failed: copy.statusFailed,
        skipped: copy.statusSkipped,
        missing: copy.statusMissing,
      }[status] ?? copy.statusNone
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dsh-newapi-row' },
        h(
          'div',
          { className: 'dsh-newapi-label' },
          h('b', null, props.label),
          props.hint !== undefined ? h('span', null, props.hint) : null,
        ),
        h('div', { className: 'dsh-newapi-control' }, props.children),
      )
    }

    function Field(props) {
      return h(
        Row,
        { label: props.label, hint: props.hint },
        h('input', {
          id: props.id,
          className: 'dsh-newapi-input',
          type: props.type ?? 'text',
          value: props.value,
          placeholder: props.placeholder,
          autoComplete: props.autoComplete ?? 'off',
          spellCheck: false,
          disabled: props.disabled,
          'aria-label': props.label,
          'aria-invalid': props.invalid === true ? 'true' : undefined,
          onChange: (event) => props.onChange(event.target.value),
        }),
        props.children,
      )
    }

    function Notice(props) {
      if (props.message === null) return null
      return h(
        'div',
        {
          className: `dsh-newapi-message ${props.kind === 'error' ? 'dsh-newapi-message--error' : 'dsh-newapi-message--ok'}`,
          role: props.kind === 'error' ? 'alert' : 'status',
        },
        props.message,
      )
    }

    function SettingsPage(props) {
      const ctx = props.ctx
      const copy = useCopy(ctx)
      const [state, setState] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [baseUrlDraft, setBaseUrlDraft] = React.useState('')
      const [userIdDraft, setUserIdDraft] = React.useState('')
      const [apiKeyDraft, setApiKeyDraft] = React.useState('')
      const [tokenDraft, setTokenDraft] = React.useState('')
      const [pending, setPending] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [check, setCheck] = React.useState(null)
      const [confirmClear, setConfirmClear] = React.useState(null)
      const serverDraft = React.useRef({ baseUrl: null, userId: null })

      const load = React.useCallback(async () => {
        try {
          const payload = await call('/state')
          setState(payload.state)
          setLoadError(null)
        } catch (failure) {
          setLoadError(failure.hint !== null ? `${failure.message}（${failure.hint}）` : failure.message)
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        if (state === null) return
        if (serverDraft.current.baseUrl !== state.baseUrl) {
          serverDraft.current.baseUrl = state.baseUrl
          setBaseUrlDraft(state.baseUrl)
        }
        if (serverDraft.current.userId !== state.userId) {
          serverDraft.current.userId = state.userId
          setUserIdDraft(state.userId)
        }
      }, [state])

      const run = async (key, action, success) => {
        if (pending !== null) return false
        setPending(key)
        setError(null)
        setMessage(null)
        setConfirmClear(null)
        try {
          const outcome = await action()
          if (outcome.state !== undefined) setState(outcome.state)
          if (outcome.check !== undefined) setCheck(outcome.check)
          if (success !== null) setMessage(success)
          return true
        } catch (failure) {
          setError(failure.hint !== null ? `${failure.message}（${failure.hint}）` : failure.message)
          return false
        } finally {
          setPending(null)
        }
      }

      const dirty = state !== null && (baseUrlDraft !== state.baseUrl || userIdDraft !== state.userId)

      const saveSite = () =>
        run(
          'site',
          () => call('/site', { body: { baseUrl: baseUrlDraft, userId: userIdDraft } }),
          copy.savedSite,
        )

      const saveCredential = async (field, value) => {
        if (value.trim().length === 0) return
        const ok = await run(field, () => call('/credential', { body: { field, value } }), copy.savedCredential)
        if (!ok) return
        if (field === 'apiKey') setApiKeyDraft('')
        else setTokenDraft('')
      }

      const clearCredential = (field) => {
        if (confirmClear !== field) {
          setConfirmClear(field)
          return Promise.resolve()
        }
        return run(
          `${field}-clear`,
          () => call('/credential', { body: { field, clear: true } }),
          copy.cleared,
        )
      }

      const runCheck = () => run('test', () => call('/test', { body: {} }), null)

      const busy = (key) => pending === key
      const anyBusy = pending !== null

      if (state === null) {
        return h(
          React.Fragment,
          null,
          h('style', null, CSS),
          h(
            'div',
            { className: 'dsh-newapi-page' },
            h(
              'div',
              { className: 'dsh-newapi-head' },
              h('h2', null, copy.title),
              h('p', null, copy.subtitle),
            ),
            h(
              'div',
              { className: 'dsh-newapi-card' },
              h('p', { className: 'dsh-newapi-note' }, loadError !== null ? `${copy.loadFailed}：${loadError}` : copy.loading),
              loadError !== null
                ? h(
                    'div',
                    { className: 'dsh-newapi-actions', style: { paddingTop: 8 } },
                    h(
                      'button',
                      { type: 'button', className: 'dsh-newapi-button', onClick: () => void load() },
                      copy.retry,
                    ),
                  )
                : null,
            ),
          ),
        )
      }

      const credentials = state.credentials
      const gatewayPill = state.configured
        ? h('span', { className: 'dsh-newapi-pill dsh-newapi-pill--ok' }, h('span', { className: 'dsh-newapi-dot', 'aria-hidden': true }), copy.gatewaySet)
        : h('span', { className: 'dsh-newapi-pill dsh-newapi-pill--warn' }, h('span', { className: 'dsh-newapi-dot', 'aria-hidden': true }), copy.gatewayUnset)

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsh-newapi-page' },
          h(
            'div',
            { className: 'dsh-newapi-head' },
            h('h2', null, copy.title),
            h('p', null, copy.subtitle),
          ),
          h(
            'div',
            { className: 'dsh-newapi-summary' },
            gatewayPill,
            h('span', { className: 'dsh-newapi-pill' }, copy.apiKey, ' ', pill(copy, credentials.apiKey)),
            h('span', { className: 'dsh-newapi-pill' }, copy.accessToken, ' ', pill(copy, credentials.accessToken)),
          ),
          h(Notice, { message: error, kind: 'error' }),
          h(Notice, { message: message, kind: 'ok' }),

          h(
            'section',
            { className: 'dsh-newapi-card' },
            h('h3', null, copy.connection),
            h(Field, {
              id: 'newapi-base-url',
              label: copy.gateway,
              hint: copy.gatewayHint,
              value: baseUrlDraft,
              placeholder: '192.0.2.10:3000',
              disabled: anyBusy,
              onChange: (next) => {
                setBaseUrlDraft(next)
                setMessage(null)
              },
            }),
            h(Field, {
              id: 'newapi-user-id',
              label: copy.userId,
              hint: copy.userIdHint,
              value: userIdDraft,
              placeholder: '1',
              disabled: anyBusy,
              onChange: (next) => {
                setUserIdDraft(next)
                setMessage(null)
              },
            }),
            h(
              'div',
              { className: 'dsh-newapi-actions', style: { paddingTop: 8 } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-newapi-button dsh-newapi-button--primary',
                  disabled: anyBusy || !dirty,
                  onClick: () => void saveSite(),
                },
                busy('site') ? copy.saving : copy.save,
              ),
              dirty ? h('span', { className: 'dsh-newapi-note' }, copy.unsaved) : null,
            ),
          ),

          h(
            'section',
            { className: 'dsh-newapi-card' },
            h('h3', null, copy.credentials),
            h('p', { className: 'dsh-newapi-note' }, copy.credentialsHint),
            h(
              Row,
              { label: copy.apiKey, hint: copy.apiKeyHint },
              h('div', { className: 'dsh-newapi-actions' }, pill(copy, credentials.apiKey)),
              h('input', {
                id: 'newapi-api-key',
                className: 'dsh-newapi-input',
                type: 'password',
                value: apiKeyDraft,
                placeholder: copy.secretPlaceholder,
                autoComplete: 'off',
                spellCheck: false,
                disabled: anyBusy,
                'aria-label': copy.apiKey,
                onChange: (event) => {
                  setApiKeyDraft(event.target.value)
                  setMessage(null)
                },
              }),
              h(
                'div',
                { className: 'dsh-newapi-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-newapi-button dsh-newapi-button--primary',
                    disabled: anyBusy || apiKeyDraft.trim().length === 0,
                    onClick: () => void saveCredential('apiKey', apiKeyDraft),
                  },
                  busy('apiKey') ? copy.saving : copy.save,
                ),
                credentials.apiKey !== 'missing'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-newapi-button dsh-newapi-button--danger',
                        disabled: anyBusy,
                        onClick: () => void clearCredential('apiKey'),
                      },
                      confirmClear === 'apiKey' ? copy.confirmClear : copy.clear,
                    )
                  : null,
              ),
            ),
            h(
              Row,
              { label: copy.accessToken, hint: copy.accessTokenHint },
              h('div', { className: 'dsh-newapi-actions' }, pill(copy, credentials.accessToken)),
              h('input', {
                id: 'newapi-access-token',
                className: 'dsh-newapi-input',
                type: 'password',
                value: tokenDraft,
                placeholder: copy.secretPlaceholder,
                autoComplete: 'off',
                spellCheck: false,
                disabled: anyBusy,
                'aria-label': copy.accessToken,
                onChange: (event) => {
                  setTokenDraft(event.target.value)
                  setMessage(null)
                },
              }),
              h(
                'div',
                { className: 'dsh-newapi-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-newapi-button dsh-newapi-button--primary',
                    disabled: anyBusy || tokenDraft.trim().length === 0,
                    onClick: () => void saveCredential('accessToken', tokenDraft),
                  },
                  busy('accessToken') ? copy.saving : copy.save,
                ),
                credentials.accessToken !== 'missing'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-newapi-button dsh-newapi-button--danger',
                        disabled: anyBusy,
                        onClick: () => void clearCredential('accessToken'),
                      },
                      confirmClear === 'accessToken' ? copy.confirmClear : copy.clear,
                    )
                  : null,
              ),
            ),
          ),

          h(
            'section',
            { className: 'dsh-newapi-card' },
            h('h3', null, copy.testTitle),
            h('p', { className: 'dsh-newapi-note' }, copy.testHint),
            h(
              'div',
              { className: 'dsh-newapi-actions', style: { paddingTop: 8 } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-newapi-button',
                  disabled: anyBusy || !state.configured,
                  onClick: () => void runCheck(),
                },
                busy('test') ? copy.testing : copy.test,
              ),
            ),
            check === null
              ? null
              : h(
                  'div',
                  { className: 'dsh-newapi-test', role: 'status' },
                  h(
                    'div',
                    null,
                    h(
                      'span',
                      {
                        className: `dsh-newapi-pill dsh-newapi-pill--${check.reachable ? 'ok' : 'error'}`,
                      },
                      h('span', { className: 'dsh-newapi-dot', 'aria-hidden': true }),
                      check.reachable ? copy.reachable : copy.unreachable,
                    ),
                    check.site !== null && check.site.systemName !== null
                      ? h('span', null, `  ${check.site.systemName}${check.site.version ? `  v${check.site.version}` : ''}`)
                      : null,
                  ),
                  h(
                    'div',
                    null,
                    h('b', null, `${copy.authManagement}: `),
                    authLabel(copy, check.auth.management.status),
                    check.auth.management.message !== null ? ` — ${check.auth.management.message}` : '',
                  ),
                  h(
                    'div',
                    null,
                    h('b', null, `${copy.authAi}: `),
                    authLabel(copy, check.auth.ai.status),
                    check.auth.ai.message !== null ? ` — ${check.auth.ai.message}` : '',
                    check.auth.ai.modelCount !== null ? ` (${check.auth.ai.modelCount})` : '',
                  ),
                  check.user !== null
                    ? h(
                        'div',
                        null,
                        h('b', null, `${copy.currentUser}: `),
                        `${check.user.username ?? check.user.displayName ?? '—'} · ${copy.quota} ${check.user.quota ?? '—'}`,
                      )
                    : null,
                  check.error !== null
                    ? h(
                        'div',
                        { className: 'dsh-newapi-message dsh-newapi-message--error' },
                        `[${check.error.code}] ${check.error.message}${check.error.hint ? ` — ${check.error.hint}` : ''}`,
                      )
                    : null,
                ),
          ),

          state.dataDir
            ? h('div', { className: 'dsh-newapi-foot' }, `${copy.dataDir}: ${state.dataDir}`)
            : null,
          h('div', { className: 'dsh-newapi-foot' }, copy.footer),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'newapi',
            order: 26,
            label: () => {
              const active = String(ctx?.locale?.getSnapshot?.()?.active ?? '').toLowerCase()
              return active.startsWith('zh') ? COPY.zh.nav : COPY.en.nav
            },
          },
          function NewApiSettingsPage() {
            return h(PageBoundary, null, h(SettingsPage, { ctx }))
          },
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
