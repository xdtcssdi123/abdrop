/**
 * AI 归纳服务。
 *
 * 职责:把用户的原始知识点文本送去 LLM,拿回**正面/背面**结构的卡片内容,
 * 与 Anki 的 Front/Back 字段直接对齐。
 *
 * 设计要点:
 * - 兼容 OpenAI / Anthropic / DeepSeek / 自定义 四类接口形态。
 * - 请求体构造与响应解析全部是纯函数,可离线单测。
 * - 任何失败都不阻塞录入:调用方拿到 `ok:false` 后照常落库,只存原文。
 */

import type { AIProvider, AISummary, AIConfig } from '~/types'

export const DEFAULT_AI_CONFIG: AIConfig = {
  enabled: false,
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  timeoutMs: 20000,
  vision: false,
  lastTestOk: null,
  lastTestedAt: 0,
  lastTestMessage: '',
}

/** 各服务商默认端点与模型,设置页切换时一键填充。 */
export const PROVIDER_PRESETS: Record<
  AIProvider,
  { label: string; baseUrl: string; model: string; hint: string }
> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '标准 /chat/completions 接口',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '国内可直连,OpenAI 兼容',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-haiku-latest',
    hint: '使用 /messages 与 x-api-key',
  },
  custom: {
    label: '自定义',
    baseUrl: '',
    model: '',
    hint: '任何 OpenAI 兼容网关',
  },
}

/** 系统提示词 —— 输出协议必须与 `parseAIResponse` 严格对齐。 */
export const SYSTEM_PROMPT = `你是一个知识卡片整理助手,输出用于间隔重复记忆系统的问答卡片(Anki 风格)。
用户会给你一段零散的知识点原文(可能是课堂笔记、书摘、题目或拍照识别文本)。
请把它整理成一张卡片,只输出 JSON,不要任何解释文字,不要 markdown 代码块。

JSON 结构:
{
  "front": "卡片正面。一句简洁的问题或知识点标题,能独立引发回忆,不超过 40 字",
  "back": "卡片背面。准确、完整的答案或解释,可分点,用换行分隔,不超过 200 字",
  "keywords": ["3-6 个关键词"]
}

要求:
- 忠于原文,不编造事实;原文含糊时按最合理的通行理解补全。
- 若原文本身就是一问一答,直接拆成 front/back。
- 若原文是陈述句,把其中可考察的核心转成问题放进 front。
- 语言与原文一致。`

/** 多卡系统提示词 —— 输出 JSON **数组**,每项一张卡片(「拆卡」用)。 */
export const SYSTEM_PROMPT_MULTI = `你是一个知识卡片整理助手,输出用于间隔重复记忆系统的问答卡片(Anki 风格)。
用户会给你一段知识点原文或一张图片,其中**可能包含多个独立知识点**。
请把它拆成若干张卡片(一个知识点一张),只输出 JSON 数组,不要任何解释文字,不要 markdown 代码块。

JSON 结构(数组,1~8 张):
[
  {
    "front": "卡片正面。一句简洁的问题或知识点标题,能独立引发回忆,不超过 40 字",
    "back": "卡片背面。准确、完整的答案或解释,可分点,用换行分隔,不超过 200 字",
    "keywords": ["3-6 个关键词"]
  }
]

要求:
- 每个独立知识点拆一张卡;只有一个知识点时输出一张卡的数组。
- 忠于原文,不编造事实;原文含糊时按最合理的通行理解补全。
- 若知识点本身是一问一答,直接拆成 front/back;若是陈述句,把可考察的核心转成问题放进 front。
- 语言与原文一致。`

