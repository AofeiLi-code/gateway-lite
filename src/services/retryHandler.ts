/**
 * 重试处理器
 *
 * 提供带指数退避 + 随机抖动的通用重试能力。
 * 不依赖任何外部 npm 包，纯手写实现。
 *
 * 设计思路：
 * - fn() 成功时直接返回结果
 * - fn() 抛出 RetryableError（携带 HTTP status）时按策略重试
 * - fn() 抛出其他错误（如网络错误 / 业务逻辑错误）时立即透传，不重试
 *
 * 指数退避公式（Full Jitter，AWS 推荐）：
 *   delay = random(0, min(MAX_DELAY, baseDelay × 2^attempt))
 * Full Jitter 比固定退避分散流量更均匀，避免多请求同时重试造成"惊群效应"。
 */

import type { RetrySettings } from '../types/config.js'

// ─────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────

/** 默认触发重试的 HTTP 状态码（与原项目 globals.ts 保持一致） */
export const DEFAULT_RETRY_STATUS_CODES = [429, 500, 502, 503, 504]

/** 单次延迟上限，防止退避时间无限增长 */
const MAX_DELAY_MS = 30_000 // 30 秒

/** 默认基础延迟（首次重试等待时间） */
const DEFAULT_BASE_DELAY_MS = 500

// ─────────────────────────────────────────────
// 可重试错误类
// ─────────────────────────────────────────────

/**
 * 可重试的 HTTP 错误
 *
 * fn() 拿到非成功响应时应抛出此错误，携带 HTTP status code，
 * withRetry() 据此判断是否符合重试条件。
 *
 * 示例用法：
 * ```ts
 * const res = await proxyToGoService(req)
 * if (retrySettings.onStatusCodes?.includes(res.status)) {
 *   throw new RetryableError(res.status)
 * }
 * return res
 * ```
 */
export class RetryableError extends Error {
  constructor(
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`)
    this.name = 'RetryableError'
  }
}

// ─────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────

/**
 * 计算第 attempt 次重试的等待时间（Full Jitter 指数退避）
 *
 * @param baseDelay  基础延迟（ms）
 * @param attempt    已完成的尝试次数（从 0 开始）
 * @returns          本次等待时间（ms），含随机抖动
 */
function calcDelay(baseDelay: number, attempt: number): number {
  // 指数退避上限：baseDelay × 2^attempt，但不超过 MAX_DELAY_MS
  const cap = Math.min(MAX_DELAY_MS, baseDelay * Math.pow(2, attempt))
  // Full Jitter：在 [0, cap) 区间均匀随机，彻底打散重试时间点
  return Math.random() * cap
}

/** Promise 版 sleep */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────

/**
 * 带重试的执行器
 *
 * @param fn       待执行的异步函数，失败时应抛出 RetryableError
 * @param settings 重试配置（attempts=最大重试次数，不含首次；baseDelay=基础延迟 ms）
 * @returns        fn() 成功时的返回值
 *
 * 执行序列（attempts=2 时）：
 *   第 0 次尝试 → 失败 → 等待 delay(0) → 第 1 次尝试 → 失败 → 等待 delay(1) → 第 2 次尝试 → 返回/抛出
 */
export async function withRetry<T>(
  fn:       () => Promise<T>,
  settings: RetrySettings,
): Promise<T> {
  const maxAttempts   = Math.max(0, settings.attempts) // 最大重试次数（不含首次），负值视为 0
  const baseDelay     = settings.baseDelay ?? DEFAULT_BASE_DELAY_MS
  const retryCodes    = settings.onStatusCodes ?? DEFAULT_RETRY_STATUS_CODES

  let lastError: unknown

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // 非 RetryableError（如网络层异常、业务错误）立即透传，不重试
      if (!(err instanceof RetryableError)) throw err

      // 状态码不在可重试列表中 → 立即透传
      if (!retryCodes.includes(err.status)) throw err

      // 已达到最大重试次数 → 退出循环，最终抛出
      if (attempt === maxAttempts) break

      // 计算退避延迟并等待（attempt=0 时等待最短，之后指数增长）
      const delay = calcDelay(baseDelay, attempt)
      await sleep(delay)
    }
  }

  // 所有重试均已耗尽
  throw lastError
}
