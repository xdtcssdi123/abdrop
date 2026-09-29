/**
 * 复习流程服务 —— 把「滑动 → 调度 → 落库 → 出队」这条主干收在一个
 * 不依赖任何框架上下文的工厂里,因此可以被完整单测覆盖。
 */

import type { CardRepository } from '~/lib/db'
import { createCard, DEFAULT_COLLECTION_ID } from '~/lib/db'
import { ALL_COLLECTIONS_ID, isAllScope } from '~/lib/db-constants'
import { scheduleReview, selectDueCards } from '~/lib/srs'
import type { KnowledgeCard, NewCardInput, ReviewVerdict } from '~/types'

export interface ReviewService {
  /**
   * 拉取首页卡片池。
   *
   * @param collectionId 复习范围:
   *   - `ALL_COLLECTIONS_ID` → 跨全部合集
   *   - 其他(含 `inbox`)   → **只**该合集的卡
   */
  loadPool(collectionId?: string, now?: number): Promise<KnowledgeCard[]>
  /** 新增知识卡。 */
  addCard(input: NewCardInput, now?: number): Promise<KnowledgeCard>
  /** 记一次复习结果,回写调度后的卡片。 */
  commitReview(card: KnowledgeCard, verdict: ReviewVerdict, now?: number): Promise<KnowledgeCard>
  /** 就地编辑卡片(如手动修正 AI 归纳)。 */
  patchCard(id: string, patch: Partial<KnowledgeCard>, now?: number): Promise<KnowledgeCard | null>
  /** 软删除。 */
  deleteCard(id: string): Promise<void>
}

export function createReviewService(repo: CardRepository): ReviewService {
  return {
    async loadPool(collectionId = ALL_COLLECTIONS_ID, now = Date.now()) {
      const due = await repo.listDueCards(now)
      // 「全部」才跨合集;其余一律严格按合集过滤 —— 包括「未分类」
      if (isAllScope(collectionId)) return due
      return due.filter((c) => c.collectionId === collectionId)
    },

    async addCard(input, now = Date.now()) {
      return repo.addCard(input, now)
    },

    async commitReview(card, verdict, now = Date.now()) {
      const next = scheduleReview(card, verdict, now)
      await repo.putCard(next)
      return next
    },

    async patchCard(id, patch, now = Date.now()) {
      const existing = await repo.getCard(id)
      if (!existing) return null
      const merged: KnowledgeCard = {
        ...existing,
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now,
      }
      await repo.putCard(merged)
      return merged
    },

    async deleteCard(id) {
      await repo.removeCard(id)
    },
  }
}

/** 纯函数:把一张卡片从队列中移除,返回新队列。 */
export function popCard(pool: readonly KnowledgeCard[], id: string): KnowledgeCard[] {
  return pool.filter((c) => c.id !== id)
}

/** 纯函数:重新计算队列(复习后未到期的不再出现)。 */
export function recomputePool(
  pool: readonly KnowledgeCard[],
  now: number = Date.now(),
): KnowledgeCard[] {
  return selectDueCards(pool, now)
}

export { createCard }