/** 一次请求的完整描述,便于单测断言。 */
export interface AIRequestPlan {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/** 判断是否 Anthropic 形态的接口。 */
export function isAnthropicLike(config: Pick<AIConfig, 'provider' | 'baseUrl'>): boolean {
  return config.provider === 'anthropic' || /anthropic\.com/.test(config.baseUrl)
}

/** 归一化 baseUrl:去尾部斜杠。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '')
}

/**
 * 解析实际使用的接口地址。
 *
 * 契约(刻意做得无歧义,不做任何猜测):
 *   - `baseUrl` 为空 → 使用当前服务商的官方默认地址;
 *   - `baseUrl` 非空 → **完全尊重用户输入**,即使它指向另一个服务商。
 *     很多用户的 "OpenAI" 其实接了自建网关或第三方兼容服务,猜测会误伤。
 */
export function effectiveBaseUrl(config: Pick<AIConfig, 'provider' | 'baseUrl'>): string {
  const raw = normalizeBaseUrl(config.baseUrl)
  if (raw) return raw
  return normalizeBaseUrl(PROVIDER_PRESETS[config.provider]?.baseUrl ?? '')
}

/**
 * 解析 dataURL 为 { mime, base64 }。
 * 用于把图片发给多模态模型(OpenAI image_url / Anthropic image source)。
 */
export function parseDataUrl(dataUrl: string): { mime: string; base64: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim())
  if (!m) return { mime: 'image/jpeg', base64: dataUrl }
  return { mime: m[1]!, base64: m[2]! }
}

/** OpenAI 形态的 user content:纯文本 → 字符串;带图 → 多模态数组。 */
function openAIUserContent(rawText: string, imageUrl: string): string | Array<Record<string, unknown>> {
  if (!imageUrl) return rawText
  return [
    { type: 'text', text: rawText || '请识别图片中的知识点并整理成卡片' },
    { type: 'image_url', image_url: { url: imageUrl } },
  ]
}

/** Anthropic 形态的 user content:纯文本 → 字符串;带图 → content 数组。 */
function anthropicUserContent(rawText: string, imageUrl: string): string | Array<Record<string, unknown>> {
  if (!imageUrl) return rawText
  const { mime, base64 } = parseDataUrl(imageUrl)
  return [
    { type: 'text', text: rawText || '请识别图片中的知识点并整理成卡片' },
    { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
  ]
}

/** 构造 AI 请求计划(纯函数)。imageUrl 传入可识别图片(dataURL)。 */
export function buildRequest(
  rawText: string,
  config: AIConfig,
  imageUrl = '',
  systemPrompt: string = SYSTEM_PROMPT,
): AIRequestPlan {
  const base = effectiveBaseUrl(config)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (isAnthropicLike(config)) {
    headers['x-api-key'] = config.apiKey
    headers['anthropic-version'] = '2023-06-01'
    // 浏览器 / WebView 直连 Anthropic 必须显式声明,否则被 CORS 拦截
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
    return {
      url: `${base}/messages`,
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: anthropicUserContent(rawText, imageUrl) }],
      }),
    }
  }

  headers.Authorization = `Bearer ${config.apiKey}`
  return {
    url: `${base}/chat/completions`,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: openAIUserContent(rawText, imageUrl) },
      ],
    }),
  }
}

/** 从可能带 markdown 围栏的文本中抠出 JSON 串。 */
export function extractJSONString(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return candidate
  return candidate.slice(start, end + 1)
}

/**
 * 解析 AI 原始响应 → 结构化归纳(纯函数)。
 * 兼容:OpenAI choices[0].message.content / Anthropic content[0].text /
 *      已结构化对象 / 纯文本兜底。
 */
export function parseAIResponse(payload: unknown): AISummary {
  const text = extractText(payload)
  if (!text) return { front: '', back: '', keywords: [] }

  const raw = extractJSONString(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 模型没吐 JSON —— 不视为失败,整段当背面,正面取首句兜底
    return nonJSONFallback(text)
  }

  if (!parsed || typeof parsed !== 'object') {
    return nonJSONFallback(text)
  }
  return parseCardObject(parsed, text)
}

/** 从任意对象里抽取卡片三要素(纯函数)。 */
export function parseCardObject(obj: unknown, fallbackText: string): AISummary {
  const o = obj as Record<string, unknown>
  const front = asString(
    o.front ?? o.question ?? o.正面 ?? o.问题 ?? o.title ?? o.summary,
  )
  const back = asString(
    o.back ?? o.answer ?? o.背面 ?? o.答案 ?? o.explanation ?? o.content,
  )
  const keywords = asStringArray(o.keywords ?? o.关键词 ?? o.tags)
  return {
    // 正面兜底:取背面首句,至少保证卡片两侧都有内容
    front: front || firstLine(back) || fallbackText.trim(),
    back: back || fallbackText.trim(),
    keywords,
  }
}

