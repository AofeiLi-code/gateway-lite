# AI Gateway Lite

精简版 AI 路由网关 — 提供灰度发布、AB 测试、熔断保护三大路由策略，实际 AI 请求由下游 Go 服务处理。

## 架构

```
Client Request
      │
      ▼
┌─────────────────────────────────────────┐
│              Hono HTTP Server            │
│  POST /v1/chat/completions              │
│  POST /v1/embeddings                    │
│  POST /v1/completions                   │
└──────────────┬──────────────────────────┘
               │
               ▼
    ┌─────────────────────┐
    │  requestValidator   │  解析 x-gateway-config header
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────┐
    │  buildRequestContext│  提取 userId / model / metadata
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────────────────────┐
    │          strategyRouter             │
    │                                     │
    │  ┌──────────┐  ┌──────────────────┐ │
    │  │loadbalance│  │    fallback      │ │
    │  │ (sticky  │  │ (circuit breaker)│ │
    │  │  hash)   │  └──────────────────┘ │
    │  └──────────┘  ┌──────────────────┐ │
    │  ┌──────────┐  │   conditional    │ │
    │  │  single  │  │  (AB routing)    │ │
    │  └──────────┘  └──────────────────┘ │
    └──────────┬──────────────────────────┘
               │  Target selected
               ▼
    ┌─────────────────────┐
    │   proxyToGoService  │  转发给 Go 服务（待实现）
    └─────────────────────┘
```

## 路由策略

### Loadbalance（灰度发布）

按权重随机分配流量，可配置 `userId` 实现用户粘性（同一用户始终命中同一 target）。

- 权重为 0 的 target 永不被选中
- 使用 djb2 哈希实现无状态粘性，服务重启后粘性不变

### Fallback（熔断保护）

按 targets 数组顺序依次尝试，当某个 target 的熔断器为 OPEN 状态时自动跳过，选择下一个健康的 target。

三态熔断器：`CLOSED → OPEN → HALF_OPEN → CLOSED`

- `failureThreshold`：连续失败多少次触发熔断（默认 5）
- `resetTimeout`：熔断后多久进入半开探测（默认 30s）
- `halfOpenMax`：半开状态允许通过的最大探测请求数（默认 3）

### Conditional（AB 测试 / 条件路由）

根据请求的 `model`、`metadata` 等字段匹配规则，路由到指定 target。

支持 MongoDB 风格操作符：`$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$regex` `$and` `$or`

支持点号路径字段访问，如 `"metadata.region"`。

## 配置示例

通过请求 header `x-gateway-config` 传入 JSON 配置：

### Loadbalance — 90/10 灰度

```json
{
  "strategy": { "mode": "loadbalance" },
  "targets": [
    { "provider": "openai",  "model": "gpt-4o",      "weight": 9 },
    { "provider": "openai",  "model": "gpt-4o-mini", "weight": 1 }
  ]
}
```

### Fallback — 熔断自动降级

```json
{
  "strategy": { "mode": "fallback" },
  "targets": [
    {
      "provider": "openai",
      "model": "gpt-4o",
      "virtualKey": "key-primary",
      "cbConfig": { "failureThreshold": 5, "resetTimeout": 30000 }
    },
    {
      "provider": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "virtualKey": "key-backup"
    }
  ]
}
```

### Conditional — 按模型路由到不同 provider

```json
{
  "strategy": {
    "mode": "conditional",
    "conditions": [
      { "query": { "model": { "$in": ["gpt-4", "gpt-4o"] } }, "then": "openai-target" },
      { "query": { "model": { "$regex": "^claude" }         }, "then": "anthropic-target" }
    ],
    "default": "openai-target"
  },
  "targets": [
    { "provider": "openai",    "model": "gpt-4o",                    "index": "openai-target"    },
    { "provider": "anthropic", "model": "claude-3-5-sonnet-20241022", "index": "anthropic-target" }
  ]
}
```

## 请求 Headers

| Header                 | 说明                                              |
|------------------------|---------------------------------------------------|
| `x-gateway-config`     | **必填**，JSON 格式的 `GatewayConfig`             |
| `x-gateway-user-id`    | 可选，用于 loadbalance 模式的用户粘性哈希         |
| `x-gateway-metadata`   | 可选，JSON 对象，可在 conditional 规则中引用      |

## 快速启动

```bash
npm install
npm run dev        # 启动开发服务器（tsx 热重载）
npm run typecheck  # TypeScript 类型检查
npm test           # 运行冒烟测试
npm run build      # 编译到 dist/
```

## 项目结构

```
src/
├── index.ts                 # Hono 入口，API 端点定义
├── router/
│   ├── strategyRouter.ts    # 核心路由引擎
│   ├── conditionalRouter.ts # 条件路由（MongoDB 风格匹配）
│   └── loadbalancer.ts      # 权重选择 + 用户粘性哈希
├── middleware/
│   └── requestValidator.ts  # 请求验证，解析 x-gateway-config
├── services/
│   ├── requestContext.ts    # 请求上下文构建
│   ├── retryHandler.ts      # 指数退避重试（Full Jitter）
│   ├── circuitBreaker.ts    # 三态熔断器
│   └── proxyService.ts      # 转发接口定义（待实现）
└── types/
    └── config.ts            # 全局类型定义
```

## TODO

- [ ] `proxyService.ts` — 实现转发到 Go 服务（SSE 流式透传）
- [ ] 完整测试覆盖（当前仅核心路径冒烟测试）
- [ ] 熔断状态持久化（当前重启后重置）
- [ ] 配置热更新（无需重启生效）
- [ ] 监控指标暴露（Prometheus `/metrics` 端点）

## Acknowledgements

Simplified extraction from [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) (v1.15.2), MIT License.

## Development

Developed with Claude Code assistance, architecture decisions by author.
