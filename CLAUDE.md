# AI Gateway 精简版 — Claude Code 工作指令

## 项目背景

我们需要从开源项目 **Portkey AI Gateway** (v1.15.2) 中抽取核心的路由策略层，构建一个精简版 AI Gateway。

原项目地址：`https://github.com/Portkey-AI/gateway`

### 原项目问题

- 70+ Provider 适配器，我们不需要
- 大量与路由无关的功能（缓存、Hooks/Guardrails、日志等）
- 我们只需要**路由策略引擎**，实际 AI 请求由团队的 Go 服务处理

### 精简版目标

- 保留三大核心能力：**灰度发布（Loadbalance）**、**AB测试（Conditional）**、**熔断保护（Fallback）**
- 去掉所有 Provider 适配代码
- 去掉缓存、Hooks/Guardrails、日志等非核心中间件
- 新增 `proxyService`（仅保留方法签名，暂不实现转发逻辑）
- 新增用户粘性哈希（Loadbalance 场景下同一用户命中同一 target）
- 增强熔断器（原版过于简单）
- 总代码量控制在 **1000-1500 行**

---

## 阶段一：项目初始化与代码阅读（约 60 分钟）

### Step 1.1 — 克隆原项目并了解结构

```
原项目源码在上级目录 ../gateway/ 中，已经 checkout 到 v1.15.2。
请直接从 ../gateway/src/ 中读取参考代码，不需要再 clone。

然后阅读以下核心文件，理解整体架构：
1. src/index.ts — 入口文件，看路由注册和中间件挂载
2. src/handlers/handlerUtils.ts — 核心路由引擎，这是最重要的文件
3. src/handlers/chatCompletionsHandler.ts — 看 handler 如何调用路由引擎
4. src/middlewares/ — 了解中间件层（我们只保留 requestValidator）
5. src/services/requestContext.ts — 请求上下文构建
6. src/handlers/retryHandler.ts — 重试逻辑

重点关注 handlerUtils.ts 中的：
- tryTargetsRecursively() — 递归处理路由策略的核心函数
- loadbalance 权重选择逻辑
- fallback 降级逻辑
- conditional routing 条件路由逻辑
```

### Step 1.2 — 梳理依赖关系

```
请梳理以下文件之间的 import 依赖关系，列出精简版必须保留的类型定义和工具函数：
- handlerUtils.ts 依赖了哪些类型？
- retryHandler.ts 依赖了哪些模块？
- conditionalRouter 的条件匹配逻辑在哪里？
- requestContext 中哪些字段是路由决策必须的？

输出一份依赖清单，标注哪些要保留、哪些可以删除。
```

---

## 阶段二：搭建精简版项目骨架（约 30 分钟）

### Step 2.1 — 初始化新项目

```
在 portkey-gateway 同级目录下创建新项目：

mkdir ai-gateway-lite
cd ai-gateway-lite
npm init -y
npm install hono typescript @types/node
npm install -D tsx

创建 tsconfig.json（参考原项目配置）

项目结构应该是：
ai-gateway-lite/
├── src/
│   ├── index.ts                 # 入口文件 + API 端点定义
│   ├── router/
│   │   ├── strategyRouter.ts    # 核心路由引擎（从 handlerUtils.ts 提取）
│   │   ├── conditionalRouter.ts # 条件路由（从原项目提取）
│   │   └── loadbalancer.ts      # 权重选择 + 用户粘性哈希（新增）
│   ├── middleware/
│   │   └── requestValidator.ts  # 请求验证（从原项目简化）
│   ├── services/
│   │   ├── requestContext.ts    # 请求上下文（精简版）
│   │   ├── retryHandler.ts     # 重试逻辑（从原项目提取）
│   │   ├── circuitBreaker.ts   # 熔断器（增强版，新写）
│   │   └── proxyService.ts     # 转发到 Go 服务（仅方法签名）
│   └── types/
│       └── config.ts            # 配置类型定义
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

### Step 2.2 — 定义配置类型

```
在 src/types/config.ts 中定义精简版的配置类型。

核心类型包括：
1. GatewayConfig — 顶层配置，通过 x-gateway-config header 传入
2. StrategyMode — 枚举：'loadbalance' | 'fallback' | 'conditional' | 'single'
3. Target — 路由目标：{ provider, model, weight?, ... }
4. ConditionalRule — 条件规则：{ condition, targets }
5. CircuitBreakerConfig — 熔断配置：{ failureThreshold, resetTimeout, halfOpenMax }

