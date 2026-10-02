/**
 * MCP(Model Context Protocol)服务测试。
 *
 * 验证 JSON-RPC 2.0 协议处理:
 * - initialize 握手(协议版本/能力/服务器信息)
 * - notifications/initialized 通知无响应
 * - tools/list 返回全部工具与 schema
 * - tools/call 各工具真实读写(卡片/合集/范围/配置)
 * - 错误分支:非法 JSON / 未知方法 / 未知工具 / 工具内部错误
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createMemoryRepository } from '~/lib/db'
import { handleMcpMessage, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_TOOLS } from '~/lib/mcp'
import { DEFAULT_AI_CONFIG } from '~/lib/ai'
import { DEFAULT_CHECKIN_CONFIG } from '~/lib/checkin'
import type { AIConfig } from '~/types'
import type { McpDeps } from '~/lib/mcp'

function makeDeps(): McpDeps {
  const repo = createMemoryRepository()
  let ai: AIConfig = { ...DEFAULT_AI_CONFIG, apiKey: 'sk-1234567890abcdef' }
  let active = 'all'
  let checkin = { ...DEFAULT_CHECKIN_CONFIG }
  let fullscreen = false
  return {
    repo,
    version: '1.3.0',
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
  }
}

/** 发送一条 JSON-RPC 消息并解析响应。 */
async function call(body: unknown, deps: McpDeps) {
  const resp = await handleMcpMessage(JSON.stringify(body), deps)
  expect(resp.status).toBe(200)
  expect(resp.contentType).toBe('application/json')
  return resp.body ? (JSON.parse(resp.body) as Record<string, any>) : null
}

/** 工具调用快捷方式:取 content[0].text 并解析。 */
async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps) {
  const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, deps)
  const text = r?.result?.content?.[0]?.text ?? ''
  return { result: r?.result, text }
}

describe('MCP 握手与协议', () => {
  let deps: McpDeps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('initialize 返回协议版本/能力/服务器信息', async () => {
    const r = await call(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } },
      deps,
    )
    expect(r?.id).toBe(1)
    expect(r?.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(r?.result?.serverInfo.name).toBe(MCP_SERVER_NAME)
    expect(r?.result?.serverInfo.version).toBe('1.3.0')
    expect(r?.result?.capabilities.tools).toEqual({})
  })

  it('notifications/initialized 通知返回空体', async () => {
    const resp = await handleMcpMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), deps)
    expect(resp.status).toBe(200)
    expect(resp.body).toBe('')
  })

  it('ping 返回空结果', async () => {
    const r = await call({ jsonrpc: '2.0', id: 2, method: 'ping' }, deps)
    expect(r?.result).toEqual({})
  })

  it('tools/list 返回全部工具(9 个)且含 schema', async () => {
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps)
    const tools = r?.result?.tools
    expect(tools).toHaveLength(MCP_TOOLS.length)
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      'abdrop_health',
      'abdrop_list_cards',
      'abdrop_add_card',
      'abdrop_delete_card',
      'abdrop_list_collections',
      'abdrop_create_collection',
      'abdrop_set_scope',
      'abdrop_get_config',
      'abdrop_set_config',
    ])
    const addCard = tools.find((t: any) => t.name === 'abdrop_add_card')
    expect(addCard.inputSchema.required).toContain('front')
  })
})

describe('MCP 工具:卡片', () => {
  let deps: McpDeps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('abdrop_health 返回版本与计数', async () => {
    await deps.repo.addCard({ front: 'A' })
    const { result, text } = await callTool('abdrop_health', {}, deps)
    expect(result.isError).toBe(false)
    const data = JSON.parse(text)
    expect(data.ok).toBe(true)
    expect(data.version).toBe('1.2.3')
    expect(data.cards).toBe(1)
  })

  it('abdrop_add_card 新增卡片并返回视图', async () => {
    const { result, text } = await callTool('abdrop_add_card', { front: '什么是极限', back: '趋近过程', tags: ['数学'] }, deps)
    expect(result.isError).toBe(false)
    const data = JSON.parse(text)
    expect(data.card.front).toBe('什么是极限')
    expect(data.card.collectionName).toBe('未分类')
    expect((await deps.repo.listCards()).length).toBe(1)
  })

  it('abdrop_add_card front 为空时工具报错(isError)', async () => {
    const { result } = await callTool('abdrop_add_card', { front: '  ' }, deps)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('front')
  })

  it('abdrop_list_cards 列出全部 / 按合集过滤', async () => {
    const col = await deps.repo.createCollection('数学')
    await deps.repo.addCard({ front: 'A', collectionId: col.id })
    await deps.repo.addCard({ front: 'B' })

    const all = await callTool('abdrop_list_cards', {}, deps)
    expect(JSON.parse(all.text).cards).toHaveLength(2)

    const filtered = await callTool('abdrop_list_cards', { collectionId: col.id }, deps)
    const cards = JSON.parse(filtered.text).cards
    expect(cards).toHaveLength(1)
    expect(cards[0].front).toBe('A')
    expect(cards[0].collectionName).toBe('数学')
  })

  it('abdrop_delete_card 删除卡片', async () => {
    const card = await deps.repo.addCard({ front: '待删' })
    const { result } = await callTool('abdrop_delete_card', { id: card.id }, deps)
    expect(result.isError).toBe(false)
    expect((await deps.repo.listCards()).length).toBe(0)
  })
})