/** 从可能带 markdown 围栏的文本中抠出 JSON **数组**串(多卡拆卡用)。 */
export function extractJSONArrayString(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return candidate
  return candidate.slice(start, end + 1)
}

/**
 * 解析 AI 原始响应 → 卡片**数组**(拆卡用)。
 * 兼容:顶层 JSON 数组 / { cards: [...] } 包装 / 单个对象(当作一张)/
 *      纯文本兜底。
 */
export function parseAIResponseMany(payload: unknown): AISummary[] {
  const text = extractText(payload)
  if (!text) return [{ front: '', back: '', keywords: [] }]

  // 先按对象/包装解析(兼容 { cards: [...] } 与单对象 —— 对象里的嵌套数组
  // 如 keywords:[...] 不会被误当成顶层数组);
  // 失败再按顶层数组解析。
  let parsed: unknown = null
  try {
    parsed = JSON.parse(extractJSONString(text))
  } catch {
    try {
      parsed = JSON.parse(extractJSONArrayString(text))
    } catch {
      // 模型没吐 JSON —— 整段当背面兜底成一张
      return [nonJSONFallback(text)]
    }
  }

  // 顶层数组
  if (Array.isArray(parsed)) {
    const cards = parsed
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const card = parseCardObject(item, text)
        // 空卡片剔除(只输出数组壳时)
        return card.front || card.back ? card : null
      })
      .filter((c): c is AISummary => c !== null)
    return cards.length ? cards : [nonJSONFallback(text)]
  }

  // { cards: [...] } 包装 / 单对象
  if (parsed && typeof parsed === 'object') {
    const wrapped = (parsed as Record<string, unknown>).cards
    if (Array.isArray(wrapped)) {
      const cards = wrapped
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const card = parseCardObject(item, text)
          return card.front || card.back ? card : null
        })
        .filter((c): c is AISummary => c !== null)
      if (cards.length) return cards
    }
    // 单个对象 → 一张
    return [parseCardObject(parsed, text)]
  }

  return [nonJSONFallback(text)]
}

/** 取首行/首句作为正面兜底。 */
export function firstLine(text: string, maxLen = 40): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const sentence = line.split(/[。.!?！?;；]/)[0] ?? line
  const trimmed = sentence.trim()
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed
}

/**
 * 非 JSON 响应的兜底:整段作为背面,首句作为正面。
 * 宁可卡片结构粗糙,也不能丢掉模型返回的内容。
 */
