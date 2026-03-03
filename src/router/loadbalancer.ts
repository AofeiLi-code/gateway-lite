/**
 * 负载均衡模块
 *
 * 两种选择策略：
 * 1. 用户粘性哈希（有 userId）：同一用户始终命中同一 target
 * 2. 权重随机（无 userId）：按 weight 字段概率选择
 *
 * 参考原项目 selectProviderByWeight() 逻辑（handlerUtils.ts L204-L231）。
 */

import type { Target } from '../types/config.js'

// ─────────────────────────────────────────────
// djb2 哈希算法
// ─────────────────────────────────────────────

/**
 * djb2 字符串哈希：简单、快速、分布均匀
 * 返回值为无符号 32 位整数（[0, 0xFFFFFFFF]）
 */
function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    // hash * 33 XOR charCode（位运算版：hash << 5 + hash = hash * 33）
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
    // 保持 32 位无符号，避免负数
    hash = hash >>> 0
  }
  return hash
}

// ─────────────────────────────────────────────
// 内部：计算归一化权重列表
// ─────────────────────────────────────────────

function getWeights(targets: Target[]): number[] {
  // 未设置 weight 的 target 默认权重为 1（与原项目行为一致）
  return targets.map(t => t.weight ?? 1)
}

// ─────────────────────────────────────────────
// 内部：按位置在权重区间内选 target
// ─────────────────────────────────────────────

/**
 * 给定 position ∈ [0, totalWeight)，遍历权重桶找到对应 target
 */
function pickByPosition(targets: Target[], weights: number[], position: number): Target {
  for (let i = 0; i < targets.length; i++) {
    if (position < weights[i]) return targets[i]
    position -= weights[i]
  }
  // 浮点精度兜底：返回最后一个（正常情况不会触发）
  return targets[targets.length - 1]
}

// ─────────────────────────────────────────────
// 策略一：权重随机选择
// ─────────────────────────────────────────────

/**
 * 按权重概率随机选择 target
 * 原项目：Math.random() * totalWeight → 遍历累积权重桶
 */
function selectByWeight(targets: Target[]): Target {
  const weights     = getWeights(targets)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight <= 0) {
    throw new Error('loadbalancer: total weight must be greater than 0')
  }
  const position    = Math.random() * totalWeight
  return pickByPosition(targets, weights, position)
}

// ─────────────────────────────────────────────
// 策略二：用户粘性一致性哈希
// ─────────────────────────────────────────────

/**
 * 基于 userId 的一致性哈希选择 target
 *
 * 原理：
 * 1. djb2(userId) → 32 位无符号整数 hash
 * 2. 归一化到 [0, 1)：hash / 2^32
 * 3. 乘以 totalWeight → position ∈ [0, totalWeight)
 * 4. 遍历权重桶，找到对应 target
 *
 * 同一 userId 的 hash 固定 → position 固定 → 命中同一 target
 * 支持浮点权重，分布与随机策略一致
 */
function selectByUserId(targets: Target[], userId: string): Target {
  const weights     = getWeights(targets)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight <= 0) {
    throw new Error('loadbalancer: total weight must be greater than 0')
  }

  // 2^32 = 0x100000000；hash / 2^32 ∈ [0, 1)
  const hash     = djb2Hash(userId)
  const position = (hash / 0x100000000) * totalWeight

  return pickByPosition(targets, weights, position)
}

// ─────────────────────────────────────────────
// 导出：统一入口
// ─────────────────────────────────────────────

/**
 * 选择路由目标
 *
 * @param targets  候选 target 列表（至少 1 个）
 * @param userId   用户 ID（有值则启用粘性哈希，否则随机权重选择）
 * @returns        选中的 target
 */
export function selectTarget(targets: Target[], userId?: string): Target {
  if (targets.length === 0) {
    throw new Error('loadbalancer.selectTarget: targets array is empty')
  }
  // 单 target 快速返回，避免无意义计算
  if (targets.length === 1) return targets[0]

  return userId
    ? selectByUserId(targets, userId)
    : selectByWeight(targets)
}
