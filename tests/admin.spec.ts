/**
 * 管理员操作测试。
 *
 * 重置是破坏性且不可逆的,所以这组测试的重点是:
 *   1. 两种强度的语义边界 —— 只清计时**绝不能**动等级与统计;
 *   2. 范围隔离 —— 重置数学不能碰到英语;
 *   3. 纯函数契约 —— `resetCard` 不修改入参。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  RESET_MODE_INFO,
  describeReset,
  inScope,
  previewReset,
  resetCard,
  resetCards,
} from '~/lib/admin'
import { createMemoryRepository, DEFAULT_COLLECTION_ID, type CardRepository } from '~/lib/db'
import { ALL_COLLECTIONS_ID } from '~/lib/db-constants'
import { DEFAULT_EASE, DAY_MS } from '~/lib/srs'
import type { Collection, KnowledgeCard, MemoryLevel } from '~/types'

const NOW = 1_700_000_000_000

let repo: CardRepository
let math: Collection
let english: Collection

/** 造一张"有记忆进度"的卡片。 */
async function makeProgressedCard(
  front: string,
  collectionId: string,
  over: Partial<KnowledgeCard> = {},
): Promise<KnowledgeCard> {
  const base = await repo.addCard({ front, back: `${front} 的答案`, collectionId }, NOW)
  const card: KnowledgeCard = {
    ...base,
    level: 4 as MemoryLevel,
    intervalDays: 7,
    ease: 2600,
    syncState: 'review',
    lapses: 3,
    reviewCount: 9,
    passCount: 7,
    failCount: 2,
    lastReviewedAt: NOW - DAY_MS,
    // 关键:有未来计时,才需要"清除计时"
    nextReviewAt: NOW + 7 * DAY_MS,
    ...over,
  }
  await repo.putCard(card)
  return card
}

beforeEach(async () => {
  repo = createMemoryRepository()
  math = await repo.createCollection('数学')
  english = await repo.createCollection('英语')
})

describe('RESET_MODE_INFO 文案', () => {
  it('两种强度都有完整说明', () => {
    for (const key of ['schedule', 'full'] as const) {
      const info = RESET_MODE_INFO[key]
      expect(info.label).toBeTruthy()
      expect(info.description.length).toBeGreaterThan(10)
    }
  })

  it('只有「完全重新开始」被标记为破坏性', () => {
    expect(RESET_MODE_INFO.schedule.destructive).toBe(false)
    expect(RESET_MODE_INFO.full.destructive).toBe(true)
  })
})

describe('resetCard —— 纯函数契约', () => {
  it('不修改入参对象', async () => {
    const card = await makeProgressedCard('Q', math.id)
    const snapshot = { ...card }
    resetCard(card, 'full', NOW)
    expect(card).toEqual(snapshot)
  })

  it('返回新对象', async () => {
    const card = await makeProgressedCard('Q', math.id)
    expect(resetCard(card, 'full', NOW)).not.toBe(card)
  })
})

describe("resetCard —— 'schedule' 只清计时", () => {
  it('卡片立刻到期', async () => {
    const card = await makeProgressedCard('Q', math.id)
    const next = resetCard(card, 'schedule', NOW)
    expect(next.nextReviewAt).toBe(NOW)
  })

  it('记忆等级、间隔、状态、因子全部保持不变', async () => {
    const card = await makeProgressedCard('Q', math.id)
    const next = resetCard(card, 'schedule', NOW)
    expect(next.level).toBe(4)
    expect(next.intervalDays).toBe(7)
    expect(next.syncState).toBe('review')
    expect(next.ease).toBe(2600)
  })

  it('复习统计保持不变', async () => {
    const card = await makeProgressedCard('Q', math.id)
    const next = resetCard(card, 'schedule', NOW)
    expect(next.reviewCount).toBe(9)
    expect(next.passCount).toBe(7)
    expect(next.failCount).toBe(2)
    expect(next.lapses).toBe(3)
  })

  it('上次复习时间保持不变(它记录的是客观历史)', async () => {
    const card = await makeProgressedCard('Q', math.id)
    const next = resetCard(card, 'schedule', NOW)
    expect(next.lastReviewedAt).toBe(NOW - DAY_MS)
  })

  it('更新 updatedAt,便于识别被改过的卡', async () => {
    const card = await makeProgressedCard('Q', math.id)
    expect(resetCard(card, 'schedule', NOW).updatedAt).toBe(NOW)
  })

  it('内容字段完全不动', async () => {
    const card = await makeProgressedCard('Q', math.id)
    const next = resetCard(card, 'schedule', NOW)
    expect(next.front).toBe(card.front)
    expect(next.back).toBe(card.back)
    expect(next.tags).toEqual(card.tags)
    expect(next.collectionId).toBe(card.collectionId)
  })
})