describe('MCP 工具:合集与范围', () => {
  let deps: McpDeps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('abdrop_list_collections 返回合集与复习范围', async () => {
    await deps.repo.createCollection('英语')
    const { text } = await callTool('abdrop_list_collections', {}, deps)
    const data = JSON.parse(text)
    expect(data.collections.some((c: { name: string }) => c.name === '英语')).toBe(true)
    expect(data.activeCollectionId).toBe('all')
  })

  it('abdrop_create_collection 新建合集', async () => {
    const { result, text } = await callTool('abdrop_create_collection', { name: '物理' }, deps)
    expect(result.isError).toBe(false)
    expect(JSON.parse(text).collection.name).toBe('物理')
  })

  it('abdrop_set_scope 切换复习范围', async () => {
    const col = await deps.repo.createCollection('化学')
    const { text } = await callTool('abdrop_set_scope', { collectionId: col.id }, deps)
    expect(JSON.parse(text).activeCollectionId).toBe(col.id)
    expect(await deps.getActiveCollectionId()).toBe(col.id)
  })
})

describe('MCP 工具:配置', () => {
  let deps: McpDeps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('abdrop_get_config 返回打码 apiKey', async () => {
    const { text } = await callTool('abdrop_get_config', {}, deps)
    const data = JSON.parse(text)
    expect(data.ai.apiKeyMasked).toContain('*')
    expect(data.ai.apiKeyMasked).not.toContain('1234567890abcdef')
    expect(data.checkin.enabled).toBe(false)
    expect(data.fullscreen).toBe(false)
  })

  it('abdrop_set_config 保存真实 apiKey 与打卡/全屏', async () => {
    const { result } = await callTool(
      'abdrop_set_config',
      { ai: { apiKey: 'sk-NEW-123' }, checkin: { enabled: true, startMinute: 480 }, fullscreen: true },
      deps,
    )
    expect(result.isError).toBe(false)
    const ai = await deps.getAIConfig()
    expect(ai.apiKey).toBe('sk-NEW-123')
    const ck = await deps.getCheckinConfig()
    expect(ck.enabled).toBe(true)
    expect(await deps.getFullscreenPreference()).toBe(true)
  })

  it('abdrop_set_config 打码 apiKey 不覆盖真实值', async () => {
    await callTool('abdrop_set_config', { ai: { apiKey: 'sk-1********' } }, deps)
    const ai = await deps.getAIConfig()
    expect(ai.apiKey).toBe('sk-1234567890abcdef')
  })
})

describe('MCP 错误分支', () => {
  let deps: McpDeps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('非法 JSON → 解析错误', async () => {
    const resp = await handleMcpMessage('{broken', deps)
    expect(resp.status).toBe(400)
    const r = JSON.parse(resp.body)
    expect(r.error.code).toBe(-32700)
  })

  it('非 JSON-RPC 结构 → 请求无效', async () => {
    const resp = await handleMcpMessage('{"hello":"world"}', deps)
    expect(resp.status).toBe(400)
    const r = JSON.parse(resp.body)
    expect(r.error.code).toBe(-32600)
  })

  it('未知方法 → 方法未找到', async () => {
    const r = await call({ jsonrpc: '2.0', id: 7, method: 'nope' }, deps)
    expect(r?.error?.code).toBe(-32601)
  })

  it('未知工具 → 方法未找到', async () => {
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } }, deps)
    expect(r?.error?.code).toBe(-32601)
  })

  it('工具内部错误 → isError 且不崩协议', async () => {
    // 让仓储抛错:删除不存在的合集时 DB 抛错
    const bad = makeDeps()
    ;(bad.repo as any).addCard = async () => {
      throw new Error('db down')
    }
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'abdrop_add_card', arguments: { front: 'x' } } }, bad)
    expect(r?.result?.isError).toBe(true)
    expect(r?.result?.content?.[0]?.text).toContain('db down')
  })
})
