/**
 * 三态熔断器实现
 *
 * 状态流转：
 *   CLOSED ──(连续失败 >= failureThreshold)──▶ OPEN
 *   OPEN   ──(resetTimeout 超时后)───────────▶ HALF_OPEN
 *   HALF_OPEN ──(探测成功)─────────────────▶ CLOSED
 *   HALF_OPEN ──(探测失败)─────────────────▶ OPEN
 */

import type { CircuitBreakerConfig, CircuitBreakerState } from '../types/config.js'

// 默认配置常量
const DEFAULT_FAILURE_THRESHOLD = 5   // 连续失败 5 次触发熔断
const DEFAULT_RESET_TIMEOUT     = 30_000 // 熔断 30s 后进入半开
const DEFAULT_HALF_OPEN_MAX     = 3   // 半开状态最多放行 3 个探测请求

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED'
  private failureCount  = 0  // CLOSED 状态下的连续失败计数
  private halfOpenCount = 0  // HALF_OPEN 状态下已放行的探测请求数
  private openedAt: number | null = null // 进入 OPEN 状态的时间戳

  private readonly cfg: Required<CircuitBreakerConfig>

  constructor(config?: CircuitBreakerConfig) {
    this.cfg = {
      failureThreshold: config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      resetTimeout:     config?.resetTimeout     ?? DEFAULT_RESET_TIMEOUT,
      halfOpenMax:      config?.halfOpenMax       ?? DEFAULT_HALF_OPEN_MAX,
    }
  }

  /**
   * 判断当前是否允许请求通过
   * - CLOSED：直接放行
   * - OPEN：检查是否已超过 resetTimeout，若是则转为 HALF_OPEN 并放行首个探测
   * - HALF_OPEN：在 halfOpenMax 限额内放行，超出则拒绝
   */
  canRequest(): boolean {
    if (this.state === 'CLOSED') return true

    if (this.state === 'OPEN') {
      const elapsed = Date.now() - (this.openedAt ?? 0)
      if (elapsed < this.cfg.resetTimeout) return false
      // 超时 → 进入半开，允许首个探测请求
      this.state        = 'HALF_OPEN'
      this.halfOpenCount = 0
    }

    // HALF_OPEN：限制探测请求数
    if (this.halfOpenCount < this.cfg.halfOpenMax) {
      this.halfOpenCount++
      return true
    }
    return false // 探测名额已耗尽，等待现有探测的结果
  }

  /**
   * 记录成功：
   * - HALF_OPEN → CLOSED（探测通过，恢复正常）
   * - CLOSED：重置失败计数
   */
  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED'
    }
    this.failureCount  = 0
    this.halfOpenCount = 0
    this.openedAt      = null
  }

  /**
   * 记录失败：
   * - HALF_OPEN → OPEN（探测失败，重新熔断）
   * - CLOSED：累计失败计数，达到阈值则熔断
   */
  recordFailure(): void {
    if (this.state === 'HALF_OPEN') {
      // 半开探测失败 → 重新打开，重置探测计数
      this.state        = 'OPEN'
      this.openedAt     = Date.now()
      this.halfOpenCount = 0
      return
    }

    if (this.state === 'CLOSED') {
      this.failureCount++
      if (this.failureCount >= this.cfg.failureThreshold) {
        // 连续失败达到阈值 → 熔断
        this.state        = 'OPEN'
        this.openedAt     = Date.now()
        this.failureCount = 0
      }
    }
  }

  getState(): CircuitBreakerState {
    return this.state
  }

  /** 手动重置（运维后门 / 测试用） */
  reset(): void {
    this.state        = 'CLOSED'
    this.failureCount  = 0
    this.halfOpenCount = 0
    this.openedAt      = null
  }
}

// ─────────────────────────────────────────────
// 全局熔断器注册表：每个 target 独立一个实例
// ─────────────────────────────────────────────

const registry = new Map<string, CircuitBreaker>()

/**
 * 获取（或创建）指定 target 的熔断器实例
 * @param targetKey  target 唯一标识（由 strategyRouter 生成）
 * @param config     熔断器配置（首次创建时生效）
 */
export function getCircuitBreaker(
  targetKey: string,
  config?: CircuitBreakerConfig,
): CircuitBreaker {
  if (!registry.has(targetKey)) {
    registry.set(targetKey, new CircuitBreaker(config))
  }
  return registry.get(targetKey)!
}

/** 清除所有熔断器状态（供测试使用） */
export function resetAllCircuitBreakers(): void {
  registry.clear()
}
