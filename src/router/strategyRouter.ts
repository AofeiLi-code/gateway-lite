/**
 * 核心路由引擎
 *
 * 从原项目 handlerUtils.ts 的 tryTargetsRecursively() 中提取路由策略逻辑，
 * 去掉所有 Provider 请求构建、发送、缓存、Hooks 等无关代码，
 * 只做"根据策略选择 Target"这一件事。
 *
 * 支持嵌套路由：Target 自身可包含 strategy + targets，形成多级策略树。
 * 例：顶层 loadbalance → 每个 target 内再嵌套 fallback 链
 */

import type {
  GatewayConfig,
  Target,
  RequestContext,
  RetrySettings,
  RoutingResult,
} from '../types/config.js'
import { selectTarget }     from './loadbalancer.js'
import { matchTarget }      from './conditionalRouter.js'
import { getCircuitBreaker } from '../services/circuitBreaker.js'

// 原项目 globals.ts RETRY_STATUS_CODES = [429, 500, 502, 503, 504]
const DEFAULT_FALLBACK_STATUS_CODES = [429, 500, 502, 503, 504]

// ─────────────────────────────────────────────
// 熔断器 key 生成
// ─────────────────────────────────────────────

/**
 * 生成 target 的熔断器注册表 key
 * 相同 provider + model + virtualKey 的 target 共享同一个熔断器实例，
 * 确保状态在跨请求之间持久化。
 */
function getTargetKey(target: Target): string {
  return [
    target.provider,
    target.model    ?? '*',
    target.virtualKey ?? 'default',
  ].join(':')
}

// ─────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────

/**
 * 根据配置的路由策略选择目标 target
 *
 * 对应原项目 tryTargetsRecursively() 的策略选择部分（去掉实际请求逻辑）。
 * 若选中的 target 自身含嵌套策略，递归解析直到叶子节点。
 *
 * @param config   网关配置（strategy + targets + 全局 retry）
 * @param context  请求上下文（userId / model / metadata，用于路由决策）
 * @returns        { target: 最终选中的叶子 target, retrySettings: 生效重试配置 }
 */
export async function routeRequest(
  config:  GatewayConfig,
  context: RequestContext,
): Promise<RoutingResult> {
  const { strategy, targets, retry: globalRetry } = config

  if (!targets || targets.length === 0) {
    throw new Error('routeRequest: targets array is empty')
  }

  let selected: Target

  switch (strategy.mode) {

    // ── 负载均衡：按权重随机选择，或按 userId 粘性哈希选择 ──
    case 'loadbalance':
      selected = selectTarget(targets, context.userId)
      break

    // ── 熔断降级：顺序检查熔断器状态，返回第一个可用 target ──
    case 'fallback':
      selected = selectFallbackTarget(
        targets,
        strategy.onStatusCodes ?? DEFAULT_FALLBACK_STATUS_CODES,
      )
      break

    // ── 条件路由：按请求上下文中的字段匹配规则 ──
    case 'conditional': {
      if (!strategy.conditions?.length) {
        throw new Error('routeRequest: conditional mode requires non-empty conditions array')
      }
      const matched = matchTarget(strategy.conditions, strategy.default, targets, context)
      if (!matched) {
        throw new Error(
          'routeRequest: no conditional rule matched and no default target configured',
        )
      }
      selected = matched
      break
    }

    // ── 单目标：直接使用 targets[0]，无需策略计算 ──
    case 'single':
      selected = targets[0]
      break

    default:
      // TypeScript exhaustive check — 防止新增 mode 时忘记处理
      throw new Error(`routeRequest: unknown strategy mode "${String(strategy.mode)}"`)
  }

  // ── 嵌套路由：若选中的 target 自身包含策略，递归路由到叶子节点 ──
  // 对应原项目 tryTargetsRecursively() 对 Targets 结构的递归调用
  if (selected.strategy && selected.targets?.length) {
    const nestedConfig: GatewayConfig = {
      strategy: selected.strategy,
      targets:  selected.targets,
      // target 级别的 retry 优先于外层全局 retry
      retry: selected.retry ?? globalRetry,
    }
    return routeRequest(nestedConfig, context)
  }

  // ── 叶子节点：合并重试配置后返回 ──
  // 优先级：target.retry > config.retry > 默认不重试
  const effectiveRetry: RetrySettings = selected.retry ?? globalRetry ?? { attempts: 0 }

  return { target: selected, retrySettings: effectiveRetry }
}

// ─────────────────────────────────────────────
// fallback 策略内部逻辑
// ─────────────────────────────────────────────

/**
 * fallback 模式：按顺序遍历 targets，跳过熔断中的 target，
 * 返回第一个熔断器允许通过的 target。
 *
 * 对应原项目 tryTargetsRecursively() FALLBACK 分支中的 isOpen 过滤逻辑。
 *
 * 注意：此函数只做"选择"，不做实际请求。
 * 熔断器状态更新（recordSuccess/recordFailure）由外层调用方（index.ts）负责，
 * 在拿到 proxyService 的响应后根据 onStatusCodes 决定是否触发。
 *
 * @param targets        候选 target 列表
 * @param _onStatusCodes 触发 fallback 的状态码（透传给调用方使用）
 */
function selectFallbackTarget(
  targets:        Target[],
  _onStatusCodes: number[], // 供调用层判断何时调用 recordFailure，此处暂不使用
): Target {
  for (const target of targets) {
    const key = getTargetKey(target)
    const cb  = getCircuitBreaker(key, target.cbConfig)

    if (cb.canRequest()) {
      // 此 target 熔断器允许请求通过（CLOSED 或 HALF_OPEN 探测名额未耗尽）
      return target
    }
    // 此 target 处于 OPEN 状态（熔断中），跳过，继续检查下一个
  }

  // 所有 target 都熔断了
  throw new Error(
    'routeRequest [fallback]: all targets are circuit-breaker OPEN — no healthy target available',
  )
}

// ─────────────────────────────────────────────
// 导出工具函数（供 index.ts 在请求完成后更新熔断器状态）
// ─────────────────────────────────────────────

/**
 * 根据响应状态更新目标 target 的熔断器状态
 *
 * 调用时机：proxyService 完成请求后，在 index.ts 中调用
 *
 * @param target         本次请求的 target
 * @param responseStatus HTTP 响应状态码（网络错误时传 0）
 * @param onStatusCodes  触发熔断的状态码列表
 */
export function updateCircuitBreaker(
  target:         Target,
  responseStatus: number,
  onStatusCodes:  number[] = DEFAULT_FALLBACK_STATUS_CODES,
): void {
  const key = getTargetKey(target)
  const cb  = getCircuitBreaker(key, target.cbConfig)

  if (responseStatus === 0 || onStatusCodes.includes(responseStatus)) {
    // 失败：网络错误（0）或状态码在熔断触发列表中
    cb.recordFailure()
  } else {
    // 成功：状态码不在熔断触发列表中
    cb.recordSuccess()
  }
}
