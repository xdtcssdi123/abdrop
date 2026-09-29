/**
 * 调度引擎 —— Ebbinghaus 阶梯 × Anki 字段双轨。
 *
 * 设计取舍:
 *   - 产品要的是「1、2、4、7、15 天」这条确定阶梯,所以间隔由 `level` 决定,
 *     行为可预测、可解释(用户看得懂为什么明天又出现)。
 *   - 同时把 Anki 的 `ivl` / `factor` / `type` / `lapses` 全部算出来并持久化,
 *     保证 .apkg 导入的卡不丢调度信息、导出回 Anki 也合理。
 *
 * 纯函数、零依赖、时间可注入 —— 全部可单测。
 */

import type {
  AnkiSyncState,
  KnowledgeCard,
  MemoryLevel,
  ReviewVerdict,
} from '~/types'

export const DAY_MS = 24 * 60 * 60 * 1000

/** Ebbinghaus 阶梯间隔(天):等级 N → 间隔。 */
export const INTERVALS_DAYS = [0, 1, 2, 4, 7, 15] as const

/** 等级上限。 */
export const MAX_LEVEL = 5 as const

/** Anki 默认难度因子(千分制)。 */
export const DEFAULT_EASE = 2500

/** 因子下限,防止反复遗忘后间隔塌陷到 0。 */
export const MIN_EASE = 1300

/** 遗忘时的因子惩罚。 */
export const EASE_PENALTY = 200

/** 取某个等级对应的间隔天数。 */
export function intervalDaysForLevel(level: MemoryLevel): number {
  const idx = Math.max(0, Math.min(level, MAX_LEVEL))
  return INTERVALS_DAYS[idx] as number
}

/** 取某个等级对应的间隔毫秒数。 */
export function intervalMsForLevel(level: MemoryLevel): number {
  return intervalDaysForLevel(level) * DAY_MS
}

/**
 * 由等级推导 Anki 卡片状态。
 * 等级 0 = new;1–2 = learning;3 及以上 = review。
 */
export function stateForLevel(level: MemoryLevel): AnkiSyncState {
  if (level <= 0) return 'new'
  if (level <= 2) return 'learning'
  return 'review'
}

/**
 * 推进记忆等级。
 * 右滑(pass)  → +1,封顶 5。
 * 左滑(fail)  → 回到 1(重走阶梯,而不是清零到 new,
 *                避免刚复习完的卡立刻又刷屏)。
 */
export function nextLevel(current: MemoryLevel, verdict: ReviewVerdict): MemoryLevel {
  if (verdict === 'pass') return Math.min(current + 1, MAX_LEVEL) as MemoryLevel
  return 1 as MemoryLevel
}

/** 计算下次复习时间戳。 */
export function computeNextReviewAt(level: MemoryLevel, from: number = Date.now()): number {
  return from + intervalMsForLevel(level)
}

/**
 * 一次复习的完整调度结果(不依赖卡片对象,便于单测)。
 */
export interface ScheduleResult {
  level: MemoryLevel
  intervalDays: number
  ease: number
  syncState: AnkiSyncState
  lapses: number
  nextReviewAt: number
}

/**
 * 核心调度函数。
 *
 * @param level    当前等级
 * @param ease     当前因子(千分制)
 * @param lapses   当前遗忘次数
 * @param verdict  滑动判定
 * @param now      时间基准
 */
