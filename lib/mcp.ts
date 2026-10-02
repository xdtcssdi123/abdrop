/**
 * MCP(Model Context Protocol)服务 —— JSON-RPC 2.0 处理层(纯逻辑,可单测)。
 *
 * 挂在局域网 Web 服务的 `/mcp` 端点上,让外部 AI Agent(Claude Desktop /
 * Claude Code 等)通过标准工具调用读写 ABDrop 的卡片、合集与配置。
 *
 * 协议:JSON-RPC 2.0 over HTTP(Streamable HTTP transport 的 JSON 形态)。
 * 核心消息:
 *   - initialize            → 握手,声明协议版本与能力
 *   - notifications/initialized → 客户端确认初始化(无需响应)
 *   - tools/list            → 列出全部工具(含 JSON Schema)
 *   - tools/call            → 调用某个工具,操作真实数据
 *   - ping                  → 存活检查
 *
 * 工具全部复用 lib/lan-api 的 deps(同一套真实仓库与配置读写)。
 */
import type { CardRepository } from '~/lib/db'
import type { AIConfig, Collection, KnowledgeCard } from '~/types'
import type { CheckinConfig } from '~/lib/checkin'
import { maskApiKey, toCardView } from '~/lib/lan-api'

/** 与 lib/lan-api 相同的依赖面 —— MCP 工具与 Web API 读写同一份数据。 */
export interface McpDeps {
  repo: CardRepository
  version: string
  getAIConfig(): Promise<AIConfig>
  saveAIConfig(cfg: AIConfig): Promise<void>
  getActiveCollectionId(): Promise<string>
  setActiveCollectionId(id: string): Promise<void>
  getCheckinConfig(): Promise<CheckinConfig>
  saveCheckinConfig(cfg: CheckinConfig): Promise<void>
  getFullscreenPreference(): Promise<boolean>
  setFullscreenPreference(on: boolean): Promise<void>
}

/** 对外 JSON-RPC 响应(与 LanResponse 同构,便于 lan-api 转发)。 */
export interface McpHttpResponse {
  status: number
  contentType: string
  body: string
}

/** MCP 协议版本(2025-06-18 为当前稳定版)。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'
/** 服务器声明。 */
export const MCP_SERVER_NAME = 'abdrop-mcp'

/** JSON-RPC 请求(入站)。 */
export interface JsonRpcRequest {
  jsonrpc: string
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

/** 单个工具的声明(JSON Schema 形式)。 */
export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** 工具名 → 执行函数。 */
export type ToolHandler = (
  args: Record<string, unknown>,
  deps: McpDeps,
) => Promise<unknown>

/** 卡片视图(与 lan-api 一致,供 Agent 读取)。 */
export interface McpCardView {
  id: string
  front: string
  back: string
  tags: string[]
  collectionId: string
  collectionName: string
  image: boolean
  createdAt: number
}

/** 定义全部工具及其 schema。 */
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'abdrop_health',
    description: '查看 ABDrop 健康状态:版本号、卡片总数、合集数。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'abdrop_list_cards',
    description: '列出卡片。可传 collectionId 只看某个合集(不传则全部)。返回每张卡的 id / 正面 / 背面 / 标签 / 所属合集。',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: { type: 'string', description: '合集 id;省略则列出全部卡片' },
      },
    },
  },
  {
    name: 'abdrop_add_card',
    description: '新增一张卡片。front(正面)必填;back、tags、collectionId 可选;不传合集则进「未分类」。',
    inputSchema: {
      type: 'object',
      properties: {
        front: { type: 'string', description: '正面:问题 / 知识点标题(必填)' },
        back: { type: 'string', description: '背面:答案 / 解释(可选)' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组(可选)' },
        collectionId: { type: 'string', description: '合集 id(可选,默认未分类)' },
      },
      required: ['front'],
    },
  },
  {
    name: 'abdrop_delete_card',
    description: '删除一张卡片(按 id)。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的卡片 id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'abdrop_list_collections',
    description: '列出全部合集,以及当前复习范围(activeCollectionId)。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'abdrop_create_collection',
    description: '新建一个合集,返回其 id。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '合集名称(必填)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'abdrop_set_scope',
    description: '切换复习范围(首页刷卡按此范围)。传合集 id;传 "__all__" 表示全部。',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: { type: 'string', description: '合集 id,或 __all__ 表示复习全部' },
      },
      required: ['collectionId'],
    },
  },
  {
    name: 'abdrop_get_config',
    description: '读取配置:AI 接口(apiKey 打码)、打卡提醒、全屏沉浸。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'abdrop_set_config',
    description: '更新配置。ai: 启用/接口地址/模型/识别图片/超时(apiKey 传新值才覆盖,打码值忽略);checkin: 开关/开始结束分钟;fullscreen: 布尔。',
    inputSchema: {
      type: 'object',
      properties: {
        ai: {
          type: 'object',
          description: 'AI 配置',
          properties: {
            enabled: { type: 'boolean' },
            baseUrl: { type: 'string' },
            model: { type: 'string' },
            apiKey: { type: 'string' },
            vision: { type: 'boolean' },
            timeoutMs: { type: 'number' },
          },
        },
        checkin: {
          type: 'object',
          description: '打卡提醒配置',
          properties: {
            enabled: { type: 'boolean' },
            startMinute: { type: 'number' },
            endMinute: { type: 'number' },
          },
        },
        fullscreen: { type: 'boolean', description: '全屏沉浸(隐藏状态栏)' },
      },
    },
  },
]

