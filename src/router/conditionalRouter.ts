/**
 * 条件路由模块
 *
 * 支持 MongoDB 风格的条件匹配，对请求上下文中的字段进行评估，
 * 选中首个匹配规则对应的 target。
 *
 * 支持的操作符：
 *   比较：$eq $ne $gt $gte $lt $lte
 *   数组：$in $nin
 *   正则：$regex
 *   逻辑：$and $or
 */

import type { ConditionalRule, Target, RequestContext } from '../types/config.js'

// ─────────────────────────────────────────────
// 查询上下文：条件匹配时可访问的字段空间
// ─────────────────────────────────────────────

interface QueryContext {
  metadata: Record<string, unknown>
  model:    string | undefined
  // 可扩展：未来可加入 url.pathname、headers 等
}

function buildQueryContext(context: RequestContext): QueryContext {
  return {
    metadata: context.metadata ?? {},
    model:    context.model,
  }
}

// ─────────────────────────────────────────────
// 字段访问（支持点号路径，如 "metadata.region"）
// ─────────────────────────────────────────────

function getFieldValue(ctx: QueryContext, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = ctx

  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

// ─────────────────────────────────────────────
// 操作符求值
// ─────────────────────────────────────────────

function evaluateOperator(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case '$eq':  return actual === expected
    case '$ne':  return actual !== expected
    case '$gt':  return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case '$gte': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case '$lt':  return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case '$lte': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    case '$in':  return Array.isArray(expected) && expected.includes(actual)
    case '$nin': return Array.isArray(expected) && !expected.includes(actual)
    case '$regex':
      if (typeof actual !== 'string' || typeof expected !== 'string') return false
      try {
        return new RegExp(expected).test(actual)
      } catch {
        // 无效正则表达式视为不匹配（防御 ReDoS / 语法错误）
        return false
      }
    default:
      return false
  }
}

// ─────────────────────────────────────────────
// 条件求值（递归处理逻辑操作符）
// ─────────────────────────────────────────────

function evaluateCondition(
  query: Record<string, unknown>,
  ctx: QueryContext,
): boolean {
  for (const [key, value] of Object.entries(query)) {
    // 逻辑操作符：$and / $or — value 是子查询数组
    if (key === '$and') {
      if (!Array.isArray(value)) return false
      if (!value.every(q => evaluateCondition(q as Record<string, unknown>, ctx))) return false
      continue
    }
    if (key === '$or') {
      if (!Array.isArray(value)) return false
      if (!value.some(q => evaluateCondition(q as Record<string, unknown>, ctx))) return false
      continue
    }

    // 普通字段匹配
    const actualValue = getFieldValue(ctx, key)

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // 操作符对象：{ "$eq": "us-west" }
      const ops = value as Record<string, unknown>
      for (const [op, expected] of Object.entries(ops)) {
        if (!evaluateOperator(actualValue, op, expected)) return false
      }
    } else {
      // 简写等值匹配：{ "model": "gpt-4" }
      if (actualValue !== value) return false
    }
  }
  return true
}

// ─────────────────────────────────────────────
// 按 index 字段查找 target
// ─────────────────────────────────────────────

function findTargetByIndex(targets: Target[], idx: string): Target | null {
  // 优先按 target.index 字段匹配
  const byField = targets.find(t => t.index === idx)
  if (byField) return byField

  // 降级：按数组下标字符串匹配（"0", "1", "2"...）
  const pos = parseInt(idx, 10)
  return Number.isFinite(pos) && pos >= 0 && pos < targets.length
    ? targets[pos]
    : null
}

// ─────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────

/**
 * 按条件规则选择 target
 *
 * @param rules        条件规则列表（按顺序依次尝试）
 * @param defaultIndex 无匹配时的默认 target index（undefined 则返回 null）
 * @param targets      候选 target 列表
 * @param context      请求上下文（用于条件匹配）
 * @returns            匹配到的 target，或 null（无匹配且无默认）
 */
export function matchTarget(
  rules:        ConditionalRule[],
  defaultIndex: string | undefined,
  targets:      Target[],
  context:      RequestContext,
): Target | null {
  const ctx = buildQueryContext(context)

  // 按顺序评估每条规则，返回第一个匹配的 target
  for (const rule of rules) {
    const matched = evaluateCondition(rule.query as Record<string, unknown>, ctx)
    if (matched) {
      return findTargetByIndex(targets, rule.then)
    }
  }

  // 所有规则均未匹配 → 尝试 default
  if (defaultIndex !== undefined) {
    return findTargetByIndex(targets, defaultIndex)
  }

  return null
}
