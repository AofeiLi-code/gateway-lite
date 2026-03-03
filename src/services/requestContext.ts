/**
 * 请求上下文构建器
 *
 * 从 Hono 请求中提取路由决策所需的最小字段集，
 * 不含任何 Provider 特有信息，与 AI 业务逻辑完全解耦。
 *
 * 提取来源：
 * - x-gateway-user-id header → userId（粘性哈希）
 * - x-gateway-metadata header（JSON）→ metadata（条件路由）
 * - 请求 body 的 model 字段 → model（条件路由）
 *
 * 注意：读取 body（c.req.json()）会消费 ReadableStream。Hono 内部会缓存
 * 首次解析结果，重复调用安全。但将 c.req.raw 传给 proxyToGoService 时，
 * body 流已消费——proxyToGoService 实现时需重建 Request 或单独缓存 body。
 */

import type { Context } from 'hono'
import type { AppEnv } from '../middleware/requestValidator.js'
import type { RequestContext } from '../types/config.js'

/**
 * 构建请求上下文
 *
 * @param c  Hono 请求上下文（已通过 requestValidator 验证）
 * @returns  路由决策所需的最小信息集
 */
export async function buildRequestContext(
  c: Context<AppEnv>,
): Promise<RequestContext> {

  // ── userId：用于 loadbalance 粘性哈希 ──
  // 约定 header 名：x-gateway-user-id（客户端传入，可为任意稳定标识符）
  const userId = c.req.header('x-gateway-user-id') || undefined

  // ── metadata：用于 conditional 路由条件匹配 ──
  // 约定 header 名：x-gateway-metadata，值为 JSON 字符串
  // 示例：'{"region":"us-west","tier":"premium"}'
  let metadata: Record<string, unknown> | undefined
  const metaRaw = c.req.header('x-gateway-metadata')
  if (metaRaw) {
    try {
      const parsed = JSON.parse(metaRaw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      // 无效 JSON 静默忽略，metadata 保持 undefined
      // 不抛错：metadata 是辅助字段，不影响请求合法性
    }
  }

  // ── model：从请求 body 中提取，用于条件路由匹配 ──
  // 例：{ "model": "gpt-4o", "messages": [...] } → model = "gpt-4o"
  let model: string | undefined
  try {
    const body = await c.req.json<Record<string, unknown>>()
    if (typeof body['model'] === 'string' && body['model'] !== '') {
      model = body['model']
    }
  } catch {
    // body 为空、非 JSON 或已消费时静默忽略
    // model 保持 undefined，不影响非条件路由场景
  }

  return {
    requestId: crypto.randomUUID(), // Node.js 19+ 全局可用
    userId,
    model,
    metadata,
    timestamp: Date.now(),
  }
}
