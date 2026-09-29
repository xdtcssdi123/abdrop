/**
 * Anki 互操作层。
 *
 * 支持三种形态,覆盖 Anki 用户的绝大多数数据:
 *   1. `.apkg` 集合包      —— 解包 → 读 SQLite → 还原笔记与牌组
 *   2. 纯文本导出(TSV/CSV)—— Anki「导出 → 纯文本」带 #separator 头部
 *   3. 导出为 Anki 可导入的 TSV —— 保留 HTML 字段与 tags
 *
 * 全部解析函数均为纯函数,唯独 `.apkg` 需要 sql.js 读 SQLite。
 * 解析结果统一落到 `AnkiNote[]`,再由 `lib/anki-map.ts` 映射成 App 模型。
 */

import { unzipSync, strFromU8, type Unzipped } from 'fflate'
import { decompress as zstdDecompress } from 'fzstd'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'

/** 从 Anki 解析出来的原始笔记。 */
export interface AnkiNote {
  /** Anki 笔记 id */
  noteId: string
  /** 正面字段 */
  front: string
  /** 背面字段 */
  back: string
  /** 其余字段(超出 Basic 两字段时保留) */
  extraFields: string[]
  /** 标签 */
  tags: string[]
  /** 牌组名 */
  deck: string
  /** 笔记模板名 */
  modelName: string
}

/** 解析结果 + 统计。 */
export interface AnkiParseResult {
  notes: AnkiNote[]
  /** 解析过程中的非致命问题,UI 原样展示给用户 */
  warnings: string[]
  /** 媒体文件名 → dataURL(仅图片,.apkg 才有) */
  media: Record<string, string>
}

/** 空结果。 */
export function emptyResult(): AnkiParseResult {
  return { notes: [], warnings: [], media: {} }
}

/** Anki 字段分隔符:ASCII 31 (0x1f)。 */
export const FIELD_SEPARATOR = '\x1f'

// ══════════════════════════════════════════════════════════════
// 1. HTML 清洗
// ══════════════════════════════════════════════════════════════

/**
 * 把 Anki 字段里的 HTML 还原成纯文本。
 * 保留换行语义,剥掉样式,把图片引用转成约定的 `[[img:文件名]]` 占位。
 */
export function stripHtml(input: string): string {
  if (!input) return ''
  let text = input

  // 媒体引用先转占位符,避免被后续标签剥离吃掉
  text = text.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, src: string) => {
    return `\n[[img:${src}]]\n`
  })
  text = text.replace(/\[sound:([^\]]+)\]/gi, (_m, src: string) => `\n[[audio:${src}]]\n`)

  // 块级标签 → 换行
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  // <hr id=answer> 是 Anki 问答卡的分隔线,必须换成换行,
  // 否则正面与背面的文字会直接粘连成一句
  text = text.replace(/<\s*hr[^>]*>/gi, '\n')
  text = text.replace(/<\/\s*(div|p|li|tr|h[1-6])\s*>/gi, '\n')
  text = text.replace(/<\s*li[^>]*>/gi, '· ')

  // 其余标签一律剥离
  text = text.replace(/<[^>]+>/g, '')

  // HTML 实体
  text = decodeEntities(text)

  // 归一化空白:行尾空格去掉,连续空行压成一个
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+$/g, '').trimStart())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 常见 HTML 实体解码(不依赖 DOM,便于单测与 Node 端运行)。 */
export function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    middot: '·',
    times: '×',
    divide: '÷',
    deg: '°',
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    pi: 'π',
    sum: '∑',
    radic: '√',
    infin: '∞',
    ne: '≠',
    le: '≤',
    ge: '≥',
  }
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m)
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

// ══════════════════════════════════════════════════════════════
// 2. 纯文本(TSV / CSV)解析
// ══════════════════════════════════════════════════════════════

/** Anki 纯文本导出的头部指令。 */
export interface AnkiTextHeader {
  separator: string
  html: boolean
  columns: string[]
  /** 各语义列的下标;-1 表示未声明 */
  tagsColumn: number
  deckColumn: number
  notetypeColumn: number
  guidColumn: number
}

