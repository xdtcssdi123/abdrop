/**
 * Anki 导入编排。
 *
 * 把「读文件 → 识别格式 → 解析 → 建合集 → 去重 → 批量入库」串起来。
 * 编排逻辑与解析逻辑分离,所以核心判定(`planAnkiImport`)是纯函数可单测,
 * 这里只做 IO 与仓储调用。
 */

import {
  parseAnkiText,
  parseApkg,
  ankiExportFilename,
  toAnkiCsv,
  toAnkiTsv,
  type AnkiParseResult,
} from '~/lib/anki'
import { cardToAnkiRow, planAnkiImport } from '~/lib/anki-map'
import { zipSync, strToU8, strFromU8, unzipSync } from 'fflate'
import type { CardRepository } from '~/lib/db'
import type {
  AIConfig,
  AppConfigSnapshot,
  Collection,
  ExportBundle,
  ImportReport,
  KnowledgeCard,
} from '~/types'

/** 支持导入的扩展名。 */
export const ANKI_IMPORT_ACCEPT = '.apkg,.tsv,.txt,.csv,.colpkg'

/** 从文件名判断解析路径。 */
export function detectFormat(filename: string): 'apkg' | 'text' {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'apkg' || ext === 'colpkg') return 'apkg'
  return 'text'
}

/** 读文件为字节流。 */
export async function readFileBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * 解析任意 Anki 文件。
 * 单点入口,便于 UI 侧只调这一个函数。
 */
export async function parseAnkiFile(file: File): Promise<AnkiParseResult> {
  const format = detectFormat(file.name)
  if (format === 'apkg') {
    return parseApkg(await readFileBytes(file))
  }
  const text = await file.text()
  return parseAnkiText(text)
}

/**
 * 执行导入:解析 + 建合集 + 去重 + 入库。
 *
 * 幂等性:卡片 id 由 noteId + 字段指纹确定性生成,
 * 所以同一份 apkg 导入两次不会产生重复卡片。
 */
export async function importAnkiFile(
  file: File,
  repo: CardRepository,
  now: number = Date.now(),
): Promise<ImportReport> {
  const parsed = await parseAnkiFile(file)
  return importParsedAnki(parsed, repo, now)
}

/** 解析结果 → 入库(便于补测与复用)。 */
export async function importParsedAnki(
  parsed: AnkiParseResult,
  repo: CardRepository,
  now: number = Date.now(),
): Promise<ImportReport> {
  if (!parsed.notes.length) {
    return {
      added: 0,
      skipped: 0,
      collections: [],
      warnings: parsed.warnings.length ? parsed.warnings : ['未解析到任何笔记'],
    }
  }

  // 1. 按牌组补齐缺失合集
  const existingCollections = await repo.listCollections()
  const { names } = buildDeckNameList(parsed)
  const nameToId = new Map<string, string>(existingCollections.map((c) => [c.name, c.id]))
  for (const name of names) {
    if (nameToId.has(name)) continue
    const created = await repo.ensureCollection(name)
    nameToId.set(created.name, created.id)
  }

  // 2. 去重 + 铺平
  const existingIds = await repo.existingIds()
  const { cards, report } = planAnkiImport(parsed, existingIds, nameToId, now)

  // 3. 批量入库
  const written = await repo.addCards(cards)

  return {
    ...report,
    added: written,
    collections: names,
  }
}