export function schedule(
  level: MemoryLevel,
  ease: number,
  lapses: number,
  verdict: ReviewVerdict,
  now: number = Date.now(),
): ScheduleResult {
  const safeEase = Number.isFinite(ease) && ease > 0 ? ease : DEFAULT_EASE
  const nextLvl = nextLevel(level, verdict)
  const intervalDays = intervalDaysForLevel(nextLvl)

  let nextEase = safeEase
  let nextLapses = lapses
  let syncState = stateForLevel(nextLvl)

  if (verdict === 'fail') {
    // 遗忘:因子下调,并标记为 relearning(下次答对即回 learning/review)
    nextEase = Math.max(MIN_EASE, safeEase - EASE_PENALTY)
    nextLapses = lapses + 1
    syncState = 'relearning'
  } else if (level <= 0) {
    // 新卡首次答对
    syncState = 'learning'
  } else if (level >= 4) {
    // 高阶卡继续答对,因子小幅上浮,鼓励长间隔
    nextEase = Math.min(4000, safeEase + 100)
  }

  return {
    level: nextLvl,
    intervalDays,
    ease: nextEase,
    syncState,
    lapses: nextLapses,
    nextReviewAt: now + intervalDays * DAY_MS,
  }
}

/**
 * 对一条卡片执行一次复习调度,返回**新对象**(不修改入参)。
 */
export function scheduleReview(
  card: KnowledgeCard,
  verdict: ReviewVerdict,
  now: number = Date.now(),
): KnowledgeCard {
  const result = schedule(card.level, card.ease, card.lapses, verdict, now)
  return {
    ...card,
    level: result.level,
    intervalDays: result.intervalDays,
    ease: result.ease,
    syncState: result.syncState,
    lapses: result.lapses,
    nextReviewAt: result.nextReviewAt,
    lastReviewedAt: now,
    reviewCount: card.reviewCount + 1,
    passCount: card.passCount + (verdict === 'pass' ? 1 : 0),
    failCount: card.failCount + (verdict === 'fail' ? 1 : 0),
    updatedAt: now,
  }
}

/** 卡片是否到期(首页「只拉到期和新录入」的判定核心)。 */
export function isDue(card: KnowledgeCard, now: number = Date.now()): boolean {
  return !card.deleted && card.nextReviewAt <= now
}

/**
 * 首页卡片池筛选与排序。
 * 优先级:逾期越久越靠前 → 等级低者优先(先巩固弱的)→ 先录入者优先(FIFO 稳定)。
 */
export function selectDueCards(
  cards: readonly KnowledgeCard[],
  now: number = Date.now(),
): KnowledgeCard[] {
  return cards
    .filter((c) => isDue(c, now))
    .slice()
    .sort((a, b) => {
      const overdueA = now - a.nextReviewAt
      const overdueB = now - b.nextReviewAt
      if (overdueA !== overdueB) return overdueB - overdueA
      if (a.level !== b.level) return a.level - b.level
      return a.createdAt - b.createdAt
    })
}

/** 人类可读的到期描述,卡片角标用。 */
export function describeDue(card: KnowledgeCard, now: number = Date.now()): string {
  const diff = card.nextReviewAt - now
  if (diff <= 0) {
    const overdueDays = Math.floor(-diff / DAY_MS)
    if (overdueDays <= 0) return '待复习'
    return `逾期 ${overdueDays} 天`
  }
  const days = Math.ceil(diff / DAY_MS)
  return `${days} 天后`
}

/** 记忆强度 0–1,卡片顶部细进度条用。 */
export function memoryStrength(level: MemoryLevel): number {
  if (level <= 0) return 0
  return Math.min(level / MAX_LEVEL, 1)
}

/** Anki 状态的中文标签。 */
export function syncStateLabel(state: AnkiSyncState): string {
  switch (state) {
    case 'new':
      return '新卡'
    case 'learning':
      return '学习中'
    case 'review':
      return '复习中'
    case 'relearning':
      return '重学中'
  }
}

/**
 * 从 Anki 的调度字段反推 Ebbinghaus 等级。
 * 导入 .apkg 时使用:把 Anki 的 ivl/type 投影到最近的阶梯档位。
 */
export function levelFromAnki(intervalDays: number, ankiType: number): MemoryLevel {
  if (ankiType === 0 && intervalDays <= 0) return 0
  if (intervalDays <= 1) return 1
  if (intervalDays <= 2) return 2
  if (intervalDays <= 4) return 3
  if (intervalDays <= 7) return 4
  return 5
}
