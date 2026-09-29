/**
 * IndexedDB 持久层。
 *
 * 设计约束:
 * 1. 全部数据落在本地,零网络依赖,离线可用。
 * 2. 图片以 dataURL 随卡片存,原生端与 Web 端同构。
 * 3. 无 IndexedDB 环境(SSR / 单测降级)自动切内存实现,接口完全一致。
 * 4. 兼容 Anki:卡片模型自带 ivl/factor/type/lapses,另有「按 ankiNoteId 查重」能力。
 *
 * 对外只暴露 `useCardRepository()`,UI 层永不直接碰 IDB。
 */

import { openDB, type IDBPDatabase } from 'idb'
import type { Collection, KnowledgeCard, NewCardInput } from '~/types'
import { computeNextReviewAt, DEFAULT_EASE, selectDueCards, stateForLevel } from '~/lib/srs'
import {
  DB_NAME,
  DB_VERSION,
  DEFAULT_COLLECTION_ID,
  DEFAULT_COLLECTION_NAME,
  STORE_CARDS,
  STORE_COLLECTIONS,
} from '~/lib/db-constants'

export * from '~/lib/db-constants'

export const DEFAULT_COLLECTION: Collection = {
  id: DEFAULT_COLLECTION_ID,
  name: DEFAULT_COLLECTION_NAME,
  order: 0,
  createdAt: 0,
}

let dbPromise: Promise<IDBPDatabase> | null = null

/** 当前环境是否支持真实 IndexedDB(单测/SSR 会退回内存实现)。 */
export function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_CARDS)) {
          const cards = db.createObjectStore(STORE_CARDS, { keyPath: 'id' })
          cards.createIndex('nextReviewAt', 'nextReviewAt')
          cards.createIndex('collectionId', 'collectionId')
          cards.createIndex('createdAt', 'createdAt')
          cards.createIndex('ankiNoteId', 'ankiNoteId')
        }
        if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
          db.createObjectStore(STORE_COLLECTIONS, { keyPath: 'id' })
        }
      },
    })
  }
  return dbPromise
}

/** 测试用:关闭连接并重置单例。 */
export async function resetDBConnection(): Promise<void> {
  if (dbPromise) {
    try {
      const db = await dbPromise
      db.close()
    } catch {
      /* 连接可能已失效,忽略 */
    }
    dbPromise = null
  }
}