function buildDeckNameList(parsed: AnkiParseResult): { names: string[] } {
  const names: string[] = []
  const seen = new Set<string>()
  for (const note of parsed.notes) {
    const deck = (note.deck || '').trim()
    const leaf = deck.includes('::') ? (deck.split('::').pop() ?? '').trim() : deck
    const name = leaf || '未分类'
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return { names }
}

/** 导出结果描述。 */
export interface ExportOutcome {
  filename: string
  /** 文本导出为字符串;zip 备份为二进制 Uint8Array。 */
  content: string | Uint8Array
  mime: string
  count: number
}

/**
 * 导出全部卡片为 Anki 可导入文件。
 */
export async function exportForAnki(
  repo: CardRepository,
  format: 'tsv' | 'csv' = 'tsv',
  includeDeck = true,
  now: Date = new Date(),
): Promise<ExportOutcome> {
  const { cards, collections } = await repo.exportAll()
  const nameById = new Map(collections.map((c) => [c.id, c.name]))
  const rows = cards.map((c) => cardToAnkiRow(c, nameById.get(c.collectionId)))
  const content = format === 'tsv' ? toAnkiTsv(rows, includeDeck) : toAnkiCsv(rows)
  return {
    filename: ankiExportFilename('abdrop-anki', format, now),
    content,
    mime: format === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
    count: cards.length,
  }
}

/**
 * 导出 ABDrop 原生备份 —— 即「保存配置」。
 *
 * 单个 JSON 快照:配置(AI 接口 + 当前复习范围)+ 合集 + 卡片(含全部调度字段,
 * 即复习记忆),可完整还原。`config` 由调用方(设置页)注入当前配置;
 * 不传则写出不含 config 的旧形态(v2 兼容)。
 */
export async function exportNativeBackup(
  repo: CardRepository,
  config?: AppConfigSnapshot,
  now: Date = new Date(),
): Promise<ExportOutcome> {
  const { cards, collections } = await repo.exportAll()
  const payload: ExportBundle = {
    version: 3,
    exportedAt: now.getTime(),
    cards,
    collections,
  }
  if (config) payload.config = config
  return {
    filename: ankiExportFilename('abdrop-backup', 'json', now),
    content: JSON.stringify(payload, null, 2),
    mime: 'application/json',
    count: cards.length,
  }
}

/** 原生备份导入结果:卡片统计 + 备份携带的配置快照(由 UI 层决定如何应用)。 */
export interface NativeBackupResult extends ImportReport {
  /** 备份里的配置块;v2 备份或无 config 字段时缺省。 */
  restoredConfig?: AppConfigSnapshot
}

/** 备份包内 json 的文件名。 */
export const BACKUP_JSON_NAME = 'abdrop-backup.json'
/** 备份包内媒体目录前缀。 */
export const BACKUP_MEDIA_DIR = 'media/'

/**
 * 从 base64 dataURL 拆出 mime 与二进制,用于把卡片图片外置成独立文件。
 * 非 dataURL(空/路径)返回 null —— 那些卡没有可外置的图片。
 */
function dataUrlToBytes(
  dataUrl: string,
): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim())
  if (!m) return null
  const mime = m[1]!.toLowerCase()
  const b64 = m[2]!
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  // 常见图片扩展名
  let ext = 'img'
  if (mime.includes('png')) ext = 'png'
  else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg'
  else if (mime.includes('gif')) ext = 'gif'
  else if (mime.includes('webp')) ext = 'webp'
  return { bytes, ext }
}

/** 从二进制 + mime 还原 dataURL(导入 zip 时回填卡片图片)。 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * 导出 zip 备份包(「保存配置」升级版)。
 *
 * 包结构:
 *   abdrop-backup.json   —— 全量数据(config + cards + collections),
 *                           卡片 imageUri 改为相对路径 media/<id>.<ext>
 *   media/<id>.<ext>     —— 每张卡的图片独立二进制文件
 *
 * 图片外置让包内数据更紧凑、便于人工检视;导入时按路径回填为 dataURL。
 */
export async function exportNativeBackupZip(
  repo: CardRepository,
  config?: AppConfigSnapshot,
  now: Date = new Date(),
): Promise<ExportOutcome> {
  const { cards, collections } = await repo.exportAll()
  const payload: ExportBundle = {
    version: 4,
    exportedAt: now.getTime(),
    cards,
    collections,
  }
  if (config) payload.config = config

  // 拆出图片,imageUri 改为相对路径
  const files: Record<string, Uint8Array> = {}
  payload.cards = cards.map((c) => {
    if (!c.imageUri) return c
    const img = dataUrlToBytes(c.imageUri)
    if (!img) return c
    files[`${BACKUP_MEDIA_DIR}${c.id}.${img.ext}`] = img.bytes
    return { ...c, imageUri: `${BACKUP_MEDIA_DIR}${c.id}.${img.ext}` }
  })

  files[BACKUP_JSON_NAME] = strToU8(JSON.stringify(payload, null, 2))
  const zipped = zipSync(files, { level: 6 })

  return {
    filename: ankiExportFilename('abdrop-backup', 'zip', now),
    content: zipped,
    mime: 'application/zip',
    count: cards.length,
  }
}

/** 备份 payload 的解析结构。 */
interface BackupPayloadShape {
  cards?: KnowledgeCard[]
  collections?: Collection[]
  config?: unknown
}

