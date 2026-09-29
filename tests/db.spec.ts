/**
 * IndexedDB 仓储测试。
 *
 * setup.ts 注入了 fake-indexeddb,所以这里跑的是**真实的 IDB 代码路径**。
 * 同时用同一套断言跑内存实现,保证两个实现行为一致(接口契约测试)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_COLLECTION_ID,
  __setRepository,
  createCard,
  createIndexedDBRepository,
  createMemoryRepository,
  useCardRepository,
  type CardRepository,
} from '~/lib/db'
import { DAY_MS } from '~/lib/srs'

/** 参数化:同一套契约,两个实现都要满足。 */
const implementations: Array<[string, () => CardRepository]> = [
  ['IndexedDB', createIndexedDBRepository],
  ['Memory', createMemoryRepository],
]

describe.each(implementations)('仓储契约 — %s 实现', (_name, factory) => {
  let repo: CardRepository

  beforeEach(() => {
    repo = factory()
  })

  it('新增卡片后可读回,字段完整', async () => {
    const now = 1_700_000_000_000
    const created = await repo.addCard({ front: '什么是极限?', back: '趋近过程的描述' }, now)
    expect(created.id).toBeTruthy()
    expect(created.level).toBe(0)
    expect(created.nextReviewAt).toBe(now)

    const read = await repo.getCard(created.id)
    expect(read?.front).toBe('什么是极限?')
    expect(read?.back).toBe('趋近过程的描述')
  })

  it('新卡立即到期(level 0 → nextReviewAt = now)', async () => {
    const now = Date.now()
    await repo.addCard({ front: 'Q' }, now)
    const due = await repo.listDueCards(now)
    expect(due).toHaveLength(1)
  })

  it('未到期的卡片不出现在到期池', async () => {
    const now = Date.now()
    const card = await repo.addCard({ front: 'Q' }, now)
    await repo.putCard({ ...card, nextReviewAt: now + DAY_MS })
    expect(await repo.listDueCards(now)).toHaveLength(0)
  })

  it('软删除后不再出现在列表与计数中,但记录仍在库里', async () => {
    const card = await repo.addCard({ front: 'Q' })
    await repo.removeCard(card.id)

    expect(await repo.listCards()).toHaveLength(0)
    expect(await repo.countCards()).toBe(0)
    expect(await repo.listDueCards()).toHaveLength(0)
    // 软删:记录本身保留,便于将来恢复/同步
    expect((await repo.getCard(card.id))?.deleted).toBe(true)
  })

  it('putCard 覆盖写入并保留原 id', async () => {
    const card = await repo.addCard({ front: 'Q' })
    await repo.putCard({ ...card, front: 'Q2', level: 3 })
    const read = await repo.getCard(card.id)
    expect(read?.front).toBe('Q2')
    expect(read?.level).toBe(3)
    expect(await repo.countCards()).toBe(1)
  })

  it('按合集过滤到期卡', async () => {
    const now = Date.now()
    const a = await repo.createCollection('数学')
    const b = await repo.createCollection('英语')
    await repo.addCard({ front: 'A', collectionId: a.id }, now)
    await repo.addCard({ front: 'B', collectionId: b.id }, now)

    const math = await repo.listCardsByCollection(a.id, now)
    expect(math).toHaveLength(1)
    expect(math[0]!.front).toBe('A')
  })

  it('批量写入 addCards 返回实际条数', async () => {
    const cards = [
      createCard({ front: '1' }),
      createCard({ front: '2' }),
      createCard({ front: '3' }),
    ]
    expect(await repo.addCards(cards)).toBe(3)
    expect(await repo.countCards()).toBe(3)
  })

  it('批量写入空数组是安全的', async () => {
    expect(await repo.addCards([])).toBe(0)
  })

  it('existingIds 返回全部键(含软删),供导入去重', async () => {
    const a = await repo.addCard({ front: 'A' })
    const b = await repo.addCard({ front: 'B' })
    await repo.removeCard(b.id)
    const ids = await repo.existingIds()
    expect(ids.has(a.id)).toBe(true)
    expect(ids.has(b.id)).toBe(true)
  })

  it('按 ankiNoteId 能查到已导入的卡片', async () => {
    await repo.addCards([
      createCard({ front: 'A', ankiNoteId: 'note-1' }),
      createCard({ front: 'B', ankiNoteId: 'note-2' }),
    ])
    const hit = await repo.findCardsByAnkiNoteId('note-1')
    expect(hit).toHaveLength(1)
    expect(hit[0]!.front).toBe('A')
  })

  it('ankiNoteId 为空时查询返回空,不误报', async () => {
    await repo.addCard({ front: 'A' })
    expect(await repo.findCardsByAnkiNoteId('')).toEqual([])
  })
})

