/**
 * 管理员操作 —— 破坏性 / 高权限功能。
 *
 * 与 `lib/review-service.ts` 的区别:那里是**日常**复习流程,
 * 这里是**一次性维护**操作(重置进度、批量清理)。
 * 单独成模块的原因:这些函数会不可逆地改写调度数据,
 * 集中放置便于审查、测试与限制调用点。
 *
 * 所有核心变换都是纯函数(`resetCard`),仓储调用只做编排。
 */

import type { CardRepository } from '~/lib/db'
import { DEFAULT_EASE, intervalDaysForLevel, stateForLevel } from '~/lib/srs'
import { ALL_COLLECTIONS_ID, isAllScope } from '~/lib/db-constants'
import type { KnowledgeCard } from '~/types'

/**
 * 重置强度。
 *
 * - `schedule` —— **只清计时**:卡片立刻到期,但保留记忆等级与复习统计。
 *                  适合"最近没空复习,把积压的都拉回来"。
 * - `full`     —— **完全重来**:等级归零、间隔归零、统计清空、难度因子复位。
 *                  卡片回到刚录入的状态,适合"之前记乱了,从头再来"。
 */
export type ResetMode = 'schedule' | 'full'

/** 重置范围。 */
export interface ResetScope {
  /** 合集 id;`ALL_COLLECTIONS_ID` 表示全部合集 */
  collectionId: string
}

/** 重置结果报告。 */
export interface ResetReport {
  /** 实际改动的卡片数 */
  affected: number
  /** 范围内被跳过的卡片数(已删除的) */
  skipped: number
  mode: ResetMode
  /** 范围描述,用于回显给用户 */
  scopeLabel: string
}

/**
 * 对单张卡片执行重置(**纯函数,不修改入参**)。
 *
 * @param card 原卡片
 * @param mode 重置强度
 * @param now  时间基准;重置后 `nextReviewAt = now` → 立刻出现在首页
 */
export function resetCard(
  card: KnowledgeCard,
  mode: ResetMode,
  now: number = Date.now(),
): KnowledgeCard {
  if (mode === 'schedule') {
    // 只把计时清零:其余进度原样保留
    return {
      ...card,
      nextReviewAt: now,
      updatedAt: now,
    }
  }

  // full:回到"刚录入"的状态
  return {
    ...card,
    level: 0,
    intervalDays: intervalDaysForLevel(0),
    ease: DEFAULT_EASE,
    syncState: stateForLevel(0),
    lapses: 0,
    nextReviewAt: now,
    lastReviewedAt: 0,
    reviewCount: 0,
    passCount: 0,
    failCount: 0,
    consecutiveFails: 0,
    updatedAt: now,
  }
}

/** 判断卡片是否在重置范围内。 */
export function inScope(card: KnowledgeCard, scope: ResetScope): boolean {
  if (isAllScope(scope.collectionId)) return true
  return card.collectionId === scope.collectionId
}

/**
 * 批量重置。
 *
 * 只处理**未删除**的卡片;已软删的会被计入 `skipped`,
 * 因为对它们重置毫无意义,用户也应知道有卡片被跳过。
 *
 * @param repo  仓储
 * @param scope 范围
 * @param mode  重置强度
 * @param now   时间基准
 * @param scopeLabel 范围的可读描述(用于报告回显)
 */
export async function resetCards(
  repo: CardRepository,
  scope: ResetScope,
  mode: ResetMode,
  now: number = Date.now(),
  scopeLabel = '',
): Promise<ResetReport> {
  const all = await repo.listCards()

  const targets = all.filter((c) => inScope(c, scope))
  const skipped = all.length - targets.length

  if (targets.length === 0) {
    return { affected: 0, skipped, mode, scopeLabel }
  }

  const updated = targets.map((c) => resetCard(c, mode, now))
  const affected = await repo.addCards(updated)

  return { affected, skipped, mode, scopeLabel }
}

/**
 * 预览:重置会影响多少张卡片(用于确认弹窗,避免"点了才知道")。
 *
 * `now` 可注入 —— 与项目其他模块保持一致,便于测试。
 */
export async function previewReset(
  repo: CardRepository,
  scope: ResetScope,
  now: number = Date.now(),
): Promise<{ total: number; due: number; scheduled: number }> {
  const all = await repo.listCards()
  const targets = all.filter((c) => inScope(c, scope))
  return {
    total: targets.length,
    // 已经到期的不受影响
    due: targets.filter((c) => c.nextReviewAt <= now).length,
    // 有未来计时的才是真正"被清掉计时"的
    scheduled: targets.filter((c) => c.nextReviewAt > now).length,
  }
}

/** 重置强度的可读说明,UI 直接消费,避免文案散落。 */
export const RESET_MODE_INFO: Record<
  ResetMode,
  { label: string; description: string; destructive: boolean }
> = {
  schedule: {
    label: '只清计时',
    description: '所有卡片立刻到期,下次打开就能复习。记忆等级与复习次数保持不变。',
    destructive: false,
  },
  full: {
    label: '完全重新开始',
    description:
      '记忆等级归零、间隔清零、复习次数与遗忘次数全部清空,难度因子复位。卡片内容不动,但记忆进度从头开始。',
    destructive: true,
  },
}

/** 摘要文案:把报告转成一句人话。 */
export function describeReset(report: ResetReport): string {
  if (report.affected === 0) {
    return report.scopeLabel ? `「${report.scopeLabel}」没有可重置的卡片` : '没有可重置的卡片'
  }
  const modeText = RESET_MODE_INFO[report.mode].label
  const scopeText = report.scopeLabel ? `「${report.scopeLabel}」的` : ''
  return `已${modeText}:${scopeText}${report.affected} 张卡片${
    report.skipped > 0 ? `(跳过已删除 ${report.skipped} 张)` : ''
  }`
}
