# dsh-plugin-newapi

把 [New API](https://github.com/QuantumNous/new-api) 网关的常用操作做成 DeepSeek Harness（DSH）的一等工具：站点自检、模型列表、对话、向量、令牌、渠道、日志、系统设置，以及一个覆盖全部端点族的通用调用入口。

- **9 个工具 + 设置页**：Host 半暴露工具，Web 半在 `设置 → New API` 注册一个页面，读写同一份 `site.json` 与加密凭据库；两边共用一套自检实现。
- **9 个工具，按资源组织**：令牌与渠道的增删查改为单个工具内的 `action`，站点配置/自检/额度合并为 `newapi_site`。
- **未配置就不占位**：没有 baseUrl 时只有 `newapi_site` 注册，其余 8 个工具通过 `when` 条件隐藏，避免每个会话都为不可用的工具付上下文成本。
- **Host-only bundle**：通过 `dsh.bundle.patch` 安装，不改 Harness 核心源码，也没有前端构建步骤。
- **零运行时依赖**：只用 Node.js 标准库；不依赖 `@deepseek-ai/*` 包，安装时不需要联网拉依赖。
- **两套认证严格分开**：`/v1/*` 只用 `sk-` 密钥；`/api/*` 只用系统访问令牌 + `New-Api-User`。`sk-` 密钥不会被发送到管理接口。
- **凭据不进入工具参数**：AI 密钥和访问令牌由用户在本机用 CLI 录入，加密存放在 `$DSH_HOME/newapi/credentials.json`；模型只能看到“已配置/缺失”。
- **所有出口统一脱敏**：令牌 key、渠道 key、`api_key`、`access_token`、`password` 等字段在返回前掩码；审计日志不记录请求体。

---

## 1. 安装

### 1.1 前置条件

- DeepSeek Harness `0.2.2-rc.1` 或同系列 `0.2.x`（`engines.dsh: >=0.2.2-rc.1 <0.3.0`）
- Node.js `>= 22.19`（推荐 24）
- 一个可访问的 New API 站点；管理接口需要 Admin/Root 账号的系统访问令牌

### 1.2 安装到 profile

```powershell
# 从 npm 安装进 desktop profile（也可以传本地目录绝对路径，pnpm 会建立 link）
dsh plugin --profile desktop add dsh-plugin-newapi

# 确认 bundle 层出现
dsh --profile desktop --dump-config | Select-String newapi
```

也可以在 Web 的 **Plugins** 页面点击安装，或让 Agent 调用 `plugin_manager` 的 `install_bundle`，`target` 传包名 `dsh-plugin-newapi` 或本地目录绝对路径。

安装/更新 Host 插件后需要重启 Harness 进程，新的 `newapi_*` 工具才会出现在模型中。

---

## 2. 配置

### 2.1 用 CLI 写入站点与凭据（推荐）

在**自己的终端**里运行，不要在对话里把密钥发给模型：

```powershell
cd "dsh-plugin-newapi"

# 1) 站点根地址（不要带 /v1 或 /api；脚本会自动去掉）
node scripts/dsh-newapi.mjs setup --base-url 192.0.2.10:3000 --user-id 1

# 2) AI 接口密钥（sk- 开头，隐藏输入）
node scripts/dsh-newapi.mjs set --api-key

# 3) 管理接口系统访问令牌（个人设置 → 安全 → 系统访问令牌）
node scripts/dsh-newapi.mjs set --access-token

# 4) 查看状态（只显示 available/missing，不显示值）
node scripts/dsh-newapi.mjs status
```

脚本化场景可以用 `--env NAME` 从环境变量读入，或 `--stdin` 从标准输入读入（避免命令行历史泄露明文）：

```powershell
$env:NEWAPI_KEY_INPUT = "sk-..."
node scripts/dsh-newapi.mjs set --api-key --env NEWAPI_KEY_INPUT
Remove-Item Env:NEWAPI_KEY_INPUT
```

数据默认放在：

```
$DSH_HOME/newapi/
├── site.json          # baseUrl + userId（非机密）
├── credentials.json   # AES-256-GCM 加密的 apiKey / accessToken
├── master.key         # 32 字节随机主密钥（0600，best effort）
├── audit.log          # 每次工具调用的动作/路径/状态，无请求体
└── issued/            # 新建令牌时写入的一次性明文密钥文件（0600）
```

可用 `--data-dir <DIR>` 或环境变量 `DSH_NEWAPI_DATA_DIR` 改数据目录。

### 2.2 环境变量方式

也可以完全不落盘，把密钥放进 Harness 进程的环境变量：

```powershell
$env:NEWAPI_BASE_URL = "https://api.example.com"
$env:NEWAPI_API_KEY = "sk-..."
$env:NEWAPI_ACCESS_TOKEN = "..."
$env:NEWAPI_USER_ID = "1"
```

`secretsBackend=auto` 时环境变量优先于加密文件；`env` 只用环境变量；`file` 只用加密文件；`none` 禁用全部凭据。

### 2.3 插件配置项

`cordis.patch.yml` 里的默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `""` | 网关根地址；留空时读 `NEWAPI_BASE_URL` 或 `site.json` |
| `userId` | 留空 → 环境变量/`site.json` → `1` | 管理接口的 `New-Api-User`；root 通常为 1。留空时允许 CLI 的 `setup --user-id` 生效 |
| `apiKeyEnv` | `NEWAPI_API_KEY` | AI 密钥的环境变量名 |
| `accessTokenEnv` | `NEWAPI_ACCESS_TOKEN` | 系统访问令牌的环境变量名 |
| `secretsBackend` | `auto` | `auto` / `env` / `file` / `none` |
| `timeoutMs` | `120000` | 默认请求超时 |
| `maxResponseBytes` | `8388608` | 单次响应读取上限（8 MB） |
| `allowManagementWrites` | `true` | 是否允许 `newapi_raw` 执行管理写操作 |
| `audit` | `true` | 是否写 `audit.log` |
| `debug` | `false` | 是否输出脱敏诊断日志到 stderr |

优先级：显式插件配置 > 环境变量 > `site.json`。

### 2.4 Web 设置页

在 Web GUI 打开 **设置 → New API**，可以不做命令行就完成同样的配置：

- **网关地址 / 用户 ID**：写入 `$DSH_HOME/newapi/site.json`，与 `scripts/dsh-newapi.mjs setup` 等价；

  地址支持三种写法，缺协议时按主机形态补默认值：

  | 输入 | 规范化结果 | 说明 |
  |---|---|---|
  | `192.0.2.10:3000` | `http://192.0.2.10:3000` | IP 字面量默认 http |
  | `localhost:3000` / `[::1]:3000` | `http://localhost:3000` / `http://[::1]:3000` | 本机地址默认 http |
  | `api.example.com` | `https://api.example.com` | 公网域名默认 https |
  | `api.example.com:8443` | `http://api.example.com:8443` | 带端口默认 http |
  | `https://api.example.com` | 原样 | 显式协议永远优先 |

  末尾的 `/`、`/v1`、`/v1beta`、`/api` 会被自动去掉；URL 里不允许带用户名口令、查询参数或锚点。
- **AI 密钥 / 系统访问令牌**：写入同一个加密凭据库；页面只显示「已配置 / 未配置 / 不可用」，保存后不再回显，读取接口也不会返回明文；
- **测试连接**：与 `newapi_site action="test"` 调用同一个自检实现（公开状态 → 管理令牌 → AI 密钥）；
- **清除**：删除对应凭据，需要点两次确认。

设置页通过插件自有的回环前缀路由 `/newapi` 与宿主通信：只接受 `127.0.0.1` / `::1` 的请求，写操作额外要求设置页专用请求头。没有浏览器的 headless 部署不会注册该路由，工具与 CLI 照常可用。

---

## 3. 工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `newapi_site` | 站点入口（唯一始终注册）：查看/写入站点与 userId、自检连通性与两套认证、查账户额度 | `action=show\|set\|test\|quota`, `baseUrl`, `userId` |
| `newapi_models` | 列出网关实际暴露的模型 | `format=openai\|anthropic\|gemini` |
| `newapi_chat` | 调用 `/v1/chat/completions`，可聚合 SSE | `model`, `messages`, `stream`, `extra` |
| `newapi_embed` | 调用 `/v1/embeddings` | `model`, `input` |
| `newapi_tokens` | 令牌列表/搜索、创建（一次性交付）、删除 | `action=list\|create\|delete` |
| `newapi_channels` | 渠道列表/搜索（key 掩码）、连通性测试（Admin） | `action=list\|test`, `id` |
| `newapi_logs` | 查询使用日志 + quota/RPM/TPM 统计（Admin） | `startTime`, `modelName`, `channel`, `includeStat` |
| `newapi_options` | 读取系统设置（Root），可按 key 过滤 | `keys`, `maxValueLength` |
| `newapi_raw` | 任意 `/api/*` 或 `/v1/*` 请求；写操作需确认 | `api`, `method`, `path`, `query`, `body`, `confirm` |

**条件注册**：没有配置 baseUrl 时，除 `newapi_site` 外的 8 个工具不注册；`newapi_site action="set"` 写入网关后，下一步它们会自动出现。这样未配置的会话只承担一个工具定义的上下文成本。

### 3.1 典型流程

```text
newapi_site { action: "test" }
  → 网关可达？管理令牌有效？AI 密钥能列模型？
newapi_models
  → 确认模型名（不要猜 gpt-4o / openai/gpt-4o 的差异）
newapi_chat { model: "gpt-4o-mini", messages: [...] }
  → 网关联调或模型对比
newapi_tokens { action: "list", keyword: "my-app" }
  → 找到旧令牌 id
newapi_tokens { action: "create", name: "my-app-v2", modelLimits: ["gpt-4o-mini"] }
  → 从返回的 keyFile 读取一次性密钥
newapi_tokens { action: "delete", id: 7, confirm: true }
  → 切换完成后删除旧令牌
```

### 3.2 新建令牌的密钥交付

`newapi_tokens action="create"` 默认 `delivery="file"`：

- 插件把完整密钥写入 `$DSH_HOME/newapi/issued/token-<id>-<时间>-<名称>.txt`，权限尽量收紧到 `0600`；
- 工具结果只返回 `keyMasked` 和 `keyFile` 路径，**完整密钥不进入会话记录**；
- 用户把文件内容交给应用后应删除文件。

`delivery="inline"` 才会把完整密钥放进工具结果，仅在用户明确要求时使用；它会进入会话历史，交付后建议轮换。

### 3.3 1.0 → 1.1 的工具映射

| 1.0 | 1.1 |
|---|---|
| `newapi_config` | `newapi_site { action: "show" \| "set" }` |
| `newapi_test` | `newapi_site { action: "test" }` |
| `newapi_balance` | `newapi_site { action: "quota" }` |
| `newapi_tokens` | `newapi_tokens { action: "list" }`（`action` 可省略） |
| `newapi_token_create` | `newapi_tokens { action: "create", ... }` |
| `newapi_token_delete` | `newapi_tokens { action: "delete", id, confirm: true }` |
| `newapi_channels` | `newapi_channels { action: "list" }`（`action` 可省略） |
| `newapi_channel_test` | `newapi_channels { action: "test", id }` |

### 3.4 `newapi_raw` 的安全边界

- 管理写操作（`POST` / `PUT` / `DELETE` / `PATCH`）必须显式 `confirm=true`，并受 `allowManagementWrites` 限制；
- `api=auto` 时，`/api/*` 用管理认证，`/v1`、`/v1beta`、`/kling`、`/jimeng`、`/pg` 用 AI 认证；
- 只接受 JSON 对象/数组作为 `body`，不处理 multipart 文件上传；
- 重定向一律拒绝，避免 `Authorization` 被转发到其他站点；
- HTTP 失败以 `ok=false` + `error` 返回，不抛异常，便于模型读取网关 message。

---

## 4. 排障

| 现象 | 含义 | 处理 |
|---|---|---|
| `CONFIG_MISSING` | 没配 baseUrl 或凭据 | 运行 `scripts/dsh-newapi.mjs setup/status`，或 `newapi_site action="show"` |
| `HTTP_401`（AI） | `sk-` 密钥无效/被禁用/过期 | 核对 `NEWAPI_API_KEY` 或重新 `set --api-key` |
| `HTTP_401`（管理） | 用了 `sk-` 密钥，或缺 `New-Api-User` | 改用系统访问令牌；确认 userId |
| `HTTP_403` | 账号不是 Admin/Root，或 userId 不匹配 | 换有权限的访问令牌 |
| `HTTP_429` / “分组负载已饱和” | 上游限流或分组饱和 | 降低并发、换分组/渠道 |
| “无可用渠道” / `model_not_found` | 用户分组、渠道分组、渠道模型不匹配 | 依次检查 `newapi_tokens` → `newapi_channels` → `newapi_models` |
| 渠道测试 `invalid character '<'` | 上游返回 HTML，常见于 Cloudflare 拦截 | 换出口或换受支持的渠道 |
| `RESPONSE_TOO_LARGE` | 单次响应超过 `maxResponseBytes` | 缩小请求（分页/减少 max_tokens）或调大配置 |
| 流式无输出 | 网关忽略 `stream` 或返回非 SSE | 插件会回退普通 JSON；用 `newapi_raw` 查看原始响应 |

quota 是站内单位，不是货币金额。`newapi_site action="quota"` 只有在站点公开 `quota_per_unit` 时才给出换算值，并明确标注货币单位由站点定义。

---

## 5. 安全模型

- **密钥只在两个地方**：环境变量，或 `$DSH_HOME/newapi/credentials.json`（AES-256-GCM + `master.key`）。`site.json`、`audit.log`、工具结果都不含密钥。
- **AES-GCM 主密钥与密文同目录**：这能防误读、备份泄露，但**不是系统钥匙串**；同一用户权限下的程序仍可解密。README 如实说明，不夸大。
- **模型永远看不到凭据**：没有工具参数接收密钥；`newapi_tokens action="create"` 的明文密钥默认写文件。
- **脱敏是最后一道闸**：`redactValue()` 递归处理 `api_key`、`access_token`、`password`、`authorization`、令牌/渠道的 `key` 等字段；已知凭据值还会在任意文本中被替换。
- **审计不含请求体**：只记录时间、工具、方法、路径、状态、耗时、错误码，避免把 prompt 或密钥写进日志。

---

## 6. 已知限制

- **单网关**：一次只配置一个 baseUrl。需要多站点时，切换 `site.json`/配置后重启调用即可；插件本身不维护站点清单。
- **设置页只接受本机请求**：`/newapi` 路由拒绝非回环来源，因此远程访问 Web GUI 时设置页会报「只允许本机访问」；此时请改用 CLI 录入。
- **条件注册在重启后生效**：工具的 `when` 条件按步求值，但插件代码本身随宿主启动加载；改动插件后仍需重启 Harness。
- **流式不实时**：`newapi_chat stream=true` 会聚合 SSE 后一次性返回，Web 卡片不会逐字输出。
- **不支持 multipart**：音频转写、图片编辑、Sora 视频上传等需要 multipart 的端点请用专门客户端；`newapi_raw` 只发 JSON。
- **不自动重试**：POST 重试可能造成重复计费；网络失败由调用方决定是否重试。
- **管理接口字段以实例为准**：New API 文档存在 schema 渲染缺失；令牌/渠道的字段名来自实例惯例。若站点版本不同，用 `newapi_raw` 先观察再调整。
- **渠道测试会产生上游费用**：`newapi_channels action="test"` 会真实请求上游，不要高频批量调用。

---

## 7. 开发与测试

```powershell
cd "dsh-plugin-newapi"
node tests/run.mjs
```

测试覆盖：

- **9 个工具 + 设置页**：Host 半暴露工具，Web 半注册 `settings.section` 页面；两者共用 `lib/self-check.js` 的自检实现。
- 9 个工具全部注册，参数/输出 schema 通过 Harness 的 JSON Schema 子集检查；
- 条件注册：未配置 baseUrl 时只有 `newapi_site` 可见，写入站点后其余 8 个恢复；
- 合并动作的必填校验（`create` 需要 name、`delete`/`test` 需要 id、`set` 需要参数）；
- 设置页路由：状态读取、站点写入、凭据写入/清除、自检，以及非回环拒绝、缺请求头拒绝、400/404/405 分支；凭据落盘不出现明文。
- 参数校验（必填、枚举、oneOf、额外字段）；
- URL 规范化、AES-GCM 凭据往返、主密钥不匹配、脱敏；
- 本地 mock New API 网关上的真实 HTTP 链路：模型列表、非流式/流式对话、向量、额度、令牌列表/创建/删除、渠道/渠道测试、日志/统计、系统设置、raw 读写与 401。

`tests/mock-server.mjs` 只监听 `127.0.0.1` 随机端口，不访问外网。

---

## 8. 兼容性

- 本插件在 DSH `0.2.2-rc.1`、Node `24.12.0`、Windows 11 上验证。
- 不导入任何 `@deepseek-ai/*` 运行时包；工具定义直接使用 Harness 接受的 JSON Schema 子集（`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解）。
- 插件只依赖全局 `fetch`、`AbortSignal.timeout`/`AbortSignal.any`（Node 22.19+）与 `node:fs`、`node:crypto`。