/**
 * 从备份 payload 还原卡片并解析配置快照(JSON 与 zip 两条路径共用)。
 * @param parsed  备份内容(卡片/合集/配置)
 * @param repo    仓储
 * @param restoreMedia  (card, id) => 新 card:zip 导入时用媒体回填 imageUri
 */
async function importBackupPayload(
  parsed: BackupPayloadShape,
  repo: CardRepository,
  restoreMedia?: (card: KnowledgeCard) => KnowledgeCard,
): Promise<NativeBackupResult> {
  if (!Array.isArray(parsed.cards)) {
    return { added: 0, skipped: 0, collections: [], warnings: ['备份文件缺少 cards 字段'] }
  }
  const collections = Array.isArray(parsed.collections) ? parsed.collections : []
  const existing = await repo.existingIds()
  let skipped = 0
  const fresh = parsed.cards
    .filter((c) => {
      if (existing.has(c.id)) {
        skipped++
        return false
      }
      return true
    })
    .map((c) => (restoreMedia ? restoreMedia(c) : c))
  await repo.importAll({ cards: fresh, collections: collections as any })

  const result: NativeBackupResult = {
    added: fresh.length,
    skipped,
    collections: (collections as any[]).map((c: any) => c.name),
    warnings: [],
  }

  // 配置块:结构校验通过才返回,损坏时静默忽略(卡片照常还原)
  const cfg = parsed.config as AppConfigSnapshot | undefined
  if (
    cfg &&
    typeof cfg === 'object' &&
    cfg.ai &&
    typeof cfg.ai === 'object' &&
    typeof cfg.activeCollectionId === 'string'
  ) {
    result.restoredConfig = {
      ai: cfg.ai as AIConfig,
      activeCollectionId: cfg.activeCollectionId,
    }
  }

  return result
}

/** 解包 zip 备份:读 json + media 目录,图片按路径回填 dataURL。 */
async function importNativeBackupZip(
  buffer: ArrayBuffer,
  repo: CardRepository,
): Promise<NativeBackupResult> {
  try {
    const unzipped = unzipSync(new Uint8Array(buffer))
    const jsonEntry = unzipped[BACKUP_JSON_NAME]
    if (!jsonEntry) {
      return { added: 0, skipped: 0, collections: [], warnings: ['zip 备份缺少 abdrop-backup.json'] }
    }
    let parsed: BackupPayloadShape
    try {
      parsed = JSON.parse(strFromU8(jsonEntry))
    } catch {
      return { added: 0, skipped: 0, collections: [], warnings: ['备份内 json 损坏'] }
    }

    // 媒体回填:imageUri 形如 media/<id>.ext → 读回 base64 dataURL
    const restoreMedia = (card: KnowledgeCard): KnowledgeCard => {
      const m = /^media\/(.+)$/.exec(card.imageUri || '')
      if (!m) return card
      const bytes = unzipped[`media/${m[1]}`]
      if (!bytes) return card
      const mime = m[1]!.endsWith('.png')
        ? 'image/png'
        : m[1]!.endsWith('.gif')
          ? 'image/gif'
          : m[1]!.endsWith('.webp')
            ? 'image/webp'
            : 'image/jpeg'
      return { ...card, imageUri: bytesToDataUrl(bytes, mime) }
    }

    const result = await importBackupPayload(parsed, repo, restoreMedia)
    result.warnings = [...result.warnings, '已识别为 zip 备份包']
    return result
  } catch (err) {
    return {
      added: 0,
      skipped: 0,
      collections: [],
      warnings: [`解包失败:${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

/**
 * 从原生备份加载(「加载配置」):还原卡片,并解析出配置快照。
 * 同时支持 zip 包与旧版 JSON 快照 —— 按文件头自动识别。
 */
export async function importNativeBackup(
  file: File,
  repo: CardRepository,
): Promise<NativeBackupResult> {
  // zip 包:PK\x03\x04 魔数
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (head[0] === 0x50 && head[1] === 0x4b) {
    return importNativeBackupZip(await file.arrayBuffer(), repo)
  }

  // 旧版 JSON 快照
  let parsed: BackupPayloadShape
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    return { added: 0, skipped: 0, collections: [], warnings: ['备份文件不是合法 JSON'] }
  }
  return importBackupPayload(parsed, repo)
}
