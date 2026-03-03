/**
 * 核心路由引擎冒烟测试
 *
 * 覆盖范围：
 *   Loadbalancer   — 权重选择 + 用户粘性哈希
 *   Conditional    — 条件匹配 / 无匹配 / 默认 / 点号路径
 *   Fallback       — 正常路由 / 熔断后切换 / 全部熔断报错
 *   CircuitBreaker — 状态流转：CLOSED → OPEN → HALF_OPEN → CLOSED
 *   RetryHandler   — 成功重试 / 非重试错误透传 / 重试耗尽
 */

import { selectTarget }              from '../router/loadbalancer.js'
import { matchTarget }               from '../router/conditionalRouter.js'
import { routeRequest }              from '../router/strategyRouter.js'
import {
  CircuitBreaker,
  getCircuitBreaker,
  resetAllCircuitBreakers,
}                                    from '../services/circuitBreaker.js'
import { withRetry, RetryableError } from '../services/retryHandler.js'
import type {
  Target,
  RequestContext,
  GatewayConfig,
}                                    from '../types/config.js'

// ─────────────────────────────────────────────
// 测试工具
// ─────────────────────────────────────────────

const makeCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  requestId: 'test-request-id',
  timestamp: Date.now(),
  ...overrides,
})

// ─────────────────────────────────────────────
// Loadbalancer
// ─────────────────────────────────────────────

describe('Loadbalancer', () => {
  it('never selects a target with weight 0', () => {
    const targets: Target[] = [
      { provider: 'zero',   weight: 0 },
      { provider: 'always', weight: 1 },
    ]
    // weight=0 的概率区间长度为 0，理论上永不命中（200次验证）
    for (let i = 0; i < 200; i++) {
      expect(selectTarget(targets).provider).toBe('always')
    }
  })

  it('same userId returns the same target every time (sticky hash)', () => {
    const targets: Target[] = [
      { provider: 'a', weight: 1 },
      { provider: 'b', weight: 1 },
      { provider: 'c', weight: 1 },
    ]
    const userId = 'user-sticky-test-abc123'
    const first = selectTarget(targets, userId).provider
    for (let i = 0; i < 10; i++) {
      expect(selectTarget(targets, userId).provider).toBe(first)
    }
  })

  it('different userIds distribute across targets', () => {
    const targets: Target[] = [
      { provider: 'a', weight: 1 },
      { provider: 'b', weight: 1 },
    ]
    const providers = new Set<string>()
    // 100 个不同 userId，djb2 哈希分布均匀，两个 target 都应该命中
    for (let i = 0; i < 100; i++) {
      providers.add(selectTarget(targets, `user-${i}`).provider)
    }
    expect(providers.size).toBe(2)
  })

  it('throws when targets array is empty', () => {
    expect(() => selectTarget([])).toThrow()
  })
})

// ─────────────────────────────────────────────
// Conditional Router
// ─────────────────────────────────────────────

describe('Conditional Router', () => {
  const targets: Target[] = [
    { provider: 'budget-provider',  index: 'budget'  },
    { provider: 'premium-provider', index: 'premium' },
  ]

  it('matches $eq operator and routes to correct target', () => {
    const rules = [{ query: { model: { $eq: 'gpt-4' } }, then: 'premium' }]
    const result = matchTarget(rules, undefined, targets, makeCtx({ model: 'gpt-4' }))
    expect(result?.provider).toBe('premium-provider')
  })

  it('returns null when no rule matches and no default', () => {
    const rules = [{ query: { model: { $eq: 'gpt-4' } }, then: 'premium' }]
    const result = matchTarget(rules, undefined, targets, makeCtx({ model: 'claude-3' }))
    expect(result).toBeNull()
  })

  it('falls back to default index when no rule matches', () => {
    const rules = [{ query: { model: { $eq: 'gpt-4' } }, then: 'premium' }]
    const result = matchTarget(rules, 'budget', targets, makeCtx({ model: 'claude-3' }))
    expect(result?.provider).toBe('budget-provider')
  })

  it('matches metadata field via dot-path notation', () => {
    const rules = [
      { query: { 'metadata.region': { $eq: 'us-west' } }, then: 'premium' },
    ]
    const ctx = makeCtx({ metadata: { region: 'us-west' } })
    expect(matchTarget(rules, undefined, targets, ctx)?.provider).toBe('premium-provider')
  })

  it('supports $in operator for array membership', () => {
    const rules = [
      { query: { model: { $in: ['gpt-4', 'gpt-4o'] } }, then: 'premium' },
    ]
    expect(matchTarget(rules, undefined, targets, makeCtx({ model: 'gpt-4o' }))?.provider)
      .toBe('premium-provider')
    expect(matchTarget(rules, undefined, targets, makeCtx({ model: 'claude-3' })))
      .toBeNull()
  })

  it('supports $and logical operator', () => {
    const rules = [
      {
        query: {
          $and: [
            { model: { $eq: 'gpt-4' } },
            { 'metadata.tier': { $eq: 'premium' } },
          ],
        },
        then: 'premium',
      },
    ]
    // 两个条件都满足 → 命中
    const ctx1 = makeCtx({ model: 'gpt-4', metadata: { tier: 'premium' } })
    expect(matchTarget(rules, undefined, targets, ctx1)?.provider).toBe('premium-provider')

    // 只满足一个条件 → 不命中
    const ctx2 = makeCtx({ model: 'gpt-4', metadata: { tier: 'free' } })
    expect(matchTarget(rules, undefined, targets, ctx2)).toBeNull()
  })
})

