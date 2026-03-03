/**
 * 代理服务（占位模块）
 *
 * 负责将路由选好的请求转发给团队的 Go 服务处理。
 * 当前仅定义接口和方法签名，具体转发逻辑待 Go 端配合后实现。
 *
 * 预期工作流程：
 *   1. strategyRouter 选出目标 target
 *   2. 调用 proxyToGoService() 将原始请求连同 target 信息一起发给 Go 服务
 *   3. Go 服务持有真实的 Provider API Key（通过 virtualKey 映射），负责实际 AI 调用
 *   4. Go 服务返回响应，此处透传回客户端（支持流式 SSE）
 */

import type { Target } from '../types/config.js'

// ─────────────────────────────────────────────
// 请求 / 响应结构
// ─────────────────────────────────────────────

/**
 * 转发请求体
 *
 * 包含路由决策结果 + 原始请求信息，由 index.ts 组装后传入。
 */
export interface ProxyRequest {
  /** strategyRouter 选出的路由目标 */
  target: Target

  /**
   * 原始客户端请求（Web API Request 对象）
   * 包含 body（可能是流式）、method、url 等信息
   */
  originalRequest: Request

  /**
   * 需要转发给 Go 服务的请求头
   * index.ts 负责从原始请求中提取并清理（去掉网关内部 header）
   *
   * 通常包括：
   * - Content-Type
   * - Authorization（若有）
   * - x-request-id（追踪用）
   * - 业务自定义 header
   */
  headers: Record<string, string>
}

/**
 * 转发响应体
 *
 * Go 服务返回的响应，由 proxyToGoService() 解析后透传给客户端。
 */
export interface ProxyResponse {
  /** HTTP 状态码（用于熔断器判断和重试判断） */
  status: number

  /**
   * 响应头（透传给客户端）
   * 通常包含 Content-Type、x-request-id 等
   */
  headers: Record<string, string>

  /**
   * 响应体
   * - 普通响应：string（JSON 字符串）
   * - 流式响应（SSE / stream=true）：ReadableStream
   */
  body: ReadableStream | string
}

// ─────────────────────────────────────────────
// 主函数（待实现）
// ─────────────────────────────────────────────

/**
 * 将请求代理转发至 Go 服务
 *
 * TODO: 实现转发逻辑，预期行为：
 *
 * 1. 根据 req.target 构建转发目标 URL
 *    - Go 服务地址从环境变量 GO_SERVICE_URL 读取
 *    - 目标路径与原始请求路径保持一致（如 /v1/chat/completions）
 *
 * 2. 将 req.target 的路由信息以自定义 header 传给 Go 服务
 *    - x-gateway-provider:   target.provider
 *    - x-gateway-model:      target.model
 *    - x-gateway-virtual-key: target.virtualKey
 *    - x-gateway-override-params: JSON.stringify(target.overrideParams)（如有）
 *
 * 3. 透传原始请求 body（需支持 streaming，避免在网关层 buffer）
 *
 * 4. 透传 Go 服务的响应：
 *    - 普通响应：读取全部 body 后返回 string
 *    - 流式响应（Content-Type: text/event-stream）：
 *      直接返回 ReadableStream，由调用方（index.ts）透传给客户端
 *
 * 5. 错误处理：
 *    - 网络层错误（Go 服务不可达）→ 抛出 RetryableError(503)
 *    - 超时 → 抛出 RetryableError(504)
 *    - Go 服务返回 4xx/5xx → 返回 ProxyResponse（由调用层决定是否重试）
 *
 * @param req  转发请求（target + 原始请求 + headers）
 * @returns    Go 服务的响应
 */
export async function proxyToGoService(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _req: ProxyRequest,
): Promise<ProxyResponse> {
  // TODO: 待 Go 服务接口确定后实现
  throw new Error(
    'proxyToGoService not implemented yet — pending Go service integration',
  )
}