/** 解析 `#separator:` / `#html:` / `#columns:` 头部。 */
export function parseTextHeader(text: string): AnkiTextHeader {
  const header: AnkiTextHeader = {
    separator: '\t',
    html: false,
    columns: [],
    tagsColumn: -1,
    deckColumn: -1,
    notetypeColumn: -1,
    guidColumn: -1,
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#')) continue
    const body = line.slice(1)
    const idx = body.indexOf(':')
    if (idx === -1) continue
    const key = body.slice(0, idx).trim().toLowerCase()
    const value = body.slice(idx + 1)

    if (key === 'separator') {
      if (value === 'tab') header.separator = '\t'
      else if (value === 'comma') header.separator = ','
      else if (value === 'semicolon') header.separator = ';'
      else if (value === 'space') header.separator = ' '
      else if (value === 'pipe') header.separator = '|'
      else if (value === 'colon') header.separator = ':'
      else header.separator = value || '\t'
    } else if (key === 'html') {
      header.html = value.trim().toLowerCase() === 'true'
    } else if (key === 'columns') {
      header.columns = value.split(header.separator).map((c) => c.trim().toLowerCase())
    } else if (key === 'tags column') {
      header.tagsColumn = toZeroBased(value)
    } else if (key === 'deck column') {
      header.deckColumn = toZeroBased(value)
    } else if (key === 'notetype column') {
      header.notetypeColumn = toZeroBased(value)
    } else if (key === 'guid column') {
      header.guidColumn = toZeroBased(value)
    }
  }

  return header
}

/**
 * Anki 头部里的列号是 **1 起算** 的(`#tags column:3` 指第 3 列),
 * 而数组下标从 0 开始 —— 这里统一转换,避免差一位的经典错误。
 */
function toZeroBased(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return -1
  return n - 1
}

/**
 * 解析 Anki 纯文本导出。
 * 兼容 `#separator:` 头部;无头部时按首行是否含分隔符自动猜 TSV/CSV。
 */
export function parseAnkiText(text: string): AnkiParseResult {
  const warnings: string[] = []
  const header = parseTextHeader(text)

  // 无头部时自动嗅探分隔符
  const bodyLines = text.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith('#'))
  if (header.columns.length === 0 && !/^#/m.test(text)) {
    header.separator = sniffSeparator(bodyLines[0] ?? '')
    if (header.separator === ',') header.html = false
  }

  const separator = header.separator || '\t'
  const notes: AnkiNote[] = []

  for (const raw of bodyLines) {
    const cells = splitRespectingQuotes(raw, separator)
    if (cells.length === 0 || cells.every((c) => !c.trim())) continue

    const clean = (s: string) => {
      const v = (s ?? '').trim()
      return header.html ? stripHtml(v) : v
    }

    const tags =
      header.tagsColumn >= 0 ? splitTags(cells[header.tagsColumn] ?? '') : splitTags(cells[2] ?? '')
    const deck = header.deckColumn >= 0 ? (cells[header.deckColumn] ?? '').trim() : ''
    const modelName =
      header.notetypeColumn >= 0 ? (cells[header.notetypeColumn] ?? '').trim() : ''

    const front = clean(cells[0] ?? '')
    const back = clean(cells[1] ?? '')
    const extra = cells.slice(2).filter((_, i) => {
      const real = i + 2
      return (
        real !== header.tagsColumn &&
        real !== header.deckColumn &&
        real !== header.notetypeColumn &&
        real !== header.guidColumn
      )
    })

    if (!front && !back) continue

    notes.push({
      noteId: `text-${notes.length}`,
      front,
      back,
      extraFields: extra.map(clean).filter(Boolean),
      tags,
      deck,
      modelName,
    })
  }

  if (!notes.length) warnings.push('未解析到任何笔记,请确认文件为 Anki「纯文本」导出格式')
  return { notes, warnings, media: {} }
}

/** 嗅探分隔符:按出现次数最多的候选。 */
export function sniffSeparator(line: string): string {
  const candidates = ['\t', ',', ';', '|']
  let best = '\t'
  let bestCount = 0
  for (const c of candidates) {
    const n = line.split(c).length - 1
    if (n > bestCount) {
      bestCount = n
      best = c
    }
  }
  return best
}

/** 按分隔符切分,识别 RFC4180 风格的双引号包裹。 */
export function splitRespectingQuotes(line: string, separator: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"' && cur.trim() === '') {
      inQuotes = true
      continue
    }
    if (ch === separator) {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur)
  return cells
}

