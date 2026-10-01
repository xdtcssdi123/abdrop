/**
 * 复习服务与端到端流程测试。
 *
 * 串起"录入 → 到期池 → 滑动 → 重算 → 下次到期"这条主干,
 * 验证整条链路而不只是单个函数。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createReviewService,
  popCard,
  recomputePool,
  type ReviewService,
} from '~/lib/review-service'
import { createMemoryRepository, type CardRepository, DEFAULT_COLLECTION_ID } from '~/lib/db'
import { ALL_COLLECTIONS_ID } from '~/lib/db-constants'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '~/lib/srs'

let repo: CardRepository
let service: ReviewService

beforeEach(() => {
  repo = createMemoryRepository()
  service = createReviewService(repo)
})

describe('loadPool', () => {
  it('只返回到期卡片', async () => {
    const now = 1_700_000_000_000
    await repo.addCard({ front: '到期' }, now)
    const future = await repo.addCard({ front: '未到期' }, now)
    await repo.putCard({ ...future, nextReviewAt: now + DAY_MS })

    const pool = await service.loadPool(ALL_COLLECTIONS_ID, now)
    expect(pool).toHaveLength(1)
    expect(pool[0]!.front).toBe('到期')
  })

  it('「全部」范围汇总所有合集', async () => {
    const now = Date.now()
    const col = await repo.createCollection('数学')
    await repo.addCard({ front: 'A', collectionId: col.id }, now)
    await repo.addCard({ front: 'B' }, now)

    expect(await service.loadPool(ALL_COLLECTIONS_ID, now)).toHaveLength(2)
  })

  it('「未分类」是独立合集,不是「全部」(回归)', async () => {
    const now = Date.now()
    const col = await repo.createCollection('数学')
    await repo.addCard({ front: 'A', collectionId: col.id }, now)
    await repo.addCard({ front: 'B' }, now)

    // 只应拿到未分类那一张,不能混进数学的卡
    const pool = await service.loadPool(DEFAULT_COLLECTION_ID, now)
    expect(pool).toHaveLength(1)
    expect(pool[0]!.front).toBe('B')
  })

  it('指定合集时只返回该合集', async () => {
    const now = Date.now()
    const col = await repo.createCollection('数学')
    await repo.addCard({ front: 'A', collectionId: col.id }, now)
    await repo.addCard({ front: 'B' }, now)

    const pool = await service.loadPool(col.id, now)
    expect(pool).toHaveLength(1)
    expect(pool[0]!.front).toBe('A')
  })
})

describe('commitReview', () => {
  it('右滑推进等级并落库', async () => {
    const now = 1_700_000_000_000
    const card = await repo.addCard({ front: 'Q' }, now)

    const next = await service.commitReview(card, 'pass', now)
    expect(next.level).toBe(1)

    // 确认真的写进了仓储,而不是只改了内存对象
    const stored = await repo.getCard(card.id)
    expect(stored?.level).toBe(1)
    expect(stored?.nextReviewAt).toBe(now + 20 * MINUTE_MS)
  })

  it('左滑把卡片推回待复习', async () => {
    const now = 1_700_000_000_000
    const card = { ...(await repo.addCard({ front: 'Q' }, now)), level: 4 as const }
    await repo.putCard(card)

    const next = await service.commitReview(card, 'fail', now)
    expect(next.level).toBe(1)
    expect(next.syncState).toBe('relearning')
    expect(next.lapses).toBe(1)
  })

  it('复习后卡片从到期池消失', async () => {
    const now = Date.now()
    const card = await repo.addCard({ front: 'Q' }, now)
    expect(await service.loadPool(ALL_COLLECTIONS_ID, now)).toHaveLength(1)

    await service.commitReview(card, 'pass', now)
    expect(await service.loadPool(ALL_COLLECTIONS_ID, now)).toHaveLength(0)
  })

  it('不修改传入的卡片对象', async () => {
    const now = Date.now()
    const card = await repo.addCard({ front: 'Q' }, now)
    const snapshot = { ...card }
    await service.commitReview(card, 'pass', now)
    expect(card).toEqual(snapshot)
  })
})

describe('patchCard / deleteCard', () => {
  it('就地编辑保留创建时间与 id', async () => {
    const card = await repo.addCard({ front: '旧', sourceText: '旧' })
    const patched = await service.patchCard(card.id, { front: '新', backEdited: true })

    expect(patched?.front).toBe('新')
    expect(patched?.id).toBe(card.id)
    expect(patched?.createdAt).toBe(card.createdAt)
    expect(patched?.backEdited).toBe(true)
  })

  it('编辑不存在的卡片返回 null,不抛异常', async () => {
    expect(await service.patchCard('不存在', { front: 'x' })).toBeNull()
  })

  it('更新 updatedAt 时间戳', async () => {
    const card = await repo.addCard({ front: 'Q' })
    const patched = await service.patchCard(card.id, { front: 'R' }, card.createdAt + 5000)
    expect(patched?.updatedAt).toBe(card.createdAt + 5000)
  })

  it('删除后不再出现在池中', async () => {
    const card = await repo.addCard({ front: 'Q' })
    await service.deleteCard(card.id)
    expect(await service.loadPool(ALL_COLLECTIONS_ID)).toHaveLength(0)
  })
})

describe('队列辅助纯函数', () => {
  it('popCard 按 id 移除', async () => {
    const a = await repo.addCard({ front: 'A' })
    const b = await repo.addCard({ front: 'B' })
    expect(popCard([a, b], a.id).map((c) => c.front)).toEqual(['B'])
  })

  it('popCard 不修改原数组', async () => {
    const a = await repo.addCard({ front: 'A' })
    const pool = [a]
    popCard(pool, a.id)
    expect(pool).toHaveLength(1)
  })

  it('recomputePool 剔除已不到期的卡片', async () => {
    const now = 1_700_000_000_000
    const due = await repo.addCard({ front: '到期' }, now)
    const future = { ...(await repo.addCard({ front: '未来' }, now)), nextReviewAt: now + DAY_MS }
    const out = recomputePool([due, future], now)
    expect(out.map((c) => c.front)).toEqual(['到期'])
  })
})

describe('端到端:录入到复习的完整链路', () => {
  it('录入 → 出现在池中 → 右滑 → 阶梯推进 → 到期间隔逐步拉长', async () => {
    let now = 1_700_000_000_000
    const card = await service.addCard({ front: '什么是导数', back: '瞬时变化率' }, now)

    // 新卡立即可复习
    expect(await service.loadPool(ALL_COLLECTIONS_ID, now)).toHaveLength(1)

    // 连续 7 次答对,间隔按经典艾宾浩斯表推进
    // (等级 1-7 每级都是上一次复习后推进;用相对间隔验证单调拉长)
    const expectedMs = [
      20 * MINUTE_MS,
      1 * HOUR_MS,
      9 * HOUR_MS,
      1 * DAY_MS,
      2 * DAY_MS,
      6 * DAY_MS,
      31 * DAY_MS,
    ]
    for (let i = 0; i < 7; i++) {
      const due = await service.loadPool(ALL_COLLECTIONS_ID, now)
      expect(due).toHaveLength(1)

      const reviewed = await service.commitReview(due[0]!, 'pass', now)
      expect(reviewed.nextReviewAt - reviewed.lastReviewedAt).toBe(expectedMs[i])

      // 未到下次到期时间,池中不应再出现
      expect(await service.loadPool(ALL_COLLECTIONS_ID, now)).toHaveLength(0)

      // 时间推进到下次复习点,卡片重新出现
      now = reviewed.nextReviewAt
      expect(await service.loadPool(ALL_COLLECTIONS_ID, now)).toHaveLength(1)
    }

    const final = await repo.getCard(card.id)
    expect(final?.level).toBe(7)
    expect(final?.reviewCount).toBe(7)
    expect(final?.passCount).toBe(7)
  })

  it('答错一次使卡片回到第 1 档(20 分钟)重走,并记录遗忘', async () => {
    const now = 1_700_000_000_000
    const card = await service.addCard({ front: 'Q' }, now)

    // 先答对三次,升到等级 3(9 小时档)
    let current = card
    for (let i = 0; i < 3; i++) current = await service.commitReview(current, 'pass', now)
    expect(current.level).toBe(3)

    // 再答错 → 回第 1 档,20 分钟后重走
    const failed = await service.commitReview(current, 'fail', now)
    expect(failed.level).toBe(1)
    expect(failed.nextReviewAt).toBe(now + 20 * MINUTE_MS)
    expect(failed.failCount).toBe(1)
    expect(failed.lapses).toBe(1)
  })

  it('多张卡片按逾期程度排队,复习一张后下一张补位', async () => {
    const base = 1_700_000_000_000
    // 三张卡:逾期 1 天 / 3 天 / 5 天
    const c1 = await repo.addCard({ front: '轻' }, base - 1 * DAY_MS)
    const c2 = await repo.addCard({ front: '中' }, base - 3 * DAY_MS)
    const c3 = await repo.addCard({ front: '重' }, base - 5 * DAY_MS)

    // 只把 nextReviewAt 设为过去,createdAt 保持为传入的 now
    const pool = await service.loadPool('inbox', base)
    expect(pool.map((c) => c.front)).toEqual(['重', '中', '轻'])

    await service.commitReview(pool[0]!, 'pass', base)
    const after = await service.loadPool('inbox', base)
    expect(after.map((c) => c.front)).toEqual(['中', '轻'])

    // 确认被复习的那张(重)已不在池中
    expect(after.some((c) => c.id === c3.id)).toBe(false)
    expect(after.some((c) => c.id === c2.id)).toBe(true)
    expect(after.some((c) => c.id === c1.id)).toBe(true)
  })
})
