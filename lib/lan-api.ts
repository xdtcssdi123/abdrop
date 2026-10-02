/**
 * 局域网 Web 服务 —— API 路由层(纯逻辑,可单测)。
 *
 * 原生 HTTP 服务器收到请求后把 method/path/body 交给本模块,
 * 这里读写 IndexedDB / localStorage(经注入的依赖),返回 HTTP 响应。
 * 与原生桥接层(composables/useLanServer.ts)解耦,便于在浏览器与测试环境验证。
 *
 * 路由:
 *   GET  /                  → 管理页 HTML(内置)
 *   GET  /api/health        → 版本 / 卡片数 / 合集数
 *   GET  /api/cards         → 卡片列表(可按 ?collectionId= 过滤)
 *   POST /api/cards         → 新增卡片
 *   DELETE /api/cards/:id   → 删除卡片
 *   GET  /api/collections   → 合集列表 + 当前复习范围
 *   POST /api/collections   → 新建合集
 *   POST /api/scope         → 切换复习范围
 *   GET  /api/config        → AI 配置(apiKey 打码)+ 打卡 + 全屏
 *   POST /api/config        → 保存 AI 配置 / 打卡 / 全屏
 */

import type { CardRepository } from '~/lib/db'
import type { AIConfig, Collection, KnowledgeCard } from '~/types'
import type { CheckinConfig } from '~/lib/checkin'
import { LAN_ADMIN_HTML } from '~/lib/lan-admin'
import { handleMcpMessage } from '~/lib/mcp'

/** 路由层需要的全部外部能力,由调用方(useLanServer)注入。 */
export interface LanApiDeps {
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

export interface LanResponse {
  status: number
  contentType: string
  body: string
}

/** 解析请求路径与查询参数。 */
export function parsePath(raw: string): { path: string; query: Record<string, string> } {
  const [path, queryStr = ''] = raw.split('?')
  const query: Record<string, string> = {}
  if (queryStr) {
    for (const pair of queryStr.split('&')) {
      const [k, v = ''] = pair.split('=')
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v)
    }
  }
  return { path, query }
}

/** 卡片对外展示(不暴露调度字段,保持接口干净)。 */
export interface CardView {
  id: string
  front: string
  back: string
  tags: string[]
  collectionId: string
  collectionName: string
  image: boolean
  createdAt: number
}

/** 把一张卡映射为对外视图(附合集名)。 */
export function toCardView(
  card: KnowledgeCard,
  collectionName: (id: string) => string,
): CardView {
  return {
    id: card.id,
    front: card.front,
    back: card.back,
    tags: card.tags ?? [],
    collectionId: card.collectionId,
    collectionName: collectionName(card.collectionId),
    image: Boolean(card.imageUri),
    createdAt: card.createdAt,
  }
}

/** 统一 JSON 响应。 */
function json(status: number, data: unknown): LanResponse {
  return { status, contentType: 'application/json', body: JSON.stringify(data) }
}

