/**
 * AI 服务测试 —— 请求构造、响应解析、错误降级。
 * 全部用假 fetch,不发真实请求。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_AI_CONFIG,
  SYSTEM_PROMPT,
  buildRequest,
  effectiveBaseUrl,
  extractJSONString,
  firstLine,
  isAnthropicLike,
  normalizeBaseUrl,
  parseAIResponse,
  summarizeKnowledge,
  testAIConnection,
} from '~/lib/ai'
import type { AIConfig } from '~/types'

const config = (over: Partial<AIConfig> = {}): AIConfig => ({
  ...DEFAULT_AI_CONFIG,
  enabled: true,
  apiKey: 'sk-test',
  ...over,
})

/** 造一个最小可用的 fetch 桩。 */
function fakeFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }) as unknown as Response,
  ) as unknown as typeof fetch
}

/** 标准 OpenAI 形态的返回。 */
function openAIPayload(content: string) {
  return { choices: [{ message: { content } }] }
}

describe('请求构造', () => {
  it('OpenAI 形态打到 /chat/completions 并带 Bearer', () => {
    const plan = buildRequest('原文', config())
    expect(plan.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(plan.method).toBe('POST')
    expect(plan.headers.Authorization).toBe('Bearer sk-test')
  })

  it('请求体包含 system prompt 与用户原文', () => {
    const plan = buildRequest('什么是导数', config())
    const body = JSON.parse(plan.body)
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages[0].content).toBe(SYSTEM_PROMPT)
    expect(body.messages[1].content).toBe('什么是导数')
  })

  it('baseUrl 留空时回落到服务商官方默认地址', () => {
    const plan = buildRequest('原文', config({ provider: 'anthropic', baseUrl: '' }))
    expect(plan.url).toBe('https://api.anthropic.com/v1/messages')
  })

  it('用户填了地址就完全尊重,不猜测服务商', () => {
    // 常见场景:标成 OpenAI,实际接自建网关 —— 猜测会误伤
    const plan = buildRequest(
      '原文',
      config({ provider: 'anthropic', baseUrl: 'https://my-gateway.internal/v1' }),
    )
    expect(plan.url).toBe('https://my-gateway.internal/v1/messages')
  })

  it('Anthropic 形态打到 /messages 并带 x-api-key', () => {
    const plan = buildRequest('原文', config({ provider: 'anthropic', baseUrl: '' }))
    expect(plan.url).toBe('https://api.anthropic.com/v1/messages')
    expect(plan.headers['x-api-key']).toBe('sk-test')
    expect(plan.headers['anthropic-version']).toBeTruthy()
    // 浏览器直连必须带这个头,否则被 CORS 拦
    expect(plan.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(plan.headers.Authorization).toBeUndefined()
  })

  it('Anthropic 形态把 system 放到顶层字段而非 messages', () => {
    const body = JSON.parse(
      buildRequest('原文', config({ provider: 'anthropic', baseUrl: '' })).body,
    )
    expect(body.system).toBe(SYSTEM_PROMPT)
    expect(body.messages).toHaveLength(1)
  })

  it('baseUrl 为空且服务商无默认值时给出空地址,由调用方拦下', () => {
    expect(effectiveBaseUrl(config({ provider: 'custom', baseUrl: '  ' }))).toBe('')
  })

  it('baseUrl 尾部斜杠被归一化,不会拼出双斜杠', () => {
    const plan = buildRequest('x', config({ baseUrl: 'https://api.deepseek.com/v1///' }))
    expect(plan.url).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('即使 provider 写成 openai,URL 含 anthropic 也走 Anthropic 分支', () => {
    expect(isAnthropicLike({ provider: 'openai', baseUrl: 'https://api.anthropic.com/v1' })).toBe(true)
    expect(isAnthropicLike({ provider: 'anthropic', baseUrl: 'https://x.com' })).toBe(true)
    expect(isAnthropicLike({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe(false)
  })

  it('normalizeBaseUrl 处理空值与空白', () => {
    expect(normalizeBaseUrl('  https://a.com/  ')).toBe('https://a.com')
    expect(normalizeBaseUrl('')).toBe('')
  })
})

describe('响应解析', () => {
  it('解析干净的 JSON 字符串', () => {
    const out = parseAIResponse(openAIPayload('{"front":"Q","back":"A","keywords":["k1","k2"]}'))
    expect(out.front).toBe('Q')
    expect(out.back).toBe('A')
    expect(out.keywords).toEqual(['k1', 'k2'])
  })

  it('剥离 markdown 代码围栏', () => {
    const out = parseAIResponse(openAIPayload('```json\n{"front":"Q","back":"A"}\n```'))
    expect(out.front).toBe('Q')
  })

  it('容忍 JSON 前后的多余解说文字', () => {
    const out = parseAIResponse(openAIPayload('好的,结果如下:{"front":"Q","back":"A"} 希望有帮助'))
    expect(out.front).toBe('Q')
  })

  it('解析 Anthropic 的 content 数组形态', () => {
    const out = parseAIResponse({ content: [{ text: '{"front":"AQ","back":"AA"}' }] })
    expect(out.front).toBe('AQ')
    expect(out.back).toBe('AA')
  })

  it('模型吐出非 JSON 时整段当背面,不丢内容', () => {
    const out = parseAIResponse(openAIPayload('这是一段纯文本解释'))
    expect(out.back).toBe('这是一段纯文本解释')
    expect(out.front).toBe('这是一段纯文本解释')
  })

  it('front 缺失时用 back 首句兜底,保证卡片两侧都有内容', () => {
    const out = parseAIResponse(openAIPayload('{"back":"光合作用是把光能转成化学能。后面还有解释"}'))
    expect(out.front).toBe('光合作用是把光能转成化学能')
    expect(out.back).toContain('化学能')
  })

  it('中文键名也能识别', () => {
    const out = parseAIResponse(openAIPayload('{"正面":"中国的首都?","背面":"北京","关键词":["地理"]}'))
    expect(out.front).toBe('中国的首都?')
    expect(out.back).toBe('北京')
    expect(out.keywords).toEqual(['地理'])
  })

  it('keywords 为逗号分隔字符串时切成数组', () => {
    const out = parseAIResponse(openAIPayload('{"front":"Q","back":"A","keywords":"甲,乙、丙"}'))
    expect(out.keywords).toEqual(['甲', '乙', '丙'])
  })

  it('空响应返回全空结构,不抛异常', () => {
    expect(parseAIResponse({})).toEqual({ front: '', back: '', keywords: [] })
    expect(parseAIResponse(null)).toEqual({ front: '', back: '', keywords: [] })
  })

  it('合法但没有可用字段的 JSON 回落到原文', () => {
    const out = parseAIResponse(openAIPayload('{"foo":1}'))
    expect(out.back).toBe('{"foo":1}')
  })
})

describe('extractJSONString / firstLine 工具', () => {
  it('从围栏中取 JSON', () => {
    expect(extractJSONString('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('无围栏时取首个 { 到末个 }', () => {
    expect(extractJSONString('前言 {"a":1} 后记')).toBe('{"a":1}')
  })

  it('没有花括号时原样返回', () => {
    expect(extractJSONString('纯文本')).toBe('纯文本')
  })

  it('firstLine 取首句并截断', () => {
    expect(firstLine('第一句。第二句')).toBe('第一句')
    expect(firstLine('A'.repeat(60)).length).toBeLessThanOrEqual(41)
  })

  it('firstLine 跳过空行', () => {
    expect(firstLine('\n\n真正的首行')).toBe('真正的首行')
  })
})

describe('summarizeKnowledge 端到端', () => {
  it('成功路径返回结构化结果', async () => {
    const f = fakeFetch(openAIPayload('{"front":"Q","back":"A"}'))
    const res = await summarizeKnowledge('原文', config(), f)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.front).toBe('Q')
  })

  it('AI 未启用时直接拒绝,不发请求', async () => {
    const f = fakeFetch({})
    const res = await summarizeKnowledge('原文', config({ enabled: false }), f)
    expect(res.ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it('缺 API Key 时拒绝', async () => {
    const f = fakeFetch({})
    const res = await summarizeKnowledge('原文', config({ apiKey: '  ' }), f)
    expect(res.ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it('缺 baseUrl 或 model 时拒绝', async () => {
    // 自定义服务商 + 空地址 → 无从回落,必须拒绝
    const noBase = await summarizeKnowledge(
      'x',
      config({ provider: 'custom', baseUrl: '' }),
      fakeFetch({}),
    )
    expect(noBase.ok).toBe(false)
    if (!noBase.ok) expect(noBase.error).toContain('接口地址')

    expect((await summarizeKnowledge('x', config({ model: '' }), fakeFetch({}))).ok).toBe(false)
  })

  it('原文为空时拒绝', async () => {
    const res = await summarizeKnowledge('   ', config(), fakeFetch({}))
    expect(res.ok).toBe(false)
  })

  it('HTTP 错误转成可读文案,不抛异常', async () => {
    const f = fakeFetch({ error: 'invalid key' }, { ok: false, status: 401 })
    const res = await summarizeKnowledge('原文', config(), f)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('401')
  })

  it('网络异常被捕获,返回错误而非抛出', async () => {
    const f = vi.fn(async () => {
      throw new Error('Network unreachable')
    }) as unknown as typeof fetch
    const res = await summarizeKnowledge('原文', config(), f)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Network unreachable')
  })

  it('AI 返回空内容时判定为失败', async () => {
    const res = await summarizeKnowledge('原文', config(), fakeFetch(openAIPayload('')))
    expect(res.ok).toBe(false)
  })

  it('超时被识别为超时错误', async () => {
    const f = vi.fn(async () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }) as unknown as typeof fetch
    const res = await summarizeKnowledge('原文', config({ timeoutMs: 5000 }), f)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('超时')
  })
})

describe('testAIConnection', () => {
  it('成功时返回连接正常', async () => {
    const res = await testAIConnection(config(), fakeFetch(openAIPayload('{"front":"ok","back":"ok"}')))
    expect(res.ok).toBe(true)
    expect(res.message).toBe('连接正常')
  })

  it('失败时把原因带出来,便于用户排查', async () => {
    const res = await testAIConnection(config({ apiKey: '' }), fakeFetch({}))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('API Key')
  })
})
