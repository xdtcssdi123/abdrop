/**
 * 示例数据测试。
 *
 * 重点验证三件事:
 *   1. 幂等 —— 重复载入不产生重复卡片;
 *   2. 到期语义正确 —— 逾期/到期/未来三种状态的卡片确实落在预期位置;
 *   3. 数据自身健康 —— 每张示例卡都有正反面、等级合法、合集存在。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SEED_COLLECTIONS,
  SEED_ID_PREFIX,
  SEED_SPECS,
  buildSeedCards,
  clearDemoData,
  seedCardId,
  seedDemoData,
} from '~/lib/seed'
import { createMemoryRepository, type CardRepository } from '~/lib/db'
import { DAY_MS, selectDueCards } from '~/lib/srs'
import type { MemoryLevel } from '~/types'

const NOW = 1_700_000_000_000

let repo: CardRepository

beforeEach(() => {
  repo = createMemoryRepository()
})

describe('示例数据内容健康度', () => {
  it('每张卡都有正面与背面', () => {
    for (const spec of SEED_SPECS) {
      expect(spec.front.trim(), spec.front).toBeTruthy()
      expect(spec.back.trim(), spec.front).toBeTruthy()
    }
  })

  it('正面互不重复(否则确定性 id 会碰撞)', () => {
    const fronts = SEED_SPECS.map((s) => s.front)
    expect(new Set(fronts).size).toBe(fronts.length)
  })

  it('记忆等级都在 0–5 范围内', () => {
    for (const spec of SEED_SPECS) {
      expect(spec.level).toBeGreaterThanOrEqual(0)
      expect(spec.level).toBeLessThanOrEqual(5)
    }
  })

  it('所有卡片的合集名都在声明的合集列表里', () => {
    const known = new Set<string>(SEED_COLLECTIONS)
    for (const spec of SEED_SPECS) expect(known.has(spec.collection), spec.collection).toBe(true)
  })

  it('覆盖全部记忆等级 0–5,让强度条有明显差异', () => {
    const levels = new Set(SEED_SPECS.map((s) => s.level))
    expect([...levels].sort()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('同时包含"首页可见"与"未来到期"的卡片', () => {
    expect(SEED_SPECS.some((s) => s.dueOffsetDays <= 0)).toBe(true)
    expect(SEED_SPECS.some((s) => s.dueOffsetDays > 0)).toBe(true)
  })

  it('包含逾期很久的卡片,便于观察排序', () => {
    expect(SEED_SPECS.some((s) => s.dueOffsetDays <= -7)).toBe(true)
  })

  it('每张卡都带标签与原文(体现归纳链路)', () => {
    for (const spec of SEED_SPECS) {
      expect(spec.tags.length, spec.front).toBeGreaterThan(0)
      expect(spec.sourceText.trim(), spec.front).toBeTruthy()
    }
  })

  it('规模适中 —— 够演示又不至于淹没首页', () => {
    expect(SEED_SPECS.length).toBeGreaterThanOrEqual(15)
    expect(SEED_SPECS.length).toBeLessThanOrEqual(40)
  })
})

describe('确定性 id', () => {
  it('同一正面总是得到同一 id', () => {
    expect(seedCardId('问题')).toBe(seedCardId('问题'))
  })

  it('不同正面得到不同 id', () => {
    expect(seedCardId('问题A')).not.toBe(seedCardId('问题B'))
  })

  it('带 demo 前缀,便于批量识别与清除', () => {
    expect(seedCardId('x').startsWith(`${SEED_ID_PREFIX}-`)).toBe(true)
  })
})

describe('buildSeedCards', () => {
  const nameToId = new Map(SEED_COLLECTIONS.map((n, i) => [n, `col-${i}`]))

  it('按声明生成等量卡片', () => {
    expect(buildSeedCards(SEED_SPECS, nameToId, NOW)).toHaveLength(SEED_SPECS.length)
  })

  it('到期时间按 dueOffsetDays 正确换算', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    SEED_SPECS.forEach((spec, i) => {
      expect(cards[i]!.nextReviewAt).toBe(NOW + spec.dueOffsetDays * DAY_MS)
    })
  })

  it('逾期卡片确实落在到期池里', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    const overdue = cards.filter((c) => c.nextReviewAt <= NOW)
    expect(overdue.length).toBeGreaterThan(0)
    // 全部逾期卡都应被 selectDueCards 选中
    expect(selectDueCards(cards, NOW)).toHaveLength(overdue.length)
  })

  it('未来到期的卡片不进到期池', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    const future = cards.filter((c) => c.nextReviewAt > NOW)
    expect(future.length).toBeGreaterThan(0)
    const dueIds = new Set(selectDueCards(cards, NOW).map((c) => c.id))
    for (const card of future) expect(dueIds.has(card.id)).toBe(false)
  })

  it('间隔天数由等级推导,保持自洽', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    const level5 = cards.find((c) => c.level === 5)!
    expect(level5.intervalDays).toBe(15)
    const level0 = cards.find((c) => c.level === 0)!
    expect(level0.intervalDays).toBe(0)
  })

  it('已复习过的卡:上次复习时间早于下次到期时间', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    for (const card of cards) {
      if (card.reviewCount > 0) {
        expect(card.lastReviewedAt, card.front).toBeLessThan(card.nextReviewAt)
      }
    }
  })

  it('从未复习的卡 lastReviewedAt 为 0', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    for (const card of cards) {
      if (card.reviewCount === 0) expect(card.lastReviewedAt, card.front).toBe(0)
    }
  })

  it('等级 0 的卡即便复习过也不会出现非法时间(间隔为 0 的边界)', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    for (const card of cards) {
      expect(Number.isFinite(card.nextReviewAt), card.front).toBe(true)
      expect(Number.isFinite(card.lastReviewedAt), card.front).toBe(true)
    }
  })

  it('合集名映射到对应 id', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    const mathSpec = SEED_SPECS.findIndex((s) => s.collection === '数学')
    expect(cards[mathSpec]!.collectionId).toBe(nameToId.get('数学'))
  })

  it('未知合集名回落到默认未分类,不会崩', () => {
    const cards = buildSeedCards([SEED_SPECS[0]!], new Map(), NOW)
    expect(cards[0]!.collectionId).toBe('inbox')
  })

  it('卡片不是已删除状态,标记为示例来源', () => {
    const cards = buildSeedCards(SEED_SPECS, nameToId, NOW)
    for (const card of cards) {
      expect(card.deleted).toBe(false)
      expect(card.modelName).toBe('示例数据')
    }
  })

  it('时间可注入,同一 now 产出完全一致(纯函数)', () => {
    const a = buildSeedCards(SEED_SPECS, nameToId, NOW)
    const b = buildSeedCards(SEED_SPECS, nameToId, NOW)
    expect(a).toEqual(b)
  })
})

describe('seedDemoData 写入仓储', () => {
  it('写入全部示例卡片', async () => {
    const report = await seedDemoData(repo, { now: NOW })
    expect(report.added).toBe(SEED_SPECS.length)
    expect(report.skipped).toBe(0)
    expect(await repo.countCards()).toBe(SEED_SPECS.length)
  })

  it('自动创建示例合集', async () => {
    await seedDemoData(repo, { now: NOW })
    const names = (await repo.listCollections()).map((c) => c.name)
    for (const seedName of SEED_COLLECTIONS) expect(names).toContain(seedName)
  })

  it('重复载入是幂等的,不产生重复卡片', async () => {
    const first = await seedDemoData(repo, { now: NOW })
    const second = await seedDemoData(repo, { now: NOW })

    expect(first.added).toBe(SEED_SPECS.length)
    expect(second.added).toBe(0)
    expect(second.skipped).toBe(SEED_SPECS.length)
    expect(await repo.countCards()).toBe(SEED_SPECS.length)
  })

  it('重复载入不会重复创建同名合集', async () => {
    await seedDemoData(repo, { now: NOW })
    await seedDemoData(repo, { now: NOW })
    const cols = await repo.listCollections()
    expect(cols).toHaveLength(SEED_COLLECTIONS.length + 1) // +1 是默认「未分类」
  })

  it('可以只载入到期的卡片(不含未来卡)', async () => {
    const report = await seedDemoData(repo, { now: NOW, includeFuture: false })
    const expectedDue = SEED_SPECS.filter((s) => s.dueOffsetDays <= 0).length
    expect(report.added).toBe(expectedDue)

    const due = await repo.listDueCards(NOW)
    expect(due).toHaveLength(expectedDue)
  })

  it('limit 可限制载入数量', async () => {
    const report = await seedDemoData(repo, { now: NOW, limit: 3 })
    expect(report.added).toBe(3)
    expect(await repo.countCards()).toBe(3)
  })

  it('载入后首页到期池数量与预期一致', async () => {
    await seedDemoData(repo, { now: NOW })
    const due = await repo.listDueCards(NOW)
    const expected = SEED_SPECS.filter((s) => s.dueOffsetDays <= 0).length
    expect(due).toHaveLength(expected)
  })

  it('到期池按逾期程度排序,最久未复习的排最前', async () => {
    await seedDemoData(repo, { now: NOW })
    const due = await repo.listDueCards(NOW)
    const mostOverdue = SEED_SPECS.reduce((min, s) =>
      s.dueOffsetDays < min.dueOffsetDays ? s : min,
    )
    expect(due[0]!.front).toBe(mostOverdue.front)
  })

  it('示例卡片可以直接参与复习调度', async () => {
    await seedDemoData(repo, { now: NOW })
    const due = await repo.listDueCards(NOW)
    const card = due[0]!
    // 模拟一次右滑:等级 +1,到期时间推后
    const { scheduleReview } = await import('~/lib/srs')
    const next = scheduleReview(card, 'pass', NOW)
    await repo.putCard(next)

    const stored = await repo.getCard(card.id)
    expect(stored!.level).toBe((card.level + 1) as MemoryLevel)
    expect(stored!.nextReviewAt).toBeGreaterThan(NOW)
    expect(stored!.reviewCount).toBe(card.reviewCount + 1)
  })

  it('不受已有用户数据影响(只跳过自己的重复)', async () => {
    await repo.addCard({ front: '我自己录入的卡' })
    await seedDemoData(repo, { now: NOW })
    expect(await repo.countCards()).toBe(SEED_SPECS.length + 1)
  })
})

describe('clearDemoData', () => {
  it('移除全部示例卡片', async () => {
    await seedDemoData(repo, { now: NOW })
    const removed = await clearDemoData(repo)
    expect(removed).toBe(SEED_SPECS.length)
    expect(await repo.countCards()).toBe(0)
  })

  it('不动用户自己录入的卡片', async () => {
    const mine = await repo.addCard({ front: '我自己录入的卡' })
    await seedDemoData(repo, { now: NOW })
    await clearDemoData(repo)

    expect(await repo.countCards()).toBe(1)
    expect((await repo.getCard(mine.id))?.deleted).toBe(false)
  })

  it('没有示例数据时返回 0,不报错', async () => {
    expect(await clearDemoData(repo)).toBe(0)
  })

  it('移除后可以重新载入', async () => {
    await seedDemoData(repo, { now: NOW })
    await clearDemoData(repo)
    const again = await seedDemoData(repo, { now: NOW })
    expect(again.added).toBe(SEED_SPECS.length)
  })

  it('移除后合集仍然保留(不误删用户可能已在用的合集)', async () => {
    await seedDemoData(repo, { now: NOW })
    await clearDemoData(repo)
    const names = (await repo.listCollections()).map((c) => c.name)
    for (const seedName of SEED_COLLECTIONS) expect(names).toContain(seedName)
  })
})