/** Anki 标签用空格分隔。 */
export function splitTags(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(/\s+/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter(Boolean)
}

// ══════════════════════════════════════════════════════════════
// 3. .apkg 解析(解包 + SQLite)
// ══════════════════════════════════════════════════════════════

let sqlPromise: Promise<SqlJsStatic> | null = null

/**
 * wasm 本地路径。
 *
 * 刻意**不用 CDN**:App 要求全程离线可用,所以 sql-wasm.wasm 由
 * `public/sql-wasm.wasm` 随包发布(`scripts/copy-sql-wasm.mjs` 负责同步)。
 */
let sqlWasmPath = '/sql-wasm.wasm'

/** 覆盖 wasm 路径(测试或自定义部署时用)。 */
export function setSqlWasmPath(path: string): void {
  sqlWasmPath = path
  sqlPromise = null
}

/**
 * 归一化 sql.js 的**模块**形态。
 *
 * `sql.js` 是 CJS/UMD 包,在不同打包器与运行时下,`initSqlJs` 可能拿到
 * 函数本身,也可能拿到带 `default` 的模块命名空间 —— 两种都要认。
 */
export function normalizeSqlModule(mod: unknown): SqlJsStatic {
  let candidate = mod as any
  // 逐层剥 default,兼容 `{ default: { default: fn } }` 这类多层包装
  for (let i = 0; i < 3 && candidate && typeof candidate !== 'function'; i++) {
    candidate = candidate.default
  }
  if (typeof candidate !== 'function') {
    throw new Error('sql.js 初始化失败:未拿到构造函数')
  }
  return candidate as SqlJsStatic
}

/**
 * 归一化**已初始化实例**。
 * 兼容两种形态:实例对象(带 Database)或其模块包装。
 */
export function normalizeSqlInstance(input: unknown): SqlJsStatic {
  let candidate = input as any
  for (let i = 0; i < 3 && candidate && typeof candidate.Database !== 'function'; i++) {
    candidate = candidate.default
  }
  if (!candidate || typeof candidate.Database !== 'function') {
    throw new Error('sql.js 初始化失败:未拿到 Database 构造器')
  }
  return candidate as SqlJsStatic
}

/**
 * 初始化 sql.js。
 *
 * 直接 `await initSqlJs(...)` 拿到的是**实例**(带 Database),
 * 但某些打包器下 default 导入可能是模块命名空间,此时再调一次即可。
 */
export function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = Promise.resolve(initSqlJs({ locateFile: () => sqlWasmPath })).then((instance) => {
      // 运行期仍做一次归一化:打包器可能把 default 包成模块命名空间
      sqlSync = normalizeSqlInstance(instance)
      return sqlSync
    })
  }
  return sqlPromise
}

/**
 * 测试注入用:直接给一个已初始化的 sql.js 实例。
 * (Node 环境下 wasm 由 sql.js 自行解析,无需走浏览器的 /sql-wasm.wasm)
 */
export function __setSql(instance: SqlJsStatic | null): void {
  const normalized = instance ? normalizeSqlInstance(instance) : null
  sqlPromise = normalized ? Promise.resolve(normalized) : null
  sqlSync = normalized
}

/** 取已初始化的 sql.js 构造器(必须先 await getSql() 或 __setSql())。 */
let sqlSync: SqlJsStatic | null = null

/** 打开 Anki 集合数据库(处理 2.1.50+ 的 zstd 压缩形态)。 */
export function openAnkiDB(bytes: Uint8Array): Database {
  let payload = bytes
  // collection.anki21b 整库经 zstd 压缩,魔数 0x28B52FFD
  if (
    bytes.length > 3 &&
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
  ) {
    payload = zstdDecompress(bytes)
  }
  const SQL = sqlSync
  if (!SQL) throw new Error('sql.js 尚未初始化,请先 await getSql()')
  return new SQL.Database(payload)
}

/** 从解包结果中挑出集合数据库文件名。 */
export function findCollectionFile(zip: Unzipped): string | null {
  const order = ['collection.anki21', 'collection.anki2', 'collection.anki21b']
  for (const name of order) {
    if (zip[name]) return name
  }
  return null
}

/** Anki 内部模型定义(`col.models` JSON 的一段)。 */
interface AnkiModelTemplate {
  name: string
  qfmt: string
  afmt: string
}
interface AnkiModel {
  name: string
  flds?: { name: string; ord: number }[]
  tmpls?: AnkiModelTemplate[]
}

/**
 * 渲染 Anki 模板:`{{FieldName}}` / `{{FrontSide}}`。
 * 仅支持最常用的替换语义 —— 复杂条件模板交给后续的 HTML 清洗兜底。
 */