/** API Key 打码:只保留前 4 位,其余星号。空 key 原样返回空串。 */
export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}${'*'.repeat(Math.min(key.length - 4, 12))}`
}

/**
 * 处理一个局域网请求。
 * 任何未捕获异常都返回 500 JSON,不让原生层挂起。
 */
export async function handleLanRequest(
  method: string,
  rawPath: string,
  body: string,
  deps: LanApiDeps,
): Promise<LanResponse> {
  try {
    const { path, query } = parsePath(rawPath)
    const isApi = path.startsWith('/api/')

    // 管理页
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      return { status: 200, contentType: 'text/html', body: LAN_ADMIN_HTML }
    }

    // MCP 端点:外部 AI Agent(Claude 等)通过 JSON-RPC 控制卡片/设置
    if (path === '/mcp' || path === '/mcp/') {
      const mcpResp = await handleMcpMessage(body, deps)
      return mcpResp
    }
    if (!isApi) {
      return json(404, { error: 'not found' })
    }

    // ── 健康检查 ─────────────────────────────────────────
    if (method === 'GET' && path === '/api/health') {
      const [cards, collections] = await Promise.all([
        deps.repo.countCards(),
        deps.repo.listCollections(),
      ])
      return json(200, { ok: true, version: deps.version, cards, collections: collections.length })
    }

    // ── 卡片 ─────────────────────────────────────────────
    if (method === 'GET' && path === '/api/cards') {
      const all = await deps.repo.listCards()
      const collections = await deps.repo.listCollections()
      const nameOf = (id: string) => collections.find((c) => c.id === id)?.name ?? '未分类'
      const filtered = query.collectionId
        ? all.filter((c) => c.collectionId === query.collectionId)
        : all
      return json(200, { cards: filtered.map((c) => toCardView(c, nameOf)) })
    }

    if (method === 'POST' && path === '/api/cards') {
      let input: Record<string, unknown>
      try {
        input = JSON.parse(body || '{}')
      } catch {
        return json(400, { error: 'body 不是合法 JSON' })
      }
      const front = String(input.front ?? '').trim()
      if (!front) return json(400, { error: 'front(正面)不能为空' })
      const card = await deps.repo.addCard({
        front,
        back: String(input.back ?? ''),
        sourceText: String(input.sourceText ?? ''),
        collectionId: String(input.collectionId ?? '') || undefined,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      })
      const collections = await deps.repo.listCollections()
      const nameOf = (id: string) => collections.find((c) => c.id === id)?.name ?? '未分类'
      return json(201, { ok: true, card: toCardView(card, nameOf) })
    }

    if (method === 'DELETE' && path.startsWith('/api/cards/')) {
      const id = path.slice('/api/cards/'.length)
      if (!id) return json(400, { error: '缺少卡片 id' })
      await deps.repo.removeCard(id)
      return json(200, { ok: true })
    }

    // ── 合集 ─────────────────────────────────────────────
    if (method === 'GET' && path === '/api/collections') {
      const [collections, active] = await Promise.all([
        deps.repo.listCollections(),
        deps.getActiveCollectionId(),
      ])
      return json(200, {
        collections: collections.map((c: Collection) => ({ id: c.id, name: c.name, order: c.order })),
        activeCollectionId: active,
      })
    }

    if (method === 'POST' && path === '/api/collections') {
      let input: Record<string, unknown>
      try {
        input = JSON.parse(body || '{}')
      } catch {
        return json(400, { error: 'body 不是合法 JSON' })
      }
      const name = String(input.name ?? '').trim()
      if (!name) return json(400, { error: 'name 不能为空' })
      const col = await deps.repo.createCollection(name)
      return json(201, { ok: true, collection: { id: col.id, name: col.name, order: col.order } })
    }

    if (method === 'POST' && path === '/api/scope') {
      let input: Record<string, unknown>
      try {
        input = JSON.parse(body || '{}')
      } catch {
        return json(400, { error: 'body 不是合法 JSON' })
      }
      const id = String(input.collectionId ?? '')
      if (!id) return json(400, { error: 'collectionId 不能为空' })
      await deps.setActiveCollectionId(id)
      return json(200, { ok: true, activeCollectionId: id })
    }

    // ── 配置 ─────────────────────────────────────────────
    if (method === 'GET' && path === '/api/config') {
      const [ai, checkin, fullscreen] = await Promise.all([
        deps.getAIConfig(),
        deps.getCheckinConfig(),
        deps.getFullscreenPreference(),
      ])
      return json(200, {
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
      })
    }

    if (method === 'POST' && path === '/api/config') {
      let input: Record<string, unknown>
      try {
        input = JSON.parse(body || '{}')
      } catch {
        return json(400, { error: 'body 不是合法 JSON' })
      }

      const aiIn = input.ai as Record<string, unknown> | undefined
      if (aiIn && typeof aiIn === 'object') {
        const current = await deps.getAIConfig()
        const next: AIConfig = { ...current }
        if (typeof aiIn.enabled === 'boolean') next.enabled = aiIn.enabled
        if (typeof aiIn.provider === 'string' && aiIn.provider) next.provider = aiIn.provider as AIConfig['provider']
        if (typeof aiIn.baseUrl === 'string') next.baseUrl = aiIn.baseUrl
        if (typeof aiIn.model === 'string') next.model = aiIn.model
        if (typeof aiIn.vision === 'boolean') next.vision = aiIn.vision
        if (typeof aiIn.timeoutMs === 'number' && aiIn.timeoutMs > 0) next.timeoutMs = aiIn.timeoutMs
        // apiKey:非打码值才覆盖(管理页回显的是打码值,避免把星号存回去)
        if (typeof aiIn.apiKey === 'string' && aiIn.apiKey && !aiIn.apiKey.includes('*')) {
          next.apiKey = aiIn.apiKey
        }
        await deps.saveAIConfig(next)
      }

      const checkinIn = input.checkin as Record<string, unknown> | undefined
      if (checkinIn && typeof checkinIn === 'object') {
        const current = await deps.getCheckinConfig()
        const next: CheckinConfig = { ...current }
        if (typeof checkinIn.enabled === 'boolean') next.enabled = checkinIn.enabled
        if (typeof checkinIn.startMinute === 'number') next.startMinute = checkinIn.startMinute
        if (typeof checkinIn.endMinute === 'number') next.endMinute = checkinIn.endMinute
        await deps.saveCheckinConfig(next)
      }

      if (typeof input.fullscreen === 'boolean') {
        await deps.setFullscreenPreference(input.fullscreen)
      }

      return json(200, { ok: true })
    }

    return json(404, { error: 'not found' })
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) })
  }
}