/** 生成卡片 id,优先 UUID,降级随机串。 */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `card_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 把卡片规整成**纯数据结构**。
 *
 * 为什么必须有这一步:UI 层传进来的卡片来自 Vue 的响应式数组,
 * 是 Proxy 对象,而 IndexedDB 的 structuredClone 无法克隆 Proxy,
 * 会直接抛 DataCloneError —— 表现为"滑动复习后数据存不进去"。
 * 在持久化边界上统一脱壳,UI 层就不必关心这件事。
 */
export function toPlainCard(card: KnowledgeCard): KnowledgeCard {
  return {
    id: card.id,
    front: card.front,
    back: card.back,
    sourceText: card.sourceText,
    collectionId: card.collectionId,
    // 数组也要复制:嵌套值同样可能是 Proxy
    tags: Array.isArray(card.tags) ? card.tags.map(String) : [],
    modelName: card.modelName,
    level: card.level,
    intervalDays: card.intervalDays,
    ease: card.ease,
    syncState: card.syncState,
    lapses: card.lapses,
    createdAt: card.createdAt,
    nextReviewAt: card.nextReviewAt,
    lastReviewedAt: card.lastReviewedAt,
    reviewCount: card.reviewCount,
    passCount: card.passCount,
    failCount: card.failCount,
    imageUri: card.imageUri,
    ankiNoteId: card.ankiNoteId,
    backEdited: card.backEdited,
    deleted: card.deleted,
    updatedAt: card.updatedAt,
  }
}

/**
 * 依据输入构造一条完整卡片记录。
 * 新卡等级 0,nextReviewAt = now → 立刻出现在首页。
 */
export function createCard(input: NewCardInput, now: number = Date.now()): KnowledgeCard {
  return {
    id: newId(),
    front: input.front.trim(),
    back: (input.back ?? '').trim(),
    sourceText: (input.sourceText ?? input.front).trim(),
    collectionId: input.collectionId || DEFAULT_COLLECTION_ID,
    tags: input.tags ?? [],
    modelName: input.modelName ?? '',
    level: 0,
    intervalDays: 0,
    ease: DEFAULT_EASE,
    syncState: stateForLevel(0),
    lapses: 0,
    createdAt: now,
    nextReviewAt: computeNextReviewAt(0, now),
    lastReviewedAt: 0,
    reviewCount: 0,
    passCount: 0,
    failCount: 0,
    imageUri: input.imageUri ?? '',
    ankiNoteId: input.ankiNoteId ?? '',
    backEdited: false,
    deleted: false,
    updatedAt: now,
  }
}

/** 仓储接口 —— UI 与测试都只依赖它。 */
export interface CardRepository {
  addCard(input: NewCardInput, now?: number): Promise<KnowledgeCard>
  /** 批量写入(Anki 导入用),返回实际写入条数 */
  addCards(cards: readonly KnowledgeCard[]): Promise<number>
  putCard(card: KnowledgeCard): Promise<KnowledgeCard>
  getCard(id: string): Promise<KnowledgeCard | undefined>
  listCards(): Promise<KnowledgeCard[]>
  listDueCards(now?: number): Promise<KnowledgeCard[]>
  listCardsByCollection(collectionId: string, now?: number): Promise<KnowledgeCard[]>
  /** 按 Anki 笔记 id 查已存在的卡片(去重用) */
  findCardsByAnkiNoteId(noteId: string): Promise<KnowledgeCard[]>
  /** 已存在的全部 id(导入去重用) */
  existingIds(): Promise<Set<string>>
  removeCard(id: string): Promise<void>
  countCards(): Promise<number>

  listCollections(): Promise<Collection[]>
  createCollection(name: string): Promise<Collection>
  /** 按名字查找,不存在则创建 */
  ensureCollection(name: string): Promise<Collection>
  renameCollection(id: string, name: string): Promise<void>
  removeCollection(id: string): Promise<void>

  exportAll(): Promise<{ cards: KnowledgeCard[]; collections: Collection[] }>
  importAll(payload: { cards: KnowledgeCard[]; collections: Collection[] }): Promise<number>
  clearAll(): Promise<void>
}

/** ── 内存实现(单测与无 IDB 环境降级) ───────────────────────── */
export function createMemoryRepository(): CardRepository {
  const cards = new Map<string, KnowledgeCard>()
  const collections = new Map<string, Collection>([
    [DEFAULT_COLLECTION_ID, { ...DEFAULT_COLLECTION }],
  ])

  const repo: CardRepository = {
    async addCard(input, now = Date.now()) {
      const card = createCard(input, now)
      cards.set(card.id, card)
      return card
    },
    async addCards(list) {
      let n = 0
      for (const card of list) {
        const plain = toPlainCard(card)
        cards.set(plain.id, plain)
        n++
      }
      return n
    },
    async putCard(card) {
      const plain = toPlainCard(card)
      cards.set(plain.id, plain)
      return plain
    },
    async getCard(id) {
      return cards.get(id)
    },
    async listCards() {
      return [...cards.values()].filter((c) => !c.deleted)
    },
    async listDueCards(now = Date.now()) {
      return selectDueCards([...cards.values()], now)
    },
    async listCardsByCollection(collectionId, now = Date.now()) {
      return selectDueCards(
        [...cards.values()].filter((c) => c.collectionId === collectionId),
        now,
      )
    },
    async findCardsByAnkiNoteId(noteId) {
      if (!noteId) return []
      return [...cards.values()].filter((c) => c.ankiNoteId === noteId && !c.deleted)
    },
    async existingIds() {
      return new Set(cards.keys())
    },
    async removeCard(id) {
      const card = cards.get(id)
      if (card) cards.set(id, { ...card, deleted: true, updatedAt: Date.now() })
    },
    async countCards() {
      return [...cards.values()].filter((c) => !c.deleted).length
    },
    async listCollections() {
      return [...collections.values()].sort((a, b) => a.order - b.order)
    },
    async createCollection(name) {
      const col: Collection = {
        id: newId(),
        name: name.trim() || '新合集',
        order: collections.size,
        createdAt: Date.now(),
      }
      collections.set(col.id, col)
      return col
    },
    async ensureCollection(name) {
      const trimmed = name.trim() || DEFAULT_COLLECTION_NAME
      const hit = [...collections.values()].find((c) => c.name === trimmed)
      if (hit) return hit
      return repo.createCollection(trimmed)
    },
    async renameCollection(id, name) {
      const col = collections.get(id)
      if (col) collections.set(id, { ...col, name: name.trim() || col.name })
    },
    async removeCollection(id) {
      if (id === DEFAULT_COLLECTION_ID) return
      collections.delete(id)
      // 合集删除后其下卡片回落「未分类」,绝不丢数据
      for (const [cid, card] of cards) {
        if (card.collectionId === id) {
          cards.set(cid, { ...card, collectionId: DEFAULT_COLLECTION_ID, updatedAt: Date.now() })
        }
      }
    },
    async exportAll() {
      return {
        cards: [...cards.values()].filter((c) => !c.deleted),
        collections: [...collections.values()].sort((a, b) => a.order - b.order),
      }
    },
    async importAll(payload) {
      let n = 0
      for (const col of payload.collections ?? []) collections.set(col.id, col)
      for (const card of payload.cards ?? []) {
        const plain = toPlainCard(card)
        cards.set(plain.id, plain)
        n++
      }
      return n
    },
    async clearAll() {
      cards.clear()
      collections.clear()
      collections.set(DEFAULT_COLLECTION_ID, { ...DEFAULT_COLLECTION })
    },
  }

  return repo
}

/** ── IndexedDB 实现 ─────────────────────────────────────────────── */
export function createIndexedDBRepository(): CardRepository {
  async function ensureDefaults(): Promise<void> {
    const db = await getDB()
    const existing = await db.get(STORE_COLLECTIONS, DEFAULT_COLLECTION_ID)
    if (!existing) {
      await db.put(STORE_COLLECTIONS, { ...DEFAULT_COLLECTION, createdAt: Date.now() })
    }
  }

  const repo: CardRepository = {
    async addCard(input, now = Date.now()) {
      await ensureDefaults()
      const card = createCard(input, now)
      const db = await getDB()
      await db.put(STORE_CARDS, card)
      return card
    },
    async addCards(list) {
      if (!list.length) return 0
      await ensureDefaults()
      const db = await getDB()
      const tx = db.transaction(STORE_CARDS, 'readwrite')
      let n = 0
      for (const card of list) {
        // 必须脱壳:UI 传来的可能是 Vue 响应式 Proxy,structuredClone 无法克隆
        await tx.store.put(toPlainCard(card))
        n++
      }
      await tx.done
      return n
    },
    async putCard(card) {
      const db = await getDB()
      const plain = toPlainCard(card)
      await db.put(STORE_CARDS, plain)
      return plain
    },
    async getCard(id) {
      const db = await getDB()
      return (await db.get(STORE_CARDS, id)) as KnowledgeCard | undefined
    },
    async listCards() {
      const db = await getDB()
      const all = (await db.getAll(STORE_CARDS)) as KnowledgeCard[]
      return all.filter((c) => !c.deleted)
    },
    async listDueCards(now = Date.now()) {
      const db = await getDB()
      // 走索引只取到期区间,卡量上千后差别明显
      const range = IDBKeyRange.upperBound(now)
      const due = (await db.getAllFromIndex(STORE_CARDS, 'nextReviewAt', range)) as KnowledgeCard[]
      return selectDueCards(due, now)
    },
    async listCardsByCollection(collectionId, now = Date.now()) {
      const db = await getDB()
      const rows = (await db.getAllFromIndex(
        STORE_CARDS,
        'collectionId',
        collectionId,
      )) as KnowledgeCard[]
      return selectDueCards(rows, now)
    },
    async findCardsByAnkiNoteId(noteId) {
      if (!noteId) return []
      const db = await getDB()
      const rows = (await db.getAllFromIndex(STORE_CARDS, 'ankiNoteId', noteId)) as KnowledgeCard[]
      return rows.filter((c) => !c.deleted)
    },
    async existingIds() {
      const db = await getDB()
      const keys = await db.getAllKeys(STORE_CARDS)
      return new Set(keys.map(String))
    },
    async removeCard(id) {
      const db = await getDB()
      const card = (await db.get(STORE_CARDS, id)) as KnowledgeCard | undefined
      if (!card) return
      await db.put(STORE_CARDS, { ...card, deleted: true, updatedAt: Date.now() })
    },
    async countCards() {
      const db = await getDB()
      const all = (await db.getAll(STORE_CARDS)) as KnowledgeCard[]
      return all.filter((c) => !c.deleted).length
    },
    async listCollections() {
      await ensureDefaults()
      const db = await getDB()
      const all = (await db.getAll(STORE_COLLECTIONS)) as Collection[]
      return all.sort((a, b) => a.order - b.order)
    },
    async createCollection(name) {
      await ensureDefaults()
      const db = await getDB()
      const all = (await db.getAll(STORE_COLLECTIONS)) as Collection[]
      const col: Collection = {
        id: newId(),
        name: name.trim() || '新合集',
        order: all.length,
        createdAt: Date.now(),
      }
      await db.put(STORE_COLLECTIONS, col)
      return col
    },
    async ensureCollection(name) {
      const trimmed = name.trim() || DEFAULT_COLLECTION_NAME
      const all = await repo.listCollections()
      const hit = all.find((c) => c.name === trimmed)
      if (hit) return hit
      return repo.createCollection(trimmed)
    },
    async renameCollection(id, name) {
      const db = await getDB()
      const col = (await db.get(STORE_COLLECTIONS, id)) as Collection | undefined
      if (!col) return
      await db.put(STORE_COLLECTIONS, { ...col, name: name.trim() || col.name })
    },
    async removeCollection(id) {
      if (id === DEFAULT_COLLECTION_ID) return
      const db = await getDB()
      await db.delete(STORE_COLLECTIONS, id)
      const rows = (await db.getAllFromIndex(STORE_CARDS, 'collectionId', id)) as KnowledgeCard[]
      const tx = db.transaction(STORE_CARDS, 'readwrite')
      for (const card of rows) {
        await tx.store.put({ ...card, collectionId: DEFAULT_COLLECTION_ID, updatedAt: Date.now() })
      }
      await tx.done
    },
    async exportAll() {
      const db = await getDB()
      const allCards = (await db.getAll(STORE_CARDS)) as KnowledgeCard[]
      const allCollections = (await db.getAll(STORE_COLLECTIONS)) as Collection[]
      return {
        cards: allCards.filter((c) => !c.deleted),
        collections: allCollections.sort((a, b) => a.order - b.order),
      }
    },
    async importAll(payload) {
      const db = await getDB()
      const tx = db.transaction([STORE_CARDS, STORE_COLLECTIONS], 'readwrite')
      let n = 0
      for (const col of payload.collections ?? []) {
        await tx.objectStore(STORE_COLLECTIONS).put(col)
      }
      for (const card of payload.cards ?? []) {
        await tx.objectStore(STORE_CARDS).put(toPlainCard(card))
        n++
      }
      await tx.done
      return n
    },
    async clearAll() {
      const db = await getDB()
      const tx = db.transaction([STORE_CARDS, STORE_COLLECTIONS], 'readwrite')
      await tx.objectStore(STORE_CARDS).clear()
      await tx.objectStore(STORE_COLLECTIONS).clear()
      await tx.done
      await ensureDefaults()
    },
  }

  return repo
}

let repo: CardRepository | null = null

/** 取全局仓储单例;无 IDB 时降级内存实现,调用方无感。 */
export function useCardRepository(): CardRepository {
  if (!repo) {
    repo = hasIndexedDB() ? createIndexedDBRepository() : createMemoryRepository()
  }
  return repo
}

/** 测试用:替换/重置仓储单例。 */
export function __setRepository(next: CardRepository | null): void {
  repo = next
}