export function renderAnkiTemplate(
  template: string,
  fields: Record<string, string>,
  frontSide = '',
): string {
  let out = template

  // {{FrontSide}} 原样嵌入
  out = out.replace(/\{\{\s*FrontSide\s*\}\}/gi, frontSide)
  // 条件块 {{#F}}...{{/F}} / {{^F}}...{{/F}}
  out = out.replace(
    /\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_m, name: string, body: string) => (fields[name.trim()] ? body : ''),
  )
  out = out.replace(
    /\{\{\^([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_m, name: string, body: string) => (fields[name.trim()] ? '' : body),
  )
  // 普通字段替换(含 {{type:Field}} / {{text:Field}} 等前缀)
  out = out.replace(/\{\{([^}]+)\}\}/g, (_m, expr: string) => {
    const name = expr.includes(':') ? expr.slice(expr.indexOf(':') + 1) : expr
    return fields[name.trim()] ?? ''
  })
  return out
}

/** 把 fields 数组映射成 {字段名: 值}。 */
export function zipFields(fieldNames: string[], values: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  fieldNames.forEach((name, i) => {
    out[name] = values[i] ?? ''
  })
  return out
}

/**
 * 解析 `.apkg` 字节流。
 * @param bytes 原始文件内容
 * @param loadMedia 是否导出图片为 dataURL(默认 true,大体积包可关)
 */
export async function parseApkg(
  bytes: Uint8Array,
  loadMedia = true,
): Promise<AnkiParseResult> {
  const warnings: string[] = []
  let zip: Unzipped
  try {
    zip = unzipSync(bytes)
  } catch {
    return { notes: [], warnings: ['文件不是有效的 zip/apkg 包'], media: {} }
  }

  const collectionFile = findCollectionFile(zip)
  if (!collectionFile) {
    return {
      notes: [],
      warnings: ['apkg 内未找到 collection.anki2 / collection.anki21'],
      media: {},
    }
  }

  await getSql()

  let db: Database
  try {
    db = openAnkiDB(zip[collectionFile]!)
    // sql.js 是惰性解析的:打开时不报错,首次查询才暴露"不是数据库"。
    // 这里主动探一次,把损坏文件挡在解析流程之外。
    db.exec('SELECT name FROM sqlite_master LIMIT 1')
  } catch (err) {
    return {
      notes: [],
      warnings: [`集合数据库打开失败:${err instanceof Error ? err.message : String(err)}`],
      media: {},
    }
  }

  try {
    // ── 模型(templates) ──
    const models: Record<string, AnkiModel> = {}
    try {
      const colRows = db.exec('SELECT models FROM col LIMIT 1')
      const raw = colRows[0]?.values?.[0]?.[0]
      if (typeof raw === 'string') Object.assign(models, JSON.parse(raw))
    } catch {
      warnings.push('未能读取笔记模板,将按前两个字段解析')
    }

    // ── 牌组 ──
    const decks: Record<string, string> = {}
    try {
      const deckRows = db.exec('SELECT decks FROM col LIMIT 1')
      const raw = deckRows[0]?.values?.[0]?.[0]
      if (typeof raw === 'string') {
        const parsed = JSON.parse(raw) as Record<string, { name?: string }>
        for (const [id, d] of Object.entries(parsed)) decks[id] = d?.name ?? ''
      }
    } catch {
      /* 牌组缺失不影响主流程 */
    }

    // ── 笔记 ──
    // 优先通过 cards 关联牌组;无 cards 时退化为直接读 notes
    const notes: AnkiNote[] = []
    let noteRows: unknown[][]
    try {
      const res = db.exec(
        `SELECT n.id, n.mid, n.flds, n.tags, COALESCE(c.did, 1)
         FROM notes n LEFT JOIN cards c ON c.nid = n.id
         GROUP BY n.id`,
      )
      noteRows = (res[0]?.values as unknown[][]) ?? []
    } catch {
      warnings.push('notes/cards 表结构异常,改用简化读取')
      const res = db.exec('SELECT id, mid, flds, tags FROM notes')
      noteRows = ((res[0]?.values as unknown[][]) ?? []).map((r) => [...r, 1])
    }

    for (const row of noteRows) {
      const [id, mid, flds, tags, did] = row as [unknown, unknown, unknown, unknown, unknown]
      const rawFields = String(flds ?? '').split(FIELD_SEPARATOR)
      const model = models[String(mid)] ?? null

      // 有模板则按模板渲染出真正的正反面;否则取前两字段
      let front = ''
      let back = ''
      if (model?.tmpls?.length && model.flds?.length) {
        const fieldNames = [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name)
        const values = zipFields(fieldNames, rawFields)
        const tpl = model.tmpls[0]!
        const qfmt = tpl.qfmt ?? ''
        const afmt = tpl.afmt ?? ''

        front = stripHtml(renderAnkiTemplate(qfmt, values))

        // 答案模板里的 {{FrontSide}} 是给 Anki 自己复现题面用的。
        // ABDrop 的背面只放答案,所以先把它渲染成空,避免正反面文字重复。
        const answerOnly = stripHtml(renderAnkiTemplate(afmt, values, ''))
        back = answerOnly || stripHtml(renderAnkiTemplate(afmt, values, qfmt))
      }
      if (!front && !back) {
        const plain = rawFields.map(stripHtml)
        front = plain[0] ?? ''
        back = plain[1] ?? ''
      }

      const tagList = splitTags(String(tags ?? '').replace(/\u0000/g, ' '))
      const deckName = decks[String(did)] ?? ''

      notes.push({
        noteId: String(id),
        front,
        back,
        extraFields: rawFields.slice(2).map(stripHtml).filter(Boolean),
        tags: tagList,
        deck: deckName,
        modelName: model?.name ?? '',
      })
    }

    // ── 媒体(仅图片,转 dataURL) ──
    const media: Record<string, string> = {}
    if (loadMedia) {
      let mediaMap: Record<string, string> = {}
      try {
        if (zip['media']) {
          mediaMap = JSON.parse(strFromU8(zip['media']!)) as Record<string, string>
        }
      } catch {
        /* 无 media 索引 */
      }
      // 只提取被笔记引用到的图片,避免整包解码
      const referenced = new Set<string>()
      const usedNames = new Set<string>()
      for (const n of notes) {
        for (const m of `${n.front}\n${n.back}\n${n.extraFields.join('\n')}`.matchAll(
          /\[\[img:([^\]]+)\]\]/g,
        )) {
          usedNames.add(m[1]!)
        }
      }
      for (const [idx, name] of Object.entries(mediaMap)) {
        if (usedNames.has(name) && zip[idx]) referenced.add(idx)
      }
      for (const idx of referenced) {
        const name = mediaMap[idx]
        const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? ''
        if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) continue
        if (!name) continue
        media[name] = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${bytesToBase64(zip[idx]!)}`
      }
    }

    if (!notes.length) warnings.push('apkg 中没有任何笔记')
    return { notes, warnings, media }
  } finally {
    db.close()
  }
}

/** 浏览器/Node 通用的 base64 编码。 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// ══════════════════════════════════════════════════════════════
// 4. 导出为 Anki
// ══════════════════════════════════════════════════════════════

export interface AnkiExportRow {
  front: string
  back: string
  tags?: string[]
  deck?: string
}

/**
 * 导出为 Anki「纯文本」TSV。
 * 首部指令与 Anki 自身的导出格式一致,可直接被 Anki 导入。
 */
export function toAnkiTsv(rows: readonly AnkiExportRow[], includeDeck = false): string {
  const header = includeDeck
    ? '#separator:tab\n#html:false\n#columns:Front\tBack\tTags\tDeck\n#tags column:3\n#deck column:4\n'
    : '#separator:tab\n#html:false\n#columns:Front\tBack\tTags\n#tags column:3\n'

  const body = rows
    .map((r) => {
      const cells = [escapeCell(r.front), escapeCell(r.back), (r.tags ?? []).join(' ')]
      if (includeDeck) cells.push(r.deck ?? 'ABDrop')
      return cells.join('\t')
    })
    .join('\n')

  return `${header}${body}\n`
}

/** 导出为 Anki 可导入的 CSV(带表头注释)。 */
export function toAnkiCsv(rows: readonly AnkiExportRow[]): string {
  const header = '#separator:comma\n#html:false\n#columns:Front,Back,Tags\n#tags column:3\n'
  const body = rows
    .map((r) => [quoteCsv(r.front), quoteCsv(r.back), quoteCsv((r.tags ?? []).join(' '))].join(','))
    .join('\n')
  return `${header}${body}\n`
}

function escapeCell(value: string): string {
  return (value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>')
}

function quoteCsv(value: string): string {
  const v = (value ?? '').replace(/\r?\n/g, '<br>')
  return `"${v.replace(/"/g, '""')}"`
}

/** 生成带时间戳的导出文件名。 */
export function ankiExportFilename(prefix = 'abdrop-anki', ext = 'tsv', now = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('')
  return `${prefix}-${stamp}.${ext}`
}
