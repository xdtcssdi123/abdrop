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
import type { CardRepository } from '~/lib/db'
import type { ImportReport, KnowledgeCard } from '~/types'

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
  content: string
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

/** 导出 ABDrop 原生备份(含全部调度字段,可完美还原)。 */
export async function exportNativeBackup(
  repo: CardRepository,
  now: Date = new Date(),
): Promise<ExportOutcome> {
  const { cards, collections } = await repo.exportAll()
  const payload = {
    version: 2 as const,
    exportedAt: now.getTime(),
    cards,
    collections,
  }
  return {
    filename: ankiExportFilename('abdrop-backup', 'json', now),
    content: JSON.stringify(payload, null, 2),
    mime: 'application/json',
    count: cards.length,
  }
}

/** 从原生备份还原。 */
export async function importNativeBackup(
  file: File,
  repo: CardRepository,
): Promise<ImportReport> {
  const text = await file.text()
  let parsed: { cards?: KnowledgeCard[]; collections?: KnowledgeCard[] }
  try {
    parsed = JSON.parse(text)
  } catch {
    return { added: 0, skipped: 0, collections: [], warnings: ['备份文件不是合法 JSON'] }
  }
  if (!Array.isArray(parsed.cards)) {
    return { added: 0, skipped: 0, collections: [], warnings: ['备份文件缺少 cards 字段'] }
  }
  const collections = Array.isArray(parsed.collections) ? parsed.collections : []
  const existing = await repo.existingIds()
  let skipped = 0
  const fresh = parsed.cards.filter((c) => {
    if (existing.has(c.id)) {
      skipped++
      return false
    }
    return true
  })
  await repo.importAll({ cards: fresh, collections: collections as any })
  return {
    added: fresh.length,
    skipped,
    collections: (collections as any[]).map((c: any) => c.name),
    warnings: [],
  }
}