describe.each(implementations)('合集契约 — %s 实现', (_name, factory) => {
  let repo: CardRepository

  beforeEach(() => {
    repo = factory()
  })

  it('默认带一个「未分类」合集', async () => {
    const list = await repo.listCollections()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(DEFAULT_COLLECTION_ID)
    expect(list[0]!.name).toBe('未分类')
  })

  it('创建合集后可按顺序列出', async () => {
    await repo.createCollection('数学')
    await repo.createCollection('英语')
    const names = (await repo.listCollections()).map((c) => c.name)
    expect(names).toEqual(['未分类', '数学', '英语'])
  })

  it('ensureCollection 按名复用,不重复创建', async () => {
    const a = await repo.ensureCollection('数学')
    const b = await repo.ensureCollection('数学')
    expect(a.id).toBe(b.id)
    expect(await repo.listCollections()).toHaveLength(2)
  })

  it('ensureCollection 对空名字回落到「未分类」', async () => {
    const col = await repo.ensureCollection('   ')
    expect(col.name).toBe('未分类')
  })

  it('重命名合集', async () => {
    const col = await repo.createCollection('数学')
    await repo.renameCollection(col.id, '高等数学')
    const list = await repo.listCollections()
    expect(list.find((c) => c.id === col.id)?.name).toBe('高等数学')
  })

  it('删除合集时其下卡片转入未分类,绝不丢数据', async () => {
    const col = await repo.createCollection('数学')
    const card = await repo.addCard({ front: 'Q', collectionId: col.id })
    await repo.removeCollection(col.id)

    const read = await repo.getCard(card.id)
    expect(read?.collectionId).toBe(DEFAULT_COLLECTION_ID)
    expect(await repo.countCards()).toBe(1)
  })

  it('不允许删除默认「未分类」合集', async () => {
    await repo.removeCollection(DEFAULT_COLLECTION_ID)
    const list = await repo.listCollections()
    expect(list.some((c) => c.id === DEFAULT_COLLECTION_ID)).toBe(true)
  })
})

describe.each(implementations)('导入导出 — %s 实现', (_name, factory) => {
  let repo: CardRepository

  beforeEach(() => {
    repo = factory()
  })

  it('exportAll 不含软删卡片', async () => {
    const a = await repo.addCard({ front: 'A' })
    const b = await repo.addCard({ front: 'B' })
    await repo.removeCard(b.id)

    const out = await repo.exportAll()
    expect(out.cards).toHaveLength(1)
    expect(out.cards[0]!.id).toBe(a.id)
  })

  it('importAll 返回写入条数,并与已有数据合并', async () => {
    await repo.addCard({ front: '本地' })
    const incoming = [createCard({ front: '外部1' }), createCard({ front: '外部2' })]
    const n = await repo.importAll({ cards: incoming, collections: [] })
    expect(n).toBe(2)
    expect(await repo.countCards()).toBe(3)
  })

  it('clearAll 清空卡片并保留默认合集', async () => {
    await repo.addCard({ front: 'A' })
    await repo.createCollection('数学')
    await repo.clearAll()

    expect(await repo.countCards()).toBe(0)
    const cols = await repo.listCollections()
    expect(cols).toHaveLength(1)
    expect(cols[0]!.id).toBe(DEFAULT_COLLECTION_ID)
  })
})

describe('useCardRepository 单例', () => {
  it('返回同一实例', () => {
    __setRepository(null)
    const a = useCardRepository()
    const b = useCardRepository()
    expect(a).toBe(b)
  })

  it('__setRepository 可以替换实现', () => {
    const custom = createMemoryRepository()
    __setRepository(custom)
    expect(useCardRepository()).toBe(custom)
  })
})

describe('createCard 工厂', () => {
  it('生成唯一 id', () => {
    const a = createCard({ front: 'A' })
    const b = createCard({ front: 'B' })
    expect(a.id).not.toBe(b.id)
  })

  it('sourceText 未提供时回落到 front', () => {
    expect(createCard({ front: '原始' }).sourceText).toBe('原始')
  })

  it('默认归入未分类,默认等级 0、状态 new', () => {
    const card = createCard({ front: 'A' })
    expect(card.collectionId).toBe(DEFAULT_COLLECTION_ID)
    expect(card.level).toBe(0)
    expect(card.syncState).toBe('new')
    expect(card.ease).toBe(2500)
  })

  it('首尾空白被清理', () => {
    const card = createCard({ front: '  问题  ', back: '  答案  ' })
    expect(card.front).toBe('问题')
    expect(card.back).toBe('答案')
  })
})