/** 把卡片映射为 Agent 可读视图(附合集名)。 */
async function cardsToViews(deps: McpDeps): Promise<McpCardView[]> {
  const [cards, collections] = await Promise.all([deps.repo.listCards(), deps.repo.listCollections()])
  const nameOf = (id: string) => collections.find((c) => c.id === id)?.name ?? '未分类'
  return cards.map((c: KnowledgeCard) => toCardView(c, nameOf))
}

/** 工具执行表。 */
const HANDLERS: Record<string, ToolHandler> = {
  async abdrop_health(_args, deps) {
    const [cards, collections] = await Promise.all([deps.repo.countCards(), deps.repo.listCollections()])
    return { ok: true, version: deps.version, cards, collections: collections.length }
  },

  async abdrop_list_cards(args, deps) {
    const all = await cardsToViews(deps)
    const filter = typeof args.collectionId === 'string' && args.collectionId ? args.collectionId : null
    return filter ? { cards: all.filter((c) => c.collectionId === filter) } : { cards: all }
  },

  async abdrop_add_card(args, deps) {
    const front = String(args.front ?? '').trim()
    if (!front) throw new Error('front(正面)不能为空')
    const card = await deps.repo.addCard({
      front,
      back: String(args.back ?? ''),
      sourceText: String(args.back ?? ''),
      collectionId: typeof args.collectionId === 'string' ? args.collectionId : undefined,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
    })
    const collections = await deps.repo.listCollections()
    const nameOf = (id: string) => collections.find((c) => c.id === id)?.name ?? '未分类'
    return { ok: true, card: toCardView(card, nameOf) }
  },

  async abdrop_delete_card(args, deps) {
    const id = String(args.id ?? '').trim()
    if (!id) throw new Error('缺少卡片 id')
    await deps.repo.removeCard(id)
    return { ok: true, id }
  },

  async abdrop_list_collections(_args, deps) {
    const [collections, active] = await Promise.all([deps.repo.listCollections(), deps.getActiveCollectionId()])
    return {
      collections: collections.map((c: Collection) => ({ id: c.id, name: c.name, order: c.order })),
      activeCollectionId: active,
    }
  },

  async abdrop_create_collection(args, deps) {
    const name = String(args.name ?? '').trim()
    if (!name) throw new Error('name 不能为空')
    const col = await deps.repo.createCollection(name)
    return { ok: true, collection: { id: col.id, name: col.name, order: col.order } }
  },

  async abdrop_set_scope(args, deps) {
    const id = String(args.collectionId ?? '').trim()
    if (!id) throw new Error('collectionId 不能为空')
    await deps.setActiveCollectionId(id)
    return { ok: true, activeCollectionId: id }
  },

  async abdrop_get_config(_args, deps) {
    const [ai, checkin, fullscreen] = await Promise.all([
      deps.getAIConfig(),
      deps.getCheckinConfig(),
      deps.getFullscreenPreference(),
    ])
    return {
      ai: {
        enabled: ai.enabled,
        provider: ai.provider,
        baseUrl: ai.baseUrl,
        model: ai.model,
        vision: ai.vision,
        timeoutMs: ai.timeoutMs,
        apiKeyMasked: maskApiKey(ai.apiKey),
      },
      checkin,
      fullscreen,
    }
  },

  async abdrop_set_config(args, deps) {
    const aiIn = args.ai as Record<string, unknown> | undefined
    if (aiIn && typeof aiIn === 'object') {
      const current = await deps.getAIConfig()
      const next: AIConfig = { ...current }
      if (typeof aiIn.enabled === 'boolean') next.enabled = aiIn.enabled
      if (typeof aiIn.provider === 'string' && aiIn.provider) next.provider = aiIn.provider as AIConfig['provider']
      if (typeof aiIn.baseUrl === 'string') next.baseUrl = aiIn.baseUrl
      if (typeof aiIn.model === 'string') next.model = aiIn.model
      if (typeof aiIn.vision === 'boolean') next.vision = aiIn.vision
      if (typeof aiIn.timeoutMs === 'number' && aiIn.timeoutMs > 0) next.timeoutMs = aiIn.timeoutMs
      if (typeof aiIn.apiKey === 'string' && aiIn.apiKey && !aiIn.apiKey.includes('*')) {
        next.apiKey = aiIn.apiKey
      }
      await deps.saveAIConfig(next)
    }

    const checkinIn = args.checkin as Record<string, unknown> | undefined
    if (checkinIn && typeof checkinIn === 'object') {
      const current = await deps.getCheckinConfig()
      const next: CheckinConfig = { ...current }
      if (typeof checkinIn.enabled === 'boolean') next.enabled = checkinIn.enabled
      if (typeof checkinIn.startMinute === 'number') next.startMinute = checkinIn.startMinute
      if (typeof checkinIn.endMinute === 'number') next.endMinute = checkinIn.endMinute
      await deps.saveCheckinConfig(next)
    }

    if (typeof args.fullscreen === 'boolean') {
      await deps.setFullscreenPreference(args.fullscreen)
    }

    return { ok: true }
  },
}

