/**
 * 调度引擎测试 —— 这是产品的"大脑",覆盖必须最厚。
 */
import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  DEFAULT_EASE,
  INTERVALS_DAYS,
  MAX_LEVEL,
  computeNextReviewAt,
  describeDue,
  intervalDaysForLevel,
  isDue,
  levelFromAnki,
  memoryStrength,
  nextLevel,
  schedule,
  scheduleReview,
  selectDueCards,
  stateForLevel,
  syncStateLabel,
} from '~/lib/srs'
import type { KnowledgeCard, MemoryLevel } from '~/types'

/** 造一条测试卡片的便捷工厂。 */
function makeCard(over: Partial<KnowledgeCard> = {}): KnowledgeCard {
  return {
    id: 'c1',
    front: 'Q',
    back: 'A',
    sourceText: 'Q',
    collectionId: 'inbox',
    tags: [],
    modelName: '',
    level: 0,
    intervalDays: 0,
    ease: DEFAULT_EASE,
    syncState: 'new',
    lapses: 0,
    createdAt: 0,
    nextReviewAt: 0,
    lastReviewedAt: 0,
    reviewCount: 0,
    passCount: 0,
    failCount: 0,
    imageUri: '',
    ankiNoteId: '',
    backEdited: false,
    deleted: false,
    updatedAt: 0,
    ...over,
  }
}

describe('艾宾浩斯间隔阶梯', () => {
  it('等级 0 表示新卡,间隔为 0 天', () => {
    expect(intervalDaysForLevel(0)).toBe(0)
  })

  it('等级 1–5 严格对应 1、2、4、7、15 天', () => {
    expect([1, 2, 3, 4, 5].map((l) => intervalDaysForLevel(l as MemoryLevel))).toEqual([
      1, 2, 4, 7, 15,
    ])
  })

  it('阶梯常量本身即产品约定的 1,2,4,7,15', () => {
    expect(INTERVALS_DAYS.slice(1)).toEqual([1, 2, 4, 7, 15])
  })

  it('超出上限的等级被夹到 15 天,不越界', () => {
    expect(intervalDaysForLevel(99 as MemoryLevel)).toBe(15)
  })

  it('负等级按新卡处理', () => {
    expect(intervalDaysForLevel(-3 as MemoryLevel)).toBe(0)
  })
})

describe('等级推进', () => {
  it('右滑逐级上升', () => {
    expect(nextLevel(0, 'pass')).toBe(1)
    expect(nextLevel(3, 'pass')).toBe(4)
  })

  it('右滑在 5 级封顶', () => {
    expect(nextLevel(MAX_LEVEL, 'pass')).toBe(5)
  })

  it('左滑退回等级 1,而不是清零到 0', () => {
    // 清零会导致刚复习过的卡立刻又刷屏,这是刻意的产品决策
    expect(nextLevel(5, 'fail')).toBe(1)
    expect(nextLevel(0, 'fail')).toBe(1)
  })
})

describe('schedule —— 完整调度结果', () => {
  const now = 1_700_000_000_000

  it('新卡答对 → 等级 1、间隔 1 天、状态 learning', () => {
    const r = schedule(0, DEFAULT_EASE, 0, 'pass', now)
    expect(r.level).toBe(1)
    expect(r.intervalDays).toBe(1)
    expect(r.syncState).toBe('learning')
    expect(r.nextReviewAt).toBe(now + DAY_MS)
  })

  it('答错 → 等级回 1、lapses+1、状态 relearning、因子下调', () => {
    const r = schedule(4, 2600, 2, 'fail', now)
    expect(r.level).toBe(1)
    expect(r.lapses).toBe(3)
    expect(r.syncState).toBe('relearning')
    expect(r.ease).toBe(2400)
  })

  it('反复答错时因子有下限,不会塌到 0', () => {
    let ease = DEFAULT_EASE
    for (let i = 0; i < 20; i++) ease = schedule(3, ease, 0, 'fail', now).ease
    expect(ease).toBe(1300)
  })

  it('高阶卡继续答对时因子小幅上浮,但封顶 4000', () => {
    let ease = DEFAULT_EASE
    for (let i = 0; i < 50; i++) ease = schedule(5, ease, 0, 'pass', now).ease
    expect(ease).toBe(4000)
  })

  it('ease 传入非法值时回落到默认值', () => {
    expect(schedule(1, Number.NaN, 0, 'pass', now).ease).toBe(DEFAULT_EASE)
    expect(schedule(1, 0, 0, 'pass', now).ease).toBe(DEFAULT_EASE)
  })
})

describe('scheduleReview —— 卡片级调度', () => {
  const now = 1_700_000_000_000

  it('返回新对象,不修改入参(纯函数契约)', () => {
    const card = makeCard({ level: 2, reviewCount: 5 })
    const next = scheduleReview(card, 'pass', now)
    expect(next).not.toBe(card)
    expect(card.level).toBe(2)
    expect(card.reviewCount).toBe(5)
    expect(next.level).toBe(3)
  })

  it('答对累计 passCount,答错累计 failCount', () => {
    const card = makeCard()
    const p = scheduleReview(card, 'pass', now)
    expect(p.passCount).toBe(1)
    expect(p.failCount).toBe(0)

    const f = scheduleReview(card, 'fail', now)
    expect(f.failCount).toBe(1)
    expect(f.passCount).toBe(0)
  })

  it('每次复习都推进 reviewCount 与 lastReviewedAt', () => {
    const next = scheduleReview(makeCard(), 'pass', now)
    expect(next.reviewCount).toBe(1)
    expect(next.lastReviewedAt).toBe(now)
    expect(next.updatedAt).toBe(now)
  })

  it('连续答对 5 次后间隔收敛到 15 天', () => {
    let card = makeCard({ level: 0 })
    for (let i = 0; i < 5; i++) card = scheduleReview(card, 'pass', now)
    expect(card.level).toBe(5)
    expect(card.intervalDays).toBe(15)
    expect(card.nextReviewAt).toBe(now + 15 * DAY_MS)
  })
})

