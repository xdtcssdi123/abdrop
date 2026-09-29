/**
 * 复习范围(单合集锁定)测试。
 *
 * 这一组测试锁住一个曾经的设计缺陷:
 *   原本「未分类」(inbox)被当作「全部」的同义词,导致选「未分类」时
 *   会刷出所有合集的卡 —— 「未分类」这个合集反而无法被单独复习。
 *
 * 现在的契约:
 *   - `__all__`      → 跨全部合集
 *   - `inbox` 及其他 → **严格只**该合集
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createMemoryRepository, type CardRepository, DEFAULT_COLLECTION_ID } from '~/lib/db'
import { createReviewService, type ReviewService } from '~/lib/review-service'
import {
  ALL_COLLECTIONS_ID,
  ALL_COLLECTIONS_NAME,
  DEFAULT_COLLECTION_NAME,
  isAllScope,
} from '~/lib/db-constants'
import type { Collection } from '~/types'

const NOW = 1_700_000_000_000

let repo: CardRepository
let service: ReviewService
let math: Collection
let english: Collection

beforeEach(async () => {
  repo = createMemoryRepository()
  service = createReviewService(repo)

  math = await repo.createCollection('数学')
  english = await repo.createCollection('英语')

  // 三个合集各有到期卡
  await repo.addCard({ front: 'M1', collectionId: math.id }, NOW)
  await repo.addCard({ front: 'M2', collectionId: math.id }, NOW)
  await repo.addCard({ front: 'E1', collectionId: english.id }, NOW)
  await repo.addCard({ front: 'U1', collectionId: DEFAULT_COLLECTION_ID }, NOW)
})

describe('范围常量', () => {
  it('「全部」是独立的虚拟 id,不与未分类混同', () => {
    expect(ALL_COLLECTIONS_ID).not.toBe(DEFAULT_COLLECTION_ID)
    expect(ALL_COLLECTIONS_NAME).toBe('全部')
    expect(DEFAULT_COLLECTION_NAME).toBe('未分类')
  })

  it('isAllScope 只认「全部」', () => {
    expect(isAllScope(ALL_COLLECTIONS_ID)).toBe(true)
    expect(isAllScope(DEFAULT_COLLECTION_ID)).toBe(false)
    expect(isAllScope('数学')).toBe(false)
    expect(isAllScope('')).toBe(false)
  })
})

describe('loadPool —— 严格单合集', () => {
  it('「全部」跨合集,取回所有到期卡', async () => {
    const pool = await service.loadPool(ALL_COLLECTIONS_ID, NOW)
    expect(pool.map((c) => c.front).sort()).toEqual(['E1', 'M1', 'M2', 'U1'])
  })

  it('指定数学时只返回数学的卡', async () => {
    const pool = await service.loadPool(math.id, NOW)
    expect(pool.map((c) => c.front).sort()).toEqual(['M1', 'M2'])
  })

  it('指定英语时只返回英语的卡', async () => {
    const pool = await service.loadPool(english.id, NOW)
    expect(pool.map((c) => c.front)).toEqual(['E1'])
  })

  it('【回归】指定「未分类」只返回未分类的卡,不再是全部', async () => {
    const pool = await service.loadPool(DEFAULT_COLLECTION_ID, NOW)
    expect(pool.map((c) => c.front)).toEqual(['U1'])
    // 关键断言:绝不能混进其他合集的卡
    expect(pool.some((c) => c.collectionId === math.id)).toBe(false)
    expect(pool.some((c) => c.collectionId === english.id)).toBe(false)
  })

  it('不传范围时默认「全部」,首次打开不会看到空列表', async () => {
    const pool = await service.loadPool(undefined, NOW)
    expect(pool).toHaveLength(4)
  })

  it('空合集返回空数组,不误给全部', async () => {
    const empty = await repo.createCollection('空合集')
    expect(await service.loadPool(empty.id, NOW)).toEqual([])
  })

  it('不存在的合集 id 返回空数组,不垮塌成全部', async () => {
    expect(await service.loadPool('不存在的id', NOW)).toEqual([])
  })

  it('范围过滤不受到期状态影响(未到期的卡任何范围都不给)', async () => {
    const future = await repo.addCard({ front: 'FUTURE', collectionId: math.id }, NOW)
    await repo.putCard({ ...future, nextReviewAt: NOW + 86400000 })

    const pool = await service.loadPool(math.id, NOW)
    expect(pool.map((c) => c.front).sort()).toEqual(['M1', 'M2'])
  })

  it('复习后该卡从所属范围的池中消失,但不影响其他合集', async () => {
    const pool = await service.loadPool(math.id, NOW)
    await service.commitReview(pool[0]!, 'pass', NOW)

    expect(await service.loadPool(math.id, NOW)).toHaveLength(1)
    // 其他合集的卡不受影响
    expect(await service.loadPool(english.id, NOW)).toHaveLength(1)
    expect(await service.loadPool(DEFAULT_COLLECTION_ID, NOW)).toHaveLength(1)
  })

  it('「全部」在复习一张后也相应减少', async () => {
    const pool = await service.loadPool(ALL_COLLECTIONS_ID, NOW)
    await service.commitReview(pool[0]!, 'pass', NOW)
    expect(await service.loadPool(ALL_COLLECTIONS_ID, NOW)).toHaveLength(3)
  })
})

describe('范围切换的幂等与隔离', () => {
  it('反复切换范围不会改变数据', async () => {
    for (let i = 0; i < 3; i++) {
      await service.loadPool(math.id, NOW)
      await service.loadPool(ALL_COLLECTIONS_ID, NOW)
      await service.loadPool(english.id, NOW)
    }
    expect(await repo.countCards()).toBe(4)
    expect(await service.loadPool(math.id, NOW)).toHaveLength(2)
  })

  it('两个范围的结果互不干扰(池子是纯查询,无副作用)', async () => {
    const a = await service.loadPool(math.id, NOW)
    const b = await service.loadPool(english.id, NOW)
    const c = await service.loadPool(math.id, NOW)
    expect(c.map((x) => x.id)).toEqual(a.map((x) => x.id))
    expect(b).toHaveLength(1)
  })

  it('范围过滤是只读的,不会误改卡片的合集归属', async () => {
    await service.loadPool(math.id, NOW)
    const all = await repo.listCards()
    expect(all.filter((c) => c.collectionId === math.id)).toHaveLength(2)
  })
})

describe('合集计数(合集栏角标依据)', () => {
  it('按合集统计到期数量', async () => {
    const all = await service.loadPool(ALL_COLLECTIONS_ID, NOW)
    const counts: Record<string, number> = {}
    for (const card of all) counts[card.collectionId] = (counts[card.collectionId] ?? 0) + 1

    expect(counts[math.id]).toBe(2)
    expect(counts[english.id]).toBe(1)
    expect(counts[DEFAULT_COLLECTION_ID]).toBe(1)
  })

  it('计数不受当前范围影响(基于全量而非过滤后的池子)', async () => {
    // 这一点很关键:若用过滤后的池子算角标,切到数学后其他合集会显示 0
    const scoped = await service.loadPool(math.id, NOW)
    const scopedCounts: Record<string, number> = {}
    for (const c of scoped) scopedCounts[c.collectionId] = (scopedCounts[c.collectionId] ?? 0) + 1
    // 过滤后的统计确实缺失其他合集 —— 所以 UI 必须用全量数据算角标
    expect(scopedCounts[english.id]).toBeUndefined()

    const all = await service.loadPool(ALL_COLLECTIONS_ID, NOW)
    const allCounts: Record<string, number> = {}
    for (const c of all) allCounts[c.collectionId] = (allCounts[c.collectionId] ?? 0) + 1
    expect(allCounts[english.id]).toBe(1)
  })
})

describe('删除合集后的范围回落', () => {
  it('被删合集的卡转入未分类,数学范围随之清空', async () => {
    await repo.removeCollection(math.id)
    // 卡片没丢,只是改属未分类
    expect(await service.loadPool(math.id, NOW)).toEqual([])
    expect(await service.loadPool(DEFAULT_COLLECTION_ID, NOW)).toHaveLength(3)
    expect(await repo.countCards()).toBe(4)
  })
})