/** 构造 JSON-RPC 成功响应。 */
function rpcResult(id: JsonRpcRequest['id'], result: unknown): unknown {
  return { jsonrpc: '2.0', id, result }
}

/** 构造 JSON-RPC 错误响应。 */
function rpcError(id: JsonRpcRequest['id'], code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/** JSON-RPC 错误码(MCP 规范约定)。 */
const ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const

/**
 * 处理一条 JSON-RPC 消息(纯函数)。
 * 永不抛异常 —— 任何错误都转成 JSON-RPC error 响应。
 */
export async function handleMcpMessage(
  rawBody: string,
  deps: McpDeps,
): Promise<McpHttpResponse> {
  let req: JsonRpcRequest
  try {
    const parsed = JSON.parse(rawBody || 'null')
    if (!parsed || typeof parsed !== 'object' || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return { status: 400, contentType: 'application/json', body: JSON.stringify(rpcError(null, ERROR.INVALID_REQUEST, '无效的 JSON-RPC 请求')) }
    }
    req = parsed as JsonRpcRequest
  } catch {
    return { status: 400, contentType: 'application/json', body: JSON.stringify(rpcError(null, ERROR.PARSE, 'JSON 解析失败')) }
  }

  try {
    switch (req.method) {
      case 'initialize': {
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            rpcResult(req.id, {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: MCP_SERVER_NAME, version: deps.version },
            }),
          ),
        }
      }

      // 客户端确认初始化完成 —— 通知类消息无响应
      case 'notifications/initialized':
        return { status: 200, contentType: 'application/json', body: '' }

      case 'ping':
        return { status: 200, contentType: 'application/json', body: JSON.stringify(rpcResult(req.id, {})) }

      case 'tools/list':
        return { status: 200, contentType: 'application/json', body: JSON.stringify(rpcResult(req.id, { tools: MCP_TOOLS })) }

      case 'tools/call': {
        const name = typeof req.params?.name === 'string' ? req.params.name : ''
        const handler = HANDLERS[name]
        if (!handler) {
          return { status: 200, contentType: 'application/json', body: JSON.stringify(rpcError(req.id, ERROR.METHOD_NOT_FOUND, `未知工具: ${name}`)) }
        }
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>
        try {
          const result = await handler(args, deps)
          return {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              rpcResult(req.id, {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                isError: false,
              }),
            ),
          }
        } catch (err) {
          return {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              rpcResult(req.id, {
                content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
                isError: true,
              }),
            ),
          }
        }
      }

      default:
        return { status: 200, contentType: 'application/json', body: JSON.stringify(rpcError(req.id, ERROR.METHOD_NOT_FOUND, `未知方法: ${req.method}`)) }
    }
  } catch (err) {
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(rpcError(req.id, ERROR.INTERNAL, err instanceof Error ? err.message : String(err))),
    }
  }
}