describe('到期判定与卡片池', () => {
  const now = 1_700_000_000_000

  it('nextReviewAt 已过即到期', () => {
    expect(isDue(makeCard({ nextReviewAt: now - 1 }), now)).toBe(true)
    expect(isDue(makeCard({ nextReviewAt: now }), now)).toBe(true)
    expect(isDue(makeCard({ nextReviewAt: now + 1 }), now)).toBe(false)
  })

  it('已软删的卡片永不到期', () => {
    expect(isDue(makeCard({ nextReviewAt: 0, deleted: true }), now)).toBe(false)
  })

  it('只挑到期卡片,未到期的不进池', () => {
    const cards = [
      makeCard({ id: 'a', nextReviewAt: now - 100 }),
      makeCard({ id: 'b', nextReviewAt: now + DAY_MS }),
      makeCard({ id: 'c', nextReviewAt: now - 50 }),
    ]
    const due = selectDueCards(cards, now)
    expect(due.map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('逾期越久越靠前', () => {
    const cards = [
      makeCard({ id: 'recent', nextReviewAt: now - DAY_MS }),
      makeCard({ id: 'old', nextReviewAt: now - 10 * DAY_MS }),
    ]
    expect(selectDueCards(cards, now)[0]!.id).toBe('old')
  })

  it('同等逾期时等级低的优先(先巩固弱的)', () => {
    const cards = [
      makeCard({ id: 'high', nextReviewAt: now - DAY_MS, level: 4 }),
      makeCard({ id: 'low', nextReviewAt: now - DAY_MS, level: 1 }),
    ]
    expect(selectDueCards(cards, now)[0]!.id).toBe('low')
  })

  it('完全相同时按录入时间 FIFO,保证排序稳定', () => {
    const cards = [
      makeCard({ id: 'second', nextReviewAt: now, level: 1, createdAt: 200 }),
      makeCard({ id: 'first', nextReviewAt: now, level: 1, createdAt: 100 }),
    ]
    expect(selectDueCards(cards, now).map((c) => c.id)).toEqual(['first', 'second'])
  })

  it('不修改输入数组', () => {
    const cards = [makeCard({ id: 'x', nextReviewAt: now - 1 })]
    const snapshot = [...cards]
    selectDueCards(cards, now)
    expect(cards).toEqual(snapshot)
  })
})

describe('派生展示信息', () => {
  const now = 1_700_000_000_000

  it('describeDue 区分待复习 / 逾期 / 未来', () => {
    expect(describeDue(makeCard({ nextReviewAt: now - 1000 }), now)).toBe('待复习')
    expect(describeDue(makeCard({ nextReviewAt: now - 3 * DAY_MS }), now)).toBe('逾期 3 天')
    expect(describeDue(makeCard({ nextReviewAt: now + 2 * DAY_MS }), now)).toBe('2 天后')
  })

  it('memoryStrength 从 0 线性升到 1', () => {
    expect(memoryStrength(0)).toBe(0)
    expect(memoryStrength(5)).toBe(1)
    expect(memoryStrength(3)).toBeCloseTo(0.6)
  })

  it('stateForLevel 映射到 Anki 状态', () => {
    expect(stateForLevel(0)).toBe('new')
    expect(stateForLevel(1)).toBe('learning')
    expect(stateForLevel(2)).toBe('learning')
    expect(stateForLevel(3)).toBe('review')
    expect(stateForLevel(5)).toBe('review')
  })

  it('syncStateLabel 有中文文案', () => {
    expect(syncStateLabel('new')).toBe('新卡')
    expect(syncStateLabel('relearning')).toBe('重学中')
  })
})

describe('Anki 间隔反推等级', () => {
  it('新卡(type=0 且间隔 0)判为等级 0', () => {
    expect(levelFromAnki(0, 0)).toBe(0)
  })

  it('按间隔投影到最近的阶梯档位', () => {
    expect(levelFromAnki(1, 2)).toBe(1)
    expect(levelFromAnki(2, 2)).toBe(2)
    expect(levelFromAnki(4, 2)).toBe(3)
    expect(levelFromAnki(7, 2)).toBe(4)
    expect(levelFromAnki(30, 2)).toBe(5)
  })

  it('间隔为 0 但非新卡时至少给到等级 1', () => {
    expect(levelFromAnki(0, 2)).toBe(1)
  })
})

describe('computeNextReviewAt', () => {
  it('等级 0 时等于基准时间本身(立刻可见)', () => {
    const now = 123456
    expect(computeNextReviewAt(0, now)).toBe(now)
  })

  it('等级 3 时是基准 + 4 天', () => {
    const now = 123456
    expect(computeNextReviewAt(3, now)).toBe(now + 4 * DAY_MS)
  })
})