参考原项目的类型定义，但大幅简化，去掉所有 Provider 特有的字段。
每个 Target 不再需要 provider 的 API key 和 baseURL 等信息，
因为实际请求会转发给 Go 服务处理。
Target 只需要保留：{ provider, model, weight, virtualKey }
```

---

## 阶段三：提取核心路由引擎（约 90 分钟）

这是最关键的阶段，需要从 handlerUtils.ts 中提取路由策略逻辑。

### Step 3.1 — strategyRouter.ts（核心）

```
从原项目 src/handlers/handlerUtils.ts 的 tryTargetsRecursively() 函数中，
提取路由策略的核心逻辑到 src/router/strategyRouter.ts。

这个文件应该导出一个主函数：
async function routeRequest(config: GatewayConfig, context: RequestContext): Promise<Target>

函数逻辑：
1. 解析 config 中的 strategy.mode
2. switch(mode):
   - 'loadbalance': 调用 loadbalancer.selectTarget()
   - 'fallback': 依次尝试 targets，检查熔断状态，返回第一个可用的
   - 'conditional': 调用 conditionalRouter.matchTarget()
   - 'single': 直接返回 targets[0]
3. 返回选中的 Target

关键：
- 不要包含任何 Provider 请求构建/发送的逻辑
- 不要包含 response 处理逻辑
- 只做"选择目标"这一件事
- 保留原项目中 targets 数组的递归处理能力（targets 可以嵌套）
```

### Step 3.2 — loadbalancer.ts

```
从原项目中提取权重选择逻辑，并新增用户粘性哈希。

导出：
function selectTarget(targets: Target[], userId?: string): Target

逻辑：
1. 如果有 userId，使用一致性哈希确保同一用户命中同一 target
   （简单实现：对 userId 做哈希，取模映射到 target）
2. 如果没有 userId，按权重随机选择
   （原项目的权重选择逻辑，Math.random() * totalWeight）

用户粘性哈希的实现：
- 使用简单的 djb2 或 fnv1a 哈希算法
- 不需要引入外部依赖
- 约 20-30 行代码
```

### Step 3.3 — conditionalRouter.ts

```
从原项目中提取条件路由逻辑。

原项目的条件路由支持按请求中的字段（如 model、metadata 等）匹配规则。
保留这个能力，但简化匹配器。

导出：
function matchTarget(rules: ConditionalRule[], context: RequestContext): Target | null

支持的条件匹配：
- 精确匹配（equals）
- 前缀匹配（startsWith）
- 包含匹配（contains）
- 正则匹配（regex）

如果没有匹配到任何规则，返回 null（由上层决定 fallback 行为）。
```

### Step 3.4 — retryHandler.ts

```
从原项目 src/services/retryHandler.ts 提取重试逻辑。

简化版只需要：
- 配置最大重试次数
- 指数退避策略（exponential backoff）
- 可重试的错误码判断（429, 500, 502, 503, 504）

导出：
async function withRetry<T>(
  fn: () => Promise<T>,
  config: { maxRetries: number, baseDelay: number }
): Promise<T>
```

---

## 阶段四：新增功能模块（约 60 分钟）

### Step 4.1 — circuitBreaker.ts（增强版熔断器）

```
原项目的熔断器很简单，我们需要一个更完整的实现。

实现三态熔断器：
- CLOSED（正常）：请求正常通过，记录失败次数
- OPEN（熔断）：直接拒绝请求，不转发
- HALF_OPEN（半开）：允许少量请求试探，成功则恢复

导出：
class CircuitBreaker {
  constructor(config: CircuitBreakerConfig)
  canRequest(): boolean          // 当前是否允许请求通过
  recordSuccess(): void          // 记录成功
  recordFailure(): void          // 记录失败
  getState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  reset(): void                  // 手动重置
}

配置项：
- failureThreshold: number       // 触发熔断的连续失败次数，默认 5
- resetTimeout: number           // 熔断后多久进入半开状态（ms），默认 30000
- halfOpenMax: number            // 半开状态最多允许几个请求试探，默认 3

每个 Target 对应一个独立的 CircuitBreaker 实例。
用 Map<string, CircuitBreaker> 管理。
```

### Step 4.2 — proxyService.ts（空壳）

```
创建 proxyService.ts，仅定义方法签名和接口，不实现具体转发逻辑。

导出：
interface ProxyRequest {
  target: Target                  // 路由选中的目标
  originalRequest: Request        // 原始请求
  headers: Record<string, string> // 需要转发的 headers
}

