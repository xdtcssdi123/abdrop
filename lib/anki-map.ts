/**
 * Anki ↔ ABDrop 模型映射。
 *
 * 这一层是「兼容 Anki」的合同:字段往哪边对、牌组怎么变合集、
 * 导出时标签怎么拼 —— 全部收敛在此,双向可测。
 */

import type { AnkiNote } from '~/lib/anki'
import type { AnkiExportRow, AnkiParseResult } from '~/lib/anki'
import type { Collection, ImportReport, KnowledgeCard } from '~/types'
import { DEFAULT_EASE, levelFromAnki, stateForLevel } from '~/lib/srs'
import { DEFAULT_COLLECTION_ID } from '~/lib/db-constants'
import { hash32 } from '~/lib/hash'

// 保持向后兼容:此前 hash32 定义在本模块,已被多个模块引用
export { hash32 }

/** 提取文本中的图片占位符 `[[img:xxx]]`。 */
export function extractImageRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\[\[img:([^\]]+)\]\]/g)) out.push(m[1]!)
  return out
}

/** 把文本里的图片占位符换成空(正文不该显示文件名)。 */
export function stripImagePlaceholders(text: string): string {
  return text.replace(/\[\[img:[^\]]+\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 生成一个稳定、确定性的卡片 id。
 *
 * 用途:同一份 apkg 重复导入必须命中去重,所以 id 不能带随机数。
 * 形如 `anki-<noteId>-<字段指纹>`,既幂等又能容纳同 note 的多张卡。
 */
export function stableCardId(noteId: string, front: string, back: string): string {
  return `anki-${noteId}-${hash32(`${front}\u0000${back}`).toString(36)}`
}

/** 白名单/清洗标签:去空、去重、限制数量。 */
export function normalizeTags(tags: readonly string[], limit = 32): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim().replace(/^#/, '')
    if (!t || t.length > 60) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 单条 Anki 笔记 → 卡片。
 *
 * @param now              创建时间戳
 * @param collectionId     目标合集
 * @param media            媒体表(用于把图片占位转成 imageUri)
 * @param intervalByNoteId Anki 原调度信息(可选,apkg 导入时提供)
 */
export function noteToCard(
  note: AnkiNote,
  options: {
    now?: number
    collectionId?: string
    media?: Record<string, string>
    intervalDays?: number
    ankiType?: number
    ease?: number
    lapses?: number
    due?: number
  } = {},
): KnowledgeCard {
  const now = options.now ?? Date.now()
  const media = options.media ?? {}

  // 取出第一个可用图片作为卡片配图,其余保留在正文占位处
  const refs = extractImageRefs(`${note.front}\n${note.back}`)
  let imageUri = ''
  for (const ref of refs) {
    const hit = media[ref]
    if (hit) {
      imageUri = hit
      break
    }
  }

  const front = stripImagePlaceholders(note.front) || note.modelName || '导入卡片'
  const backParts = [stripImagePlaceholders(note.back), ...note.extraFields.map(stripImagePlaceholders)]
  const back = backParts.filter(Boolean).join('\n\n')

  const intervalDays = options.intervalDays ?? 0
  const level = levelFromAnki(intervalDays, options.ankiType ?? 0)

  // 到期时间:Anki 的 due 是「天序号」,与绝对时间不同基准,
  // 这里不做换算(极易算错),统一按导入时刻立刻可见,
  // 保留原 interval 仅用于展示与下次调度。
  const nextReviewAt = now

  return {
    id: stableCardId(note.noteId, note.front, note.back),
    front,
    back,
    sourceText: [note.front, note.back].filter(Boolean).join('\n'),
    collectionId: options.collectionId || DEFAULT_COLLECTION_ID,
    tags: normalizeTags(note.tags),
    modelName: note.modelName,
    level,
    intervalDays,
    ease: options.ease && options.ease > 0 ? options.ease : DEFAULT_EASE,
    syncState: stateForLevel(level),
    lapses: options.lapses ?? 0,
    createdAt: now,
    nextReviewAt,
    lastReviewedAt: 0,
    reviewCount: 0,
    passCount: 0,
    failCount: 0,
    imageUri,
    ankiNoteId: note.noteId,
    backEdited: false,
    deleted: false,
    updatedAt: now,
  }
}

/**
 * 卡片 → Anki 导出行。
 * 标签并入:既有 tags,也带上等级标记,便于用户在 Anki 侧筛选。
 */
export function cardToAnkiRow(card: KnowledgeCard, collectionName?: string): AnkiExportRow {
  const tags = normalizeTags([...card.tags, `abdrop-lv${card.level}`])
  return {
    front: card.front,
    back: card.back,
    tags,
    deck: collectionName || 'ABDrop',
  }
}

/**
 * 把 Anki 牌组名收敛成合集集合。
 * 返回「牌组名 → 合集名」的映射,空牌组回落到「未分类」。
 */
export function buildCollectionPlan(
  notes: readonly AnkiNote[],
  fallbackName = '未分类',
): { names: string[]; byDeck: Record<string, string> } {
  const names: string[] = []
  const seen = new Set<string>()
  const byDeck: Record<string, string> = {}

  for (const note of notes) {
    const deck = (note.deck || '').trim()
    // Anki 的 "父::子" 牌组取末级,避免层级过深
    const leaf = deck.includes('::') ? deck.split('::').pop()!.trim() : deck
    const name = leaf || fallbackName
    byDeck[deck] = name
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return { names, byDeck }
}

/**
 * 按牌组合集计划把笔记铺平成可入库的卡片。
 * 这是一个纯函数:输入解析结果 + 已有卡片,输出「待写入」与「跳过」。
 */
export function planAnkiImport(
  parsed: AnkiParseResult,
  existingIds: ReadonlySet<string>,
  collectionIdByName: ReadonlyMap<string, string>,
  now: number = Date.now(),
): { cards: KnowledgeCard[]; report: ImportReport } {
  const warnings = [...parsed.warnings]
  const { names, byDeck } = buildCollectionPlan(parsed.notes)
  const cards: KnowledgeCard[] = []
  let skipped = 0

  for (const note of parsed.notes) {
    // 源头就空白的笔记直接丢弃 —— 不能靠 noteToCard 的兜底文案蒙混过去
    if (!note.front.trim() && !note.back.trim()) {
      skipped++
      continue
    }

    const targetName = byDeck[(note.deck || '').trim()] ?? '未分类'
    const collectionId = collectionIdByName.get(targetName) ?? DEFAULT_COLLECTION_ID

    const draft = noteToCard(note, { now, collectionId, media: parsed.media })

    if (existingIds.has(draft.id)) {
      skipped++
      continue
    }
    cards.push(draft)
  }

  if (skipped > 0) warnings.push(`跳过 ${skipped} 条(重复或空内容)`)

  return {
    cards,
    report: {
      added: cards.length,
      skipped,
      collections: names,
      warnings,
    },
  }
}

/** 为新牌组准备合集对象(缺哪个补哪个)。 */
export function missingCollections(
  deckNames: readonly string[],
  existing: readonly Collection[],
  now: number = Date.now(),
): Collection[] {
  const have = new Set(existing.map((c) => c.name))
  const out: Collection[] = []
  let order = existing.length
  for (const name of deckNames) {
    if (!name || have.has(name)) continue
    have.add(name)
    out.push({
      id: `anki-col-${hash32(name).toString(36)}`,
      name,
      order: order++,
      createdAt: now,
    })
  }
  return out
}