describe("resetCard —— 'full' 完全重来", () => {
  it('等级归零、间隔归零、状态回到 new', async () => {
    const card = await makeProgressedCard('Q', math.id)
    const next = resetCard(card, 'full', NOW)
    expect(next.level).toBe(0)
    expect(next.intervalDays).toBe(0)
    expect(next.syncState).toBe('new')
  })

  it('难度因子复位到默认值', async () => {
    const card = await makeProgressedCard('Q', math.id)
    expect(resetCard(card, 'full', NOW).ease).toBe(DEFAULT_EASE)
  })

  it('复习统计与遗忘次数全部清空', async () => {
    const card = await makeProgressedCard('Q', math.id)
    const next = resetCard(card, 'full', NOW)
    expect(next.reviewCount).toBe(0)
    expect(next.passCount).toBe(0)
    expect(next.failCount).toBe(0)
    expect(next.lapses).toBe(0)
    expect(next.lastReviewedAt).toBe(0)
  })

  it('卡片立刻到期', async () => {
    const card = await makeProgressedCard('Q', math.id)
    expect(resetCard(card, 'full', NOW).nextReviewAt).toBe(NOW)
  })

  it('**内容绝不删除** —— 只重置进度', async () => {
    const card = await makeProgressedCard('Q', math.id, {
      imageUri: 'data:image/png;base64,AAA',
      ankiNoteId: 'note-123',
    })
    const next = resetCard(card, 'full', NOW)
    expect(next.front).toBe(card.front)
    expect(next.back).toBe(card.back)
    expect(next.imageUri).toBe(card.imageUri)
    expect(next.ankiNoteId).toBe(card.ankiNoteId)
    expect(next.id).toBe(card.id)
    expect(next.createdAt).toBe(card.createdAt)
    expect(next.deleted).toBe(false)
  })

  it('重置后的卡片与本就没学过的新卡状态一致', async () => {
    const progressed = await makeProgressedCard('Q', math.id)
    const fresh = await repo.addCard({ front: '另一个', collectionId: math.id }, NOW)
    const reset = resetCard(progressed, 'full', NOW)

    for (const field of ['level', 'intervalDays', 'ease', 'syncState', 'lapses', 'reviewCount'] as const) {
      expect(reset[field], field).toEqual(fresh[field])
    }
    expect(reset.nextReviewAt).toBe(NOW)
  })
})

describe('inScope 范围判定', () => {
  it('「全部」命中所有卡片', async () => {
    const card = await makeProgressedCard('Q', math.id)
    expect(inScope(card, { collectionId: ALL_COLLECTIONS_ID })).toBe(true)
  })

  it('具体合集只命中自己的卡', async () => {
    const card = await makeProgressedCard('Q', math.id)
    expect(inScope(card, { collectionId: math.id })).toBe(true)
    expect(inScope(card, { collectionId: english.id })).toBe(false)
  })

  it('「未分类」是独立范围,不命中其他合集', async () => {
    const card = await makeProgressedCard('Q', math.id)
    expect(inScope(card, { collectionId: DEFAULT_COLLECTION_ID })).toBe(false)
  })
})

describe('previewReset 预览', () => {
  it('统计范围内卡片数与到期/有计时数量', async () => {
    await makeProgressedCard('M1', math.id)
    await makeProgressedCard('M2', math.id)
    // 一张已到期的
    await makeProgressedCard('M3', math.id, { nextReviewAt: NOW - DAY_MS })

    const p = await previewReset(repo, { collectionId: math.id }, NOW)
    expect(p.total).toBe(3)
    expect(p.due).toBe(1)
    expect(p.scheduled).toBe(2)
  })

  it('「全部」覆盖所有合集', async () => {
    await makeProgressedCard('M1', math.id)
    await makeProgressedCard('E1', english.id)

    const p = await previewReset(repo, { collectionId: ALL_COLLECTIONS_ID }, NOW)
    expect(p.total).toBe(2)
    expect(p.scheduled).toBe(2)
  })

  it('空范围返回全 0', async () => {
    const p = await previewReset(repo, { collectionId: math.id }, NOW)
    expect(p).toEqual({ total: 0, due: 0, scheduled: 0 })
  })
})

