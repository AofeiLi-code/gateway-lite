// AI Gateway 精简版 — 入口文件
// 流程：requestValidator → buildRequestContext
//       → withRetry( routeRequest → proxyToGoService → updateCircuitBreaker )
//       → 透传响应给客户端（每次重试重新选 target，熔断器状态已更新）

import { Hono }                               from 'hono'
import type { Context }                        from 'hono'
import type { Target }                         from './types/config.js'
import { requestValidator, type AppEnv }       from './middleware/requestValidator.js'
import { buildRequestContext }                 from './services/requestContext.js'
import { routeRequest, updateCircuitBreaker }  from './router/strategyRouter.js'
import { proxyToGoService, type ProxyRequest } from './services/proxyService.js'
import {
  withRetry,
  RetryableError,
  DEFAULT_RETRY_STATUS_CODES,
} from './services/retryHandler.js'

const app = new Hono<AppEnv>()

// ── 中间件：仅挂载在 /v1/* 路径，健康检查不受影响 ──
app.use('/v1/*', requestValidator)

// ── 健康检查 ──
app.get('/health', c => c.json({ status: 'ok', timestamp: Date.now() }))

// ─────────────────────────────────────────────
// 统一 AI 请求处理器
// ─────────────────────────────────────────────

async function handleAIRequest(c: Context<AppEnv>): Promise<Response> {
  const config = c.get('gatewayConfig')
  const ctx    = await buildRequestContext(c)

  // lastTarget 在 withRetry 回调外部声明，使 catch 块可以访问
  let lastTarget: Target | undefined

  try {
    // withRetry 包裹 routeRequest + proxyToGoService：
    // 每次重试都重新调用 routeRequest，熔断器状态已更新后可选到不同 target
    const proxyRes = await withRetry(async () => {
      const { target, retrySettings } = await routeRequest(config, ctx)
      lastTarget = target

      const res = await proxyToGoService({
        target,
        originalRequest: c.req.raw,
        // 过滤掉网关内部 header（x-gateway-*），避免透传给 Go 服务
        // 用 forEach 代替展开迭代，兼容 DOM + @types/node 混合类型环境
        headers: (() => {
          const h: Record<string, string> = {}
          c.req.raw.headers.forEach((v, k) => {
            if (!k.startsWith('x-gateway-')) h[k] = v
          })
          return h
        })(),
      } satisfies ProxyRequest)

      // 无论成功失败都更新熔断器（fallback 场景下影响下次 routeRequest 的选择）
      const onCodes = retrySettings.onStatusCodes ?? DEFAULT_RETRY_STATUS_CODES
      updateCircuitBreaker(target, res.status, onCodes)

      // 状态码命中重试列表 → 抛 RetryableError，触发 withRetry 下一次重试
      if (onCodes.includes(res.status)) throw new RetryableError(res.status)

      return res
    }, config.retry ?? { attempts: 0 })

    // 透传 Go 服务的响应（body 支持 ReadableStream for SSE）
    return new Response(proxyRes.body as ReadableStream<Uint8Array> | string | null, {
      status:  proxyRes.status,
      headers: proxyRes.headers,
    })

  } catch (err) {
    // RetryableError 已在内部回调中调用过 updateCircuitBreaker，不重复记录
    // 仅对非重试错误（网络异常 / proxyToGoService 未实现等）标记 target 失败
    if (lastTarget && !(err instanceof RetryableError)) {
      updateCircuitBreaker(lastTarget, 0, DEFAULT_RETRY_STATUS_CODES)
    }
    const msg    = err instanceof Error ? err.message : 'Internal gateway error'
    const status = (err instanceof RetryableError ? err.status : 500) as
      400 | 429 | 500 | 502 | 503 | 504
    return c.json({ error: msg }, status)
  }
}

// ── AI 端点注册 ──
app.post('/v1/chat/completions', handleAIRequest)
app.post('/v1/embeddings',       handleAIRequest)
app.post('/v1/completions',      handleAIRequest)

export default app