function nonJSONFallback(text: string): AISummary {
  const body = text.trim()
  return { front: firstLine(body), back: body, keywords: [] }
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter(Boolean).join('\n')
  return ''
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter(Boolean)
  if (typeof v === 'string') {
    return v
      .split(/[,，、;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

/** 从任意服务商响应里抽正文。 */
function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as Record<string, any>

  // OpenAI 形态
  const choice = p.choices?.[0]
  if (choice) {
    const content = choice.message?.content ?? choice.text
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const joined = content
        .map((seg: any) => (typeof seg === 'string' ? seg : (seg?.text ?? '')))
        .join('')
      if (joined) return joined
    }
  }

  // Anthropic 形态
  if (Array.isArray(p.content)) {
    const joined = p.content.map((seg: any) => seg?.text ?? '').join('')
    if (joined) return joined
  }

  if (typeof p.output_text === 'string') return p.output_text
  return ''
}

/** 归纳结果(带错误信息)。 */
export type SummarizeResult = { ok: true; data: AISummary } | { ok: false; error: string }

/** 模型列表拉取结果。 */
export type ModelListResult = { ok: true; models: string[] } | { ok: false; error: string }

/** 模型分组:用于下拉面板按网关前缀归类展示。 */
export interface ModelGroup {
  label: string
  models: string[]
}

/**
 * 把模型 id 列表按常见网关前缀分组,便于浏览。
 *
 * 归属规则(纯字符串前缀,不猜语义):
 *   - `cn:` → 国内
 *   - `global:` → 国际
 *   - 其余 → 其他(按字母序)
 * 组内各按字母序排,稳定、可测。
 */
export function groupModels(models: readonly string[]): ModelGroup[] {
  const buckets: Record<string, string[]> = { cn: [], global: [], other: [] }
  for (const id of models) {
    const key = id.startsWith('cn:') ? 'cn' : id.startsWith('global:') ? 'global' : 'other'
    buckets[key]!.push(id)
  }
  const groups: ModelGroup[] = []
  if (buckets.cn!.length)
    groups.push({ label: '国内 (cn:)', models: [...buckets.cn!].sort() })
  if (buckets.global!.length)
    groups.push({ label: '国际 (global:)', models: [...buckets.global!].sort() })
  if (buckets.other!.length)
    groups.push({ label: '其他', models: [...buckets.other!].sort() })
  return groups
}

/**
 * 从网关拉取可用模型列表(OpenAI 兼容 GET /models)。
 *
 * 用途:设置页「获取模型列表」—— 让用户从网关真实返回的 id 里选,
 * 而不是手抄(尤其自定义网关的模型 id 可能是长名,手输易错)。
 * 请求头与 `buildRequest` 同规则:Anthropic 形态用 x-api-key,其余 Bearer。
 */
export async function listModels(
  config: Pick<AIConfig, 'provider' | 'baseUrl' | 'apiKey'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelListResult> {
  if (!config.apiKey.trim()) return { ok: false, error: '未配置 API Key' }
  const base = effectiveBaseUrl(config)
  if (!base) return { ok: false, error: '未配置接口地址' }

  const headers: Record<string, string> = {}
  if (isAnthropicLike(config)) {
    headers['x-api-key'] = config.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`
  }

  try {
    const res = await fetchImpl(`${base}/models`, { method: 'GET', headers })
    if (!res.ok) {
      const detail = await safeText(res)
      return {
        ok: false,
        error: `HTTP ${res.status}${detail ? ` · ${detail.slice(0, 120)}` : ''}`,
      }
    }
    const payload = await res.json()
    const items = Array.isArray(payload?.data) ? payload.data : null
    if (!items) return { ok: false, error: '响应缺少 data 数组(非 /models 模型列表)' }

    const models = items
      .map((m: any) => (typeof m?.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean)
    if (!models.length) return { ok: false, error: '模型列表为空' }
    return { ok: true, models }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `请求失败:${msg}` }
  }
}

/** 单张图片的识别结果(拆卡:每张图可能产出多张卡)。 */
export type ImageSummaryResult =
  | { imageUri: string; ok: true; data: AISummary[] }
  | { imageUri: string; ok: false; error: string }

/**
 * 多图逐张识别(「AI 识图拆卡」)。
 *
 * 顺序执行(避免触发网关限流),单张失败不中断其余;
 * 每张图可能拆出多张卡(一图多卡),由调用方决定如何落库、失败如何提示。
 */
export async function summarizeMany(
  images: readonly string[],
  rawText: string,
  config: AIConfig,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (done: number, total: number) => void,
): Promise<ImageSummaryResult[]> {
  const out: ImageSummaryResult[] = []
  for (let i = 0; i < images.length; i++) {
    const uri = images[i]!
    const result = await summarizeKnowledgeMany(rawText, config, fetchImpl, uri)
    out.push(
      result.ok
        ? { imageUri: uri, ok: true, data: result.data }
        : { imageUri: uri, ok: false, error: result.error },
    )
    onProgress?.(i + 1, images.length)
  }
  return out
}

/** 拆卡草稿:一张卡片(可能多张共用同一张图)。 */
export interface CardDraft {
  imageUri: string
  front: string
  back: string
  keywords: string[]
}

/**
 * 把逐图识别结果整理成卡片草稿(纯函数)。
 * 识别成功的**每张卡**都进 drafts(同图多卡逐张展开),失败的单独列出。
 */
export function draftsFromImageResults(
  results: readonly ImageSummaryResult[],
  fallbackFront: string,
): { drafts: CardDraft[]; failed: Array<{ imageUri: string; error: string }> } {
  const drafts: CardDraft[] = []
  const failed: Array<{ imageUri: string; error: string }> = []
  for (const r of results) {
    if (r.ok) {
      for (const card of r.data) {
        drafts.push({
          imageUri: r.imageUri,
          front: card.front || firstLine(fallbackFront) || '未识别内容',
          back: card.back,
          keywords: card.keywords,
        })
      }
    } else {
      failed.push({ imageUri: r.imageUri, error: r.error })
    }
  }
  return { drafts, failed }
}

/**
 * 调用 AI 归纳(单卡)。
 * 永不抛异常 —— 失败返回 `{ ok:false, error }`,由 UI 决定是否提示。
 *
 * @param imageUrl 可选的图片 dataURL;传入后以多模态发给模型。
 *                 只拍图不写字时,rawText 可留空(提示词自带图片识别指令)。
 */
export async function summarizeKnowledge(
  rawText: string,
  config: AIConfig,
  fetchImpl: typeof fetch = fetch,
  imageUrl = '',
): Promise<SummarizeResult> {
  const guard = summarizeGuard(rawText, imageUrl, config)
  if (guard) return guard

  const plan = buildRequest(rawText, config, imageUrl)
  return runAIRequest(plan, config, (payload) => {
    const data = parseAIResponse(payload)
    return data.front || data.back ? { ok: true as const, data } : { ok: false as const, error: 'AI 返回内容为空' }
  }, fetchImpl)
}

/** 多卡归纳结果。 */
export type SummarizeManyResult =
  | { ok: true; data: AISummary[] }
  | { ok: false; error: string }

/**
 * 调用 AI 归纳(多卡拆卡)。
 * 一张图 / 一段文本可拆成多张卡;失败返回 error,永不抛异常。
 */
export async function summarizeKnowledgeMany(
  rawText: string,
  config: AIConfig,
  fetchImpl: typeof fetch = fetch,
  imageUrl = '',
): Promise<SummarizeManyResult> {
  const guard = summarizeGuard(rawText, imageUrl, config)
  if (guard) return guard

  const plan = buildRequest(rawText, config, imageUrl, SYSTEM_PROMPT_MULTI)
  return runAIRequest(plan, config, (payload) => {
    const cards = parseAIResponseMany(payload).filter((c) => c.front || c.back)
    return cards.length
      ? { ok: true as const, data: cards }
      : { ok: false as const, error: 'AI 返回内容为空' }
  }, fetchImpl)
}

/** 归纳前置校验,返回错误时立即短路;通过返回 null。 */
function summarizeGuard<R extends { ok: false; error: string }>(
  rawText: string,
  imageUrl: string,
  config: AIConfig,
): R | null {
  if (!rawText.trim() && !imageUrl) return { ok: false, error: '原文为空' } as R
  if (!config.enabled) return { ok: false, error: 'AI 未启用' } as R
  if (!config.apiKey.trim()) return { ok: false, error: '未配置 API Key' } as R
  if (!normalizeBaseUrl(config.baseUrl)) return { ok: false, error: '未配置接口地址' } as R
  if (!config.model.trim()) return { ok: false, error: '未配置模型名' } as R
  return null
}

/** 执行一次 AI 请求并统一错误处理,响应交给解析回调。 */
async function runAIRequest<T>(
  plan: AIRequestPlan,
  config: AIConfig,
  parse: (payload: unknown) => { ok: true; data: T } | { ok: false; error: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const res = await fetchImpl(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.body,
      signal: controller.signal,
    })

    if (!res.ok) {
      const detail = await safeText(res)
      return { ok: false, error: `HTTP ${res.status}${detail ? ` · ${detail.slice(0, 120)}` : ''}` }
    }

    const payload = await res.json()
    return parse(payload)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/abort/i.test(msg)) return { ok: false, error: `请求超时(${config.timeoutMs}ms)` }
    return { ok: false, error: `请求失败:${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/** 连通性测试:发一句最简 prompt 验证 key / 端点 / 模型。 */
export async function testAIConnection(
  config: AIConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const result = await summarizeKnowledge(
    '测试连通性:请返回 {"front":"ok","back":"ok"}',
    config,
    fetchImpl,
  )
  if (result.ok) return { ok: true, message: '连接正常' }
  return { ok: false, message: result.error }
}