interface ProxyResponse {
  status: number
  headers: Record<string, string>
  body: ReadableStream | string
}

async function proxyToGoService(req: ProxyRequest): Promise<ProxyResponse> {
  // TODO: 实现转发到 Go 服务的逻辑
  // 预期行为：
  // 1. 根据 target 信息构建转发请求
  // 2. 将请求发送到 Go 服务的对应端点
  // 3. 流式透传响应（支持 SSE）
  throw new Error('proxyToGoService not implemented yet')
}

这个文件只是占位，后续由团队的 Go 开发配合实现。
```

---

## 阶段五：组装入口与中间件（约 30 分钟）

### Step 5.1 — requestValidator.ts

```
简化版的请求验证中间件。

职责：
1. 从请求 header 中读取 x-gateway-config
2. 解析 JSON 为 GatewayConfig
3. 验证必填字段（strategy.mode, targets）
4. 验证 targets 至少有一个
5. 将解析后的 config 挂到 Hono context 上

如果验证失败，返回 400 + 错误信息。
```

### Step 5.2 — requestContext.ts

```
精简版的请求上下文。

从原项目 src/services/requestContext.ts 中提取，只保留路由决策需要的字段：

interface RequestContext {
  requestId: string              // 请求唯一 ID
  userId?: string                // 用户 ID（用于粘性哈希）
  model?: string                 // 请求的模型名称
  metadata?: Record<string, any> // 自定义元数据（用于条件路由）
  timestamp: number              // 请求时间戳
}

从请求 body 和 headers 中提取这些字段。
```

### Step 5.3 — index.ts（入口）

```
使用 Hono 框架搭建入口。

注册以下 API 端点：
- POST /v1/chat/completions — 聊天补全（主端点）
- POST /v1/embeddings — 文本嵌入
- POST /v1/completions — 文本补全
- GET  /health — 健康检查

每个端点的处理流程：
1. requestValidator 中间件 → 解析配置
2. 构建 RequestContext
3. strategyRouter.routeRequest() → 选中 Target
4. proxyToGoService() → 转发请求（目前会抛 not implemented）
5. 返回响应

入口文件控制在 100 行以内。
```

---

## 阶段六：验证与收尾（约 30 分钟）

### Step 6.1 — 编译验证

```
确保项目能成功编译：
npx tsc --noEmit

修复所有类型错误。
```

### Step 6.2 — 基本冒烟测试

```
创建 src/__tests__/router.test.ts，用简单的测试验证：

1. Loadbalance 模式：
   - 权重选择是否正常
   - 用户粘性：同一 userId 多次调用是否返回同一 target

2. Fallback 模式：
   - 第一个 target 熔断后是否自动切到第二个
   - 所有 target 都熔断时是否返回错误

3. Conditional 模式：
   - 条件匹配是否正确
   - 无匹配时的 fallback 行为

4. CircuitBreaker：
   - 连续失败后是否进入 OPEN 状态
   - 超时后是否进入 HALF_OPEN
   - 半开状态成功后是否恢复 CLOSED

不需要完整的测试覆盖，只要核心路径能跑通即可。
```

### Step 6.3 — 写 README.md

```
为精简版项目写一份简洁的 README：
- 项目定位：一句话说明
- 架构图（ASCII）
- 支持的路由策略
- 配置示例（x-gateway-config JSON）
- 如何运行
- TODO 清单（proxyService 实现、完整测试等）
```

---

## 关键提醒

1. **不要复制粘贴整个文件** — 从原项目中理解逻辑后，用精简的方式重写
2. **去掉所有 Provider 相关代码** — 我们不直接调用 AI API
3. **proxyService 只写接口** — 不实现，抛 not implemented 即可
4. **保持类型安全** — 所有函数都要有完整的 TypeScript 类型
5. **代码要有注释** — 关键逻辑处写中文注释，方便团队理解
6. **嵌套路由要保留** — 原项目支持 targets 内嵌套 strategy，这个能力很重要
7. **每完成一个模块就 git commit** — 保持清晰的提交历史

## 预期产出

完成后应该得到一个约 1000-1500 行代码的精简项目，具备：

- ✅ Loadbalance（权重 + 用户粘性）
- ✅ Fallback（熔断保护 + 自动降级）
- ✅ Conditional（条件路由 / AB测试）
- ✅ 重试机制（指数退避）
- ✅ 请求验证
- ✅ 类型安全
- ⬜ proxyService 转发（方法签名已定义，待实现）
- ⬜ 完整测试覆盖（基本冒烟测试已有）