describe('resetCards 批量执行', () => {
  it('「只清计时」把范围内的卡全部拉回今天', async () => {
    await makeProgressedCard('M1', math.id)
    await makeProgressedCard('M2', math.id)
    await makeProgressedCard('E1', english.id)

    const report = await resetCards(repo, { collectionId: math.id }, 'schedule', NOW, '数学')
    expect(report.affected).toBe(2)

    const due = await repo.listDueCards(NOW)
    const fronts = due.map((c) => c.front).sort()
    // 数学两张到期;英语那张仍未来到期
    expect(fronts).toEqual(['M1', 'M2'])
  })

  it('「只清计时」不改记忆等级(落库验证)', async () => {
    const card = await makeProgressedCard('M1', math.id)
    await resetCards(repo, { collectionId: math.id }, 'schedule', NOW)
    const stored = await repo.getCard(card.id)
    expect(stored!.level).toBe(4)
    expect(stored!.reviewCount).toBe(9)
  })

  it('「完全重来」把等级与统计全部清零(落库验证)', async () => {
    const card = await makeProgressedCard('M1', math.id)
    await resetCards(repo, { collectionId: math.id }, 'full', NOW)
    const stored = await repo.getCard(card.id)
    expect(stored!.level).toBe(0)
    expect(stored!.reviewCount).toBe(0)
    expect(stored!.ease).toBe(DEFAULT_EASE)
  })

  it('【范围隔离】重置数学不碰英语', async () => {
    const m = await makeProgressedCard('M1', math.id)
    const e = await makeProgressedCard('E1', english.id)

    await resetCards(repo, { collectionId: math.id }, 'full', NOW)

    expect((await repo.getCard(m.id))!.level).toBe(0)
    // 英语完全没被动过
    const eStored = await repo.getCard(e.id)
    expect(eStored!.level).toBe(4)
    expect(eStored!.reviewCount).toBe(9)
    expect(eStored!.nextReviewAt).toBe(NOW + 7 * DAY_MS)
  })

  it('「全部」范围影响所有合集的卡', async () => {
    await makeProgressedCard('M1', math.id)
    await makeProgressedCard('E1', english.id)
    const report = await resetCards(repo, { collectionId: ALL_COLLECTIONS_ID }, 'full', NOW)
    expect(report.affected).toBe(2)
    expect(await repo.listDueCards(NOW)).toHaveLength(2)
  })

  it('空范围不报错,返回 0', async () => {
    const report = await resetCards(repo, { collectionId: math.id }, 'schedule', NOW)
    expect(report.affected).toBe(0)
  })

  it('不会复活已软删的卡片', async () => {
    const card = await makeProgressedCard('M1', math.id)
    await repo.removeCard(card.id)

    const report = await resetCards(repo, { collectionId: math.id }, 'full', NOW)
    expect(report.affected).toBe(0)
    // 仍然是删除状态
    expect((await repo.getCard(card.id))!.deleted).toBe(true)
    expect(await repo.listDueCards(NOW)).toHaveLength(0)
  })

  it('重置幂等:连做两次结果一致', async () => {
    await makeProgressedCard('M1', math.id)
    await resetCards(repo, { collectionId: math.id }, 'full', NOW)
    const first = await repo.listCards()

    await resetCards(repo, { collectionId: math.id }, 'full', NOW)
    const second = await repo.listCards()

    expect(second[0]!.level).toBe(first[0]!.level)
    expect(second[0]!.reviewCount).toBe(first[0]!.reviewCount)
  })

  it('重置后卡片能正常参与后续复习', async () => {
    const card = await makeProgressedCard('M1', math.id)
    await resetCards(repo, { collectionId: math.id }, 'full', NOW)

    const due = await repo.listDueCards(NOW)
    expect(due).toHaveLength(1)

    // 模拟复习一次
    const { scheduleReview } = await import('~/lib/srs')
    await repo.putCard(scheduleReview(due[0]!, 'pass', NOW))

    const stored = await repo.getCard(card.id)
    expect(stored!.level).toBe(1)
    expect(stored!.reviewCount).toBe(1)
    expect(stored!.nextReviewAt).toBe(NOW + DAY_MS)
  })

  it('报告里带上范围标签,便于回显', async () => {
    await makeProgressedCard('M1', math.id)
    const report = await resetCards(repo, { collectionId: math.id }, 'full', NOW, '数学')
    expect(report.scopeLabel).toBe('数学')
  })
})

describe('describeReset 摘要文案', () => {
  it('有改动时说明数量与强度', () => {
    const text = describeReset({
      affected: 5,
      skipped: 0,
      mode: 'schedule',
      scopeLabel: '数学',
    })
    expect(text).toContain('只清计时')
    expect(text).toContain('数学')
    expect(text).toContain('5')
  })

  it('跳过已删除时如实说明', () => {
    const text = describeReset({ affected: 2, skipped: 1, mode: 'full', scopeLabel: '' })
    expect(text).toContain('跳过已删除 1 张')
  })

  it('没有可重置卡片时给出明确提示', () => {
    expect(describeReset({ affected: 0, skipped: 0, mode: 'full', scopeLabel: '数学' })).toContain(
      '没有可重置的卡片',
    )
  })
})
