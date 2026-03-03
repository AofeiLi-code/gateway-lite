/**
 * AI Gateway 精简版 — 核心类型定义
 *
 * 配置通过请求 header `x-gateway-config` 以 JSON 字符串传入。
 * 精简版不包含任何 Provider 特有字段，实际 AI 请求由团队 Go 服务处理。
 */

// ─────────────────────────────────────────────
// 路由策略模式
// ─────────────────────────────────────────────

/** 四种路由策略模式 */
export type StrategyMode = 'loadbalance' | 'fallback' | 'conditional' | 'single'

// ─────────────────────────────────────────────
// 条件路由
// ─────────────────────────────────────────────

/**
 * 条件查询对象，支持 MongoDB 风格操作符：
 * - 比较：$eq, $ne, $gt, $gte, $lt, $lte
 * - 数组：$in, $nin
 * - 正则：$regex
 * - 逻辑：$and, $or
 *
 * 示例：{ "metadata.region": { "$eq": "us-west" } }
 */
export type ConditionQuery = Record<string, unknown>

/**
 * 条件规则：满足 query 时路由到 then 指向的 target（按 index 字段匹配）
 *
 * 示例：
 * { query: { "model": { "$eq": "gpt-4" } }, then: "premium" }
 */
export interface ConditionalRule {
  /** MongoDB 风格的匹配条件 */
  query: ConditionQuery
  /** 匹配时选中的 target index 值 */
  then: string
}

// ─────────────────────────────────────────────
// 路由策略
// ─────────────────────────────────────────────

/** 路由策略定义 */
export interface Strategy {
  /** 策略模式 */
  mode: StrategyMode

  /**
   * 触发 fallback 的 HTTP 状态码列表（仅 fallback 模式有效）
   * 默认：[429, 500, 502, 503, 504]
   */
  onStatusCodes?: number[]

  /** 条件规则列表（仅 conditional 模式有效） */
  conditions?: ConditionalRule[]

  /**
   * 无条件匹配时的默认 target index（仅 conditional 模式有效）
   * 若未设置且无匹配，则返回错误
   */
  default?: string
}

// ─────────────────────────────────────────────
// 重试配置
// ─────────────────────────────────────────────

/** 重试配置 */
export interface RetrySettings {
  /**
   * 最大重试次数（不含首次请求）
   * 默认：0（不重试）
   */
  attempts: number

  /**
   * 触发重试的 HTTP 状态码
   * 默认：[429, 500, 502, 503, 504]
   */
  onStatusCodes?: number[]

  /**
   * 首次重试的等待时间（ms），后续按指数退避翻倍
   * 默认：500
   */
  baseDelay?: number
}

// ─────────────────────────────────────────────
// 熔断器配置
// ─────────────────────────────────────────────

/** 熔断器配置（每个 target 独立） */
export interface CircuitBreakerConfig {
  /**
   * 触发熔断的连续失败次数
   * 默认：5
   */
  failureThreshold?: number

  /**
   * 熔断后进入半开状态前的等待时间（ms）
   * 默认：30000
   */
  resetTimeout?: number

  /**
   * 半开（HALF_OPEN）状态下允许通过的最大探测请求数
   * 默认：3
   */
  halfOpenMax?: number
}

// ─────────────────────────────────────────────
// 路由目标
// ─────────────────────────────────────────────

/**
 * 路由目标（Target）
 *
 * 精简版不包含 Provider API Key / baseURL 等敏感信息，
 * 这些由 Go 服务通过 virtualKey 映射处理。
 *
 * targets 支持嵌套：每个 target 内部可以有自己的 strategy + targets，
 * 实现复杂的多级路由策略（如 loadbalance 内嵌 fallback）。
 */
export interface Target {
  /** Provider 标识符，由 Go 服务识别（如 "openai", "anthropic"） */
  provider: string

  /** 请求的模型名称（可选，转发给 Go 服务） */
  model?: string

  /**
   * 负载均衡权重（仅 loadbalance 模式有效）
   * 数值越大命中概率越高，默认视为 1
   */
  weight?: number

  /**
   * 虚拟 Key，用于 Go 服务内部鉴权映射
   * 不直接包含真实 API Key
   */
  virtualKey?: string

  /**
   * Target 的唯一标识符（用于条件路由中 ConditionalRule.then 匹配）
   * 不设置时按数组下标隐式匹配（"0", "1", "2"...）
   */
  index?: string

  // ── 嵌套路由（支持多级策略组合） ──

  /** 当前 target 的子路由策略（支持嵌套） */
  strategy?: Strategy

  /** 子路由目标列表（当 strategy 存在时必须提供） */
  targets?: Target[]

  // ── 每个 target 独立的运行时配置 ──

  /** 覆盖当前 target 的重试策略（优先于顶层 retry） */
  retry?: RetrySettings

  /** 当前 target 的熔断器配置 */
  cbConfig?: CircuitBreakerConfig

  /**
   * 覆盖请求参数（转发给 Go 服务时合并到请求体）
   * 常用于强制指定 model、temperature 等
   */
  overrideParams?: Record<string, unknown>
}

// ─────────────────────────────────────────────
// 顶层网关配置
// ─────────────────────────────────────────────

/**
 * 顶层网关配置（通过 `x-gateway-config` header 传入）
 *
 * 使用示例：
 * ```json
 * {
 *   "strategy": { "mode": "loadbalance" },
 *   "targets": [
 *     { "provider": "openai", "model": "gpt-4o", "weight": 7, "virtualKey": "key-a" },
 *     { "provider": "openai", "model": "gpt-4o-mini", "weight": 3, "virtualKey": "key-b" }
 *   ]
 * }
 * ```
 */
export interface GatewayConfig {
  /** 路由策略（必填） */
  strategy: Strategy

  /** 路由目标列表（必填，至少一个） */
  targets: Target[]

  /**
   * 全局重试配置（可被 target 级别的 retry 覆盖）
   * 不设置则默认不重试
   */
  retry?: RetrySettings
}

// ─────────────────────────────────────────────
// 请求上下文
// ─────────────────────────────────────────────

/**
 * 请求上下文（RequestContext）
 *
 * 从请求的 headers 和 body 中提取，仅保留路由决策所需字段。
 * 不包含任何 Provider 特有信息。
 */
export interface RequestContext {
  /** 请求唯一 ID（UUID v4，用于追踪日志） */
  requestId: string

  /**
   * 用户标识符（可选）
   * 在 loadbalance 模式下用于一致性哈希，确保同一用户命中同一 target。
   * 从 `x-user-id` header 或请求体 `user` 字段读取。
   */
  userId?: string

  /**
   * 请求的模型名称（可选）
   * 从请求体 `model` 字段读取，用于条件路由匹配。
   */
  model?: string

  /**
   * 自定义元数据（可选）
   * 从 `x-metadata` header（JSON）读取，用于条件路由匹配。
   * 示例：{ "region": "us-west", "tier": "premium" }
   */
  metadata?: Record<string, unknown>

  /** 请求时间戳（Unix ms） */
  timestamp: number
}

// ─────────────────────────────────────────────
// 内部使用类型
// ─────────────────────────────────────────────

/** 熔断器三种状态 */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

/**
 * 路由结果：strategyRouter.routeRequest() 的返回值
 * 包含选中的 target 和完整的嵌套路径配置
 */
export interface RoutingResult {
  /** 最终选中的目标 */
  target: Target
  /** 实际生效的重试配置（合并 global + target 级别） */
  retrySettings: RetrySettings
}
