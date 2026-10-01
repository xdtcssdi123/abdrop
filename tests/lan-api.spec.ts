/**
 * 局域网 Web 服务 —— API 路由层测试。
 *
 * 用内存仓储 + 假配置读写注入 deps,验证:
 * - 管理页 HTML 返回
 * - 卡片:列表(含合集过滤)/ 新增 / 删除
 * - 合集:列表 / 新建 / 切换复习范围
 * - 配置:读取(apiKey 打码)/ 保存(打码值不覆盖真实 key)
 * - 健康检查与错误分支(404 / 400 / 500)
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createMemoryRepository } from '~/lib/db'
import { handleLanRequest, maskApiKey, parsePath, type LanApiDeps } from '~/lib/lan-api'
import { DEFAULT_AI_CONFIG } from '~/lib/ai'
import { DEFAULT_CHECKIN_CONFIG } from '~/lib/checkin'
import type { AIConfig } from '~/types'

function makeDeps(overrides: Partial<LanApiDeps> = {}): LanApiDeps {
  const repo = createMemoryRepository()
  let ai: AIConfig = { ...DEFAULT_AI_CONFIG, apiKey: 'sk-1234567890abcdef' }
  let active = 'all'
  let checkin = { ...DEFAULT_CHECKIN_CONFIG }
  let fullscreen = false
  return {
    repo,
    version: '1.1.0',
    getAIConfig: async () => ({ ...ai }),
    saveAIConfig: async (cfg) => {
      ai = { ...cfg }
    },
    getActiveCollectionId: async () => active,
    setActiveCollectionId: async (id) => {
      active = id
    },
    getCheckinConfig: async () => ({ ...checkin }),
    saveCheckinConfig: async (cfg) => {
      checkin = { ...cfg }
    },
    getFullscreenPreference: async () => fullscreen,
    setFullscreenPreference: async (on) => {
      fullscreen = on
    },
    ...overrides,
  }
}

describe('parsePath', () => {
  it('拆出 path 与 query', () => {
    expect(parsePath('/api/cards?collectionId=abc&x=1')).toEqual({
      path: '/api/cards',
      query: { collectionId: 'abc', x: '1' },
    })
  })
  it('无 query 时返回空对象', () => {
    expect(parsePath('/')).toEqual({ path: '/', query: {} })
  })
  it('URL 解码查询值', () => {
    expect(parsePath('/api/cards?q=%E6%95%B0%E5%AD%A6')).toEqual({
      path: '/api/cards',
      query: { q: '数学' },
    })
  })
})

describe('maskApiKey', () => {
  it('空 key 返回空串', () => {
    expect(maskApiKey('')).toBe('')
  })
  it('短 key 全部打码', () => {
    expect(maskApiKey('abc')).toBe('****')
  })
  it('长 key 保留前 4 位 + 星号', () => {
    const masked = maskApiKey('sk-1234567890abcdef')
    expect(masked.startsWith('sk-1')).toBe(true)
    expect(masked.includes('*')).toBe(true)
    expect(masked).not.toContain('1234567890abcdef')
  })
})

describe('handleLanRequest', () => {
  let deps: LanApiDeps

  beforeEach(() => {
    deps = makeDeps()
  })

  it('GET / 返回管理页 HTML', async () => {
    const r = await handleLanRequest('GET', '/', '', deps)
    expect(r.status).toBe(200)
    expect(r.contentType).toBe('text/html')
    expect(r.body).toContain('ABDrop')
    expect(r.body).toContain('新增卡片')
  })

  it('GET /api/health 返回版本与计数', async () => {
    await deps.repo.addCard({ front: 'A' })
    const r = await handleLanRequest('GET', '/api/health', '', deps)
    const data = JSON.parse(r.body)
    expect(r.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.version).toBe('1.1.0')
    expect(data.cards).toBe(1)
    expect(data.collections).toBeGreaterThanOrEqual(1)
  })

  it('POST /api/cards 新增卡片并返回视图', async () => {
    const r = await handleLanRequest(
      'POST',
      '/api/cards',
      JSON.stringify({ front: '什么是极限', back: '趋近过程', tags: ['数学'] }),
      deps,
    )
    expect(r.status).toBe(201)
    const data = JSON.parse(r.body)
    expect(data.ok).toBe(true)
    expect(data.card.front).toBe('什么是极限')
    expect(data.card.collectionName).toBe('未分类')
    expect((await deps.repo.listCards()).length).toBe(1)
  })

  it('POST /api/cards front 为空返回 400', async () => {
    const r = await handleLanRequest('POST', '/api/cards', JSON.stringify({ front: '  ' }), deps)
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body).error).toContain('front')
  })

  it('POST /api/cards 非法 JSON 返回 400', async () => {
    const r = await handleLanRequest('POST', '/api/cards', '{bad', deps)
    expect(r.status).toBe(400)
  })

  it('GET /api/cards 支持按合集过滤', async () => {
    const col = await deps.repo.createCollection('数学')
    await deps.repo.addCard({ front: 'A', collectionId: col.id })
    await deps.repo.addCard({ front: 'B' })
    const r = await handleLanRequest('GET', `/api/cards?collectionId=${col.id}`, '', deps)
    const cards = JSON.parse(r.body).cards
    expect(cards).toHaveLength(1)
    expect(cards[0].front).toBe('A')
    expect(cards[0].collectionName).toBe('数学')
  })

  it('DELETE /api/cards/:id 删除卡片', async () => {
    const card = await deps.repo.addCard({ front: '待删' })
    const r = await handleLanRequest('DELETE', `/api/cards/${card.id}`, '', deps)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).ok).toBe(true)
    expect((await deps.repo.listCards()).length).toBe(0)
  })

  it('GET /api/collections 返回合集与复习范围', async () => {
    await deps.repo.createCollection('英语')
    const r = await handleLanRequest('GET', '/api/collections', '', deps)
    const data = JSON.parse(r.body)
    expect(r.status).toBe(200)
    expect(data.collections.some((c: { name: string }) => c.name === '英语')).toBe(true)
    expect(data.activeCollectionId).toBe('all')
  })

  it('POST /api/collections 新建合集', async () => {
    const r = await handleLanRequest('POST', '/api/collections', JSON.stringify({ name: '物理' }), deps)
    expect(r.status).toBe(201)
    expect(JSON.parse(r.body).collection.name).toBe('物理')
    const cols = await deps.repo.listCollections()
    expect(cols.some((c) => c.name === '物理')).toBe(true)
  })

  it('POST /api/scope 切换复习范围', async () => {
    const col = await deps.repo.createCollection('化学')
    const r = await handleLanRequest('POST', '/api/scope', JSON.stringify({ collectionId: col.id }), deps)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).activeCollectionId).toBe(col.id)
    expect(await deps.getActiveCollectionId()).toBe(col.id)
  })

  it('GET /api/config 返回打码后的 apiKey', async () => {
    const r = await handleLanRequest('GET', '/api/config', '', deps)
    const data = JSON.parse(r.body)
    expect(r.status).toBe(200)
    expect(data.ai.apiKeyMasked).toContain('*')
    expect(data.ai.apiKeyMasked).not.toContain('1234567890abcdef')
    expect(data.checkin.enabled).toBe(false)
    expect(data.fullscreen).toBe(false)
  })

  it('POST /api/config 保存真实 apiKey(非打码值)', async () => {
    const r = await handleLanRequest(
      'POST',
      '/api/config',
      JSON.stringify({ ai: { apiKey: 'sk-NEW-KEY-123' } }),
      deps,
    )
    expect(r.status).toBe(200)
    const saved = await deps.getAIConfig()
    expect(saved.apiKey).toBe('sk-NEW-KEY-123')
  })

  it('POST /api/config 打码值不覆盖真实 key', async () => {
    await handleLanRequest('POST', '/api/config', JSON.stringify({ ai: { apiKey: 'sk-1********' } }), deps)
    const saved = await deps.getAIConfig()
    expect(saved.apiKey).toBe('sk-1234567890abcdef')
  })

  it('POST /api/config 保存打卡与全屏', async () => {
    const r = await handleLanRequest(
      'POST',
      '/api/config',
      JSON.stringify({ checkin: { enabled: true, startMinute: 480 }, fullscreen: true }),
      deps,
    )
    expect(r.status).toBe(200)
    const ck = await deps.getCheckinConfig()
    expect(ck.enabled).toBe(true)
    expect(ck.startMinute).toBe(480)
    expect(await deps.getFullscreenPreference()).toBe(true)
  })

  it('未知 API 返回 404 JSON', async () => {
    const r = await handleLanRequest('GET', '/api/nope', '', deps)
    expect(r.status).toBe(404)
    expect(JSON.parse(r.body).error).toBe('not found')
  })

  it('非 /api 路径且非首页返回 404', async () => {
    const r = await handleLanRequest('GET', '/favicon.ico', '', deps)
    expect(r.status).toBe(404)
  })

  it('仓储抛错时返回 500 而非挂起', async () => {
    const bad = makeDeps({
      repo: {
        ...createMemoryRepository(),
        listCards: async () => {
          throw new Error('db down')
        },
      } as LanApiDeps['repo'],
    })
    const r = await handleLanRequest('GET', '/api/cards', '', bad)
    expect(r.status).toBe(500)
    expect(JSON.parse(r.body).error).toContain('db down')
  })
})
