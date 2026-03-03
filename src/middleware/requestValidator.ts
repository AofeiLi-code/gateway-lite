/**
 * 请求验证中间件
 *
 * 职责：
 * 1. 从 x-gateway-config header 读取并解析 JSON 配置
 * 2. 验证必填字段（strategy.mode、targets 非空、每个 target 有 provider）
 * 3. 验证通过后将 GatewayConfig 挂到 Hono context 变量上
 * 4. 验证失败时返回 400 + 具体的错误描述
 *
 * AppEnv 类型同文件导出，供 index.ts 和 requestContext.ts 共用。
 */

import type { MiddlewareHandler } from 'hono'
import type { GatewayConfig } from '../types/config.js'

// ─────────────────────────────────────────────
// Hono 上下文变量类型（供全局共享）
// ─────────────────────────────────────────────

/** Hono 应用的环境泛型，定义 c.set / c.get 的键值类型 */
export type AppEnv = {
  Variables: {
    /** requestValidator 解析完毕的网关配置，后续中间件和 handler 直接取用 */
    gatewayConfig: GatewayConfig
  }
}

// ─────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────

const GATEWAY_CONFIG_HEADER = 'x-gateway-config'

const VALID_MODES = new Set(['loadbalance', 'fallback', 'conditional', 'single'])

// ─────────────────────────────────────────────
// 验证逻辑（纯函数，易于单测）
// ─────────────────────────────────────────────

/** 返回 string 表示验证失败原因，返回 null 表示验证通过 */
function validateConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'x-gateway-config must be a JSON object'
  }
  const c = config as Record<string, unknown>

  // strategy 验证
  const strategy = c['strategy'] as Record<string, unknown> | undefined
  if (!strategy || typeof strategy !== 'object') {
    return 'strategy is required'
  }
  if (typeof strategy['mode'] !== 'string') {
    return 'strategy.mode is required'
  }
  if (!VALID_MODES.has(strategy['mode'] as string)) {
    return `Invalid strategy.mode "${strategy['mode']}". Must be one of: loadbalance, fallback, conditional, single`
  }

  // targets 验证
  const targets = c['targets']
  if (!Array.isArray(targets) || targets.length === 0) {
    return 'targets must be a non-empty array'
  }
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i] as Record<string, unknown>
    if (!t || typeof t['provider'] !== 'string' || t['provider'] === '') {
      return `targets[${i}].provider is required and must be a non-empty string`
    }
  }

  // conditional 模式额外验证
  if (strategy['mode'] === 'conditional') {
    const conditions = strategy['conditions']
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return 'conditional mode requires a non-empty strategy.conditions array'
    }
  }

  return null
}

// ─────────────────────────────────────────────
// 中间件
// ─────────────────────────────────────────────

export const requestValidator: MiddlewareHandler<AppEnv> = async (c, next) => {
  // 1. header 存在检查
  const raw = c.req.header(GATEWAY_CONFIG_HEADER)
  if (!raw) {
    return c.json(
      { error: `Missing required header: ${GATEWAY_CONFIG_HEADER}` },
      400,
    )
  }

  // 2. JSON 解析
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return c.json(
      { error: `${GATEWAY_CONFIG_HEADER} contains invalid JSON` },
      400,
    )
  }

  // 3. 结构验证
  const validationError = validateConfig(parsed)
  if (validationError) {
    return c.json({ error: validationError }, 400)
  }

  // 4. 挂到 context 上，后续 handler 用 c.get('gatewayConfig') 取用
  c.set('gatewayConfig', parsed as GatewayConfig)
  await next()
}
