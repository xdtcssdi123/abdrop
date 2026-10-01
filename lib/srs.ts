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
export const HOUR_MS = 60 * 60 * 1000
export const MINUTE_MS = 60 * 1000

/**
 * 经典艾宾浩斯记忆法复习间隔(毫秒):等级 N → 间隔。
 * 完整正版表:学习后 20 分钟 → 1 小时 → 9 小时 → 1 天 → 2 天 → 6 天 → 31 天。
 * 等级 0 = 新卡(录入即出现)。
 */
export const INTERVALS_MS = [
  0,
  20 * MINUTE_MS,
  1 * HOUR_MS,
  9 * HOUR_MS,
  1 * DAY_MS,
  2 * DAY_MS,
  6 * DAY_MS,
  31 * DAY_MS,
] as const

/** 等级上限。 */
export const MAX_LEVEL = 7 as const

/** Anki 默认难度因子(千分制)。 */
export const DEFAULT_EASE = 2500

/** 因子下限,防止反复遗忘后间隔塌陷到 0。 */
export const MIN_EASE = 1300

/** 遗忘时的因子惩罚。 */
export const EASE_PENALTY = 200

/** 取某个等级对应的间隔毫秒数。 */
export function intervalMsForLevel(level: MemoryLevel): number {
  const idx = Math.max(0, Math.min(level, MAX_LEVEL))
  return INTERVALS_MS[idx] as number
}

/**
 * 取某个等级对应的间隔「整天数」。
 * 分钟/小时档(第 1–3 档)不足一天返回 0 —— 仅用于 Anki ivl 近似与展示,
 * 真实调度一律走 `intervalMsForLevel`。
 */
export function intervalDaysForLevel(level: MemoryLevel): number {
  return Math.round(intervalMsForLevel(level) / DAY_MS)
}

/**
 * 由等级推导 Anki 卡片状态。
 * 等级 0 = new;1–3(当天内 20min/1h/9h)= learning;4 及以上(1d+) = review。
 */
export function stateForLevel(level: MemoryLevel): AnkiSyncState {
  if (level <= 0) return 'new'
  if (level <= 3) return 'learning'
  return 'review'
}

/**
 * 推进记忆等级。
 * 右滑(pass)  → +1,封顶 7(31 天)。
 * 左滑(fail)  → 回到 1(第 1 档:20 分钟后重走,经典记忆法"重新学习")。
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
  /** 新的连续失败计数(答对清零,答错 +1) */
  consecutiveFails: number
}

/**
 * 核心调度函数。
 *
 * @param level    当前等级
 * @param ease     当前因子(千分制)
 * @param lapses   当前遗忘次数
 * @param verdict  滑动判定
 * @param now      时间基准
 * @param consecutiveFails 当前连续失败计数(答对清零,答错 +1)
 */
export function schedule(
  level: MemoryLevel,
  ease: number,
  lapses: number,
  verdict: ReviewVerdict,
  now: number = Date.now(),
  consecutiveFails = 0,
): ScheduleResult {
  const safeEase = Number.isFinite(ease) && ease > 0 ? ease : DEFAULT_EASE
  const nextLvl = nextLevel(level, verdict)

  let nextEase = safeEase
  let nextLapses = lapses
  let syncState = stateForLevel(nextLvl)
  let nextConsecutiveFails = 0

  if (verdict === 'fail') {
    // 遗忘:因子下调,并标记为 relearning(下次答对即回 learning/review)
    nextEase = Math.max(MIN_EASE, safeEase - EASE_PENALTY)
    nextLapses = lapses + 1
    syncState = 'relearning'
    // 连续失败阶梯:答错累计;同一张卡连续错满 3 次(中途答对清零)顺延到次日
    nextConsecutiveFails = consecutiveFails + 1
  } else if (level <= 0) {
    // 新卡首次答对
    syncState = 'learning'
  } else if (level >= 4) {
    // 高阶卡继续答对,因子小幅上浮,鼓励长间隔
    nextEase = Math.min(4000, safeEase + 100)
  }

  // 答对 → 连续失败计数清零(已在上方初始化)
  if (verdict !== 'fail') nextConsecutiveFails = 0

  // 间隔:经典艾宾浩斯表按等级走毫秒;但连续错满 3 次的顽固卡顺延到次日(24h)
  const baseIntervalMs = intervalMsForLevel(nextLvl)
  const effectiveIntervalMs =
    verdict === 'fail' && nextConsecutiveFails >= 3 ? DAY_MS : baseIntervalMs

  return {
    level: nextLvl,
    // intervalDays 仅用于 Anki ivl 近似/展示;不足 1 天记 0
    intervalDays: Math.round(effectiveIntervalMs / DAY_MS),
    ease: nextEase,
    syncState,
    lapses: nextLapses,
    nextReviewAt: now + effectiveIntervalMs,
    consecutiveFails: nextConsecutiveFails,
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
  const result = schedule(
    card.level,
    card.ease,
    card.lapses,
    verdict,
    now,
    card.consecutiveFails ?? 0,
  )
  return {
    ...card,
    level: result.level,
    intervalDays: result.intervalDays,
    ease: result.ease,
    syncState: result.syncState,
    lapses: result.lapses,
    consecutiveFails: result.consecutiveFails,
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
  // 新表含当天短间隔:不足 1 天按分钟/小时描述
  if (diff < HOUR_MS) return `${Math.max(1, Math.ceil(diff / MINUTE_MS))} 分钟后`
  if (diff < DAY_MS) return `${Math.ceil(diff / HOUR_MS)} 小时后`
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
 * 导入 .apkg 时使用:把 Anki 的 ivl(整天)投影到最近的阶梯档位。
 *
 * 新表的天级档位:1天→4 级,2天→5 级,6天→6 级,31天→7 级;
 * 不足 1 天(学习卡)→ 1 级(20 分钟档重走)。
 */
export function levelFromAnki(intervalDays: number, ankiType: number): MemoryLevel {
  if (ankiType === 0 && intervalDays <= 0) return 0
  if (intervalDays <= 0) return 1
  if (intervalDays <= 1) return 4
  if (intervalDays <= 2) return 5
  if (intervalDays <= 6) return 6
  return 7
}