// ─────────────────────────────────────────────
// Fallback mode（通过 routeRequest 集成测试）
// ─────────────────────────────────────────────

describe('Fallback mode', () => {
  // provider:model:virtualKey 组合的熔断器 key（与 strategyRouter.getTargetKey 一致）
  const KEY_PRIMARY   = 'primary:gpt-4:key-a'
  const KEY_SECONDARY = 'secondary:gpt-4:key-b'

  const config: GatewayConfig = {
    strategy: { mode: 'fallback' },
    targets: [
      {
        provider: 'primary', model: 'gpt-4', virtualKey: 'key-a',
        cbConfig: { failureThreshold: 3 },
      },
      { provider: 'secondary', model: 'gpt-4', virtualKey: 'key-b' },
    ],
  }
  const ctx = makeCtx()

  beforeEach(() => resetAllCircuitBreakers())

  it('returns first target when all circuit breakers are CLOSED', async () => {
    const { target } = await routeRequest(config, ctx)
    expect(target.provider).toBe('primary')
  })

  it('skips OPEN target and returns next healthy one', async () => {
    // 手动触发 primary 熔断（failureThreshold=3）
    const cb = getCircuitBreaker(KEY_PRIMARY, { failureThreshold: 3 })
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')

    const { target } = await routeRequest(config, ctx)
    expect(target.provider).toBe('secondary')
  })

  it('throws when all targets are circuit-breaker OPEN', async () => {
    for (const key of [KEY_PRIMARY, KEY_SECONDARY]) {
      const cb = getCircuitBreaker(key, { failureThreshold: 1 })
      cb.recordFailure()
    }
    await expect(routeRequest(config, ctx)).rejects.toThrow('OPEN')
  })
})

// ─────────────────────────────────────────────
// CircuitBreaker
// ─────────────────────────────────────────────

describe('CircuitBreaker', () => {
  it('starts in CLOSED state and allows requests', () => {
    const cb = new CircuitBreaker()
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.canRequest()).toBe(true)
  })

  it('becomes OPEN after reaching failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 })
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
    expect(cb.canRequest()).toBe(false)
  })

  it('does not open on fewer failures than threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 })
    cb.recordFailure(); cb.recordFailure()          // only 2 failures
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.canRequest()).toBe(true)
  })

  it('resets failure count after a success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 })
    cb.recordFailure(); cb.recordFailure()
    cb.recordSuccess()                             // reset
    cb.recordFailure(); cb.recordFailure()         // only 2 after reset
    expect(cb.getState()).toBe('CLOSED')
  })

  it('transitions to HALF_OPEN after resetTimeout expires', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 30 })
    cb.recordFailure(); cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
    expect(cb.canRequest()).toBe(false)           // still in reset window

    await new Promise(r => setTimeout(r, 60))    // wait past timeout

    expect(cb.canRequest()).toBe(true)            // triggers OPEN → HALF_OPEN
    expect(cb.getState()).toBe('HALF_OPEN')
  })

  it('recovers to CLOSED after successful probe in HALF_OPEN', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 20 })
    cb.recordFailure(); cb.recordFailure()
    await new Promise(r => setTimeout(r, 40))
    cb.canRequest()                               // enter HALF_OPEN
    cb.recordSuccess()
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.canRequest()).toBe(true)
  })

  it('returns to OPEN on failed probe in HALF_OPEN', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 20 })
    cb.recordFailure(); cb.recordFailure()
    await new Promise(r => setTimeout(r, 40))
    cb.canRequest()                               // enter HALF_OPEN
    cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
    expect(cb.canRequest()).toBe(false)
  })

  it('manual reset restores CLOSED state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 })
    cb.recordFailure(); cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
    cb.reset()
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.canRequest()).toBe(true)
  })
})

// ─────────────────────────────────────────────
// RetryHandler
// ─────────────────────────────────────────────

describe('RetryHandler', () => {
  it('returns value on second attempt after first RetryableError', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        if (++calls < 2) throw new RetryableError(500)
        return 'success'
      },
      { attempts: 1, baseDelay: 0 },
    )
    expect(result).toBe('success')
    expect(calls).toBe(2)
  })

  it('does not retry non-RetryableError — throws immediately', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => { calls++; throw new Error('business error') },
        { attempts: 3, baseDelay: 0 },
      ),
    ).rejects.toThrow('business error')
    expect(calls).toBe(1)                        // no retries
  })

  it('exhausts all attempts and re-throws last RetryableError', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => { calls++; throw new RetryableError(503) },
        { attempts: 2, baseDelay: 0 },
      ),
    ).rejects.toBeInstanceOf(RetryableError)
    expect(calls).toBe(3)                        // 1 initial + 2 retries
  })

  it('does not retry RetryableError with status not in onStatusCodes', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => { calls++; throw new RetryableError(404) },
        { attempts: 3, baseDelay: 0, onStatusCodes: [500, 503] },
      ),
    ).rejects.toBeInstanceOf(RetryableError)
    expect(calls).toBe(1)                        // 404 not retryable
  })

  it('succeeds with zero retry config when fn succeeds first try', async () => {
    const result = await withRetry(
      async () => 42,
      { attempts: 0 },
    )
    expect(result).toBe(42)
  })
})
