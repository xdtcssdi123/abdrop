/**
 * 数据层常量 —— 单独成文件,避免 `db.ts` ↔ `anki-map.ts` 的循环引用。
 */

export const DB_NAME = 'abdrop'
export const DB_VERSION = 2
export const STORE_CARDS = 'cards'
export const STORE_COLLECTIONS = 'collections'

/** 未分类合集的固定 id。它是一个**真实合集**,不是"全部"。 */
export const DEFAULT_COLLECTION_ID = 'inbox'

export const DEFAULT_COLLECTION_NAME = '未分类'

/**
 * 「全部合集」虚拟 id。
 *
 * 它不对应任何真实 Collection 记录,只用于复习范围选择。
 * 与 `DEFAULT_COLLECTION_ID` 严格区分:
 *   - `inbox`      → 只复习「未分类」这一个合集的卡
 *   - `__all__`    → 跨全部合集复习
 *
 * 这两者混同曾是设计缺陷:选「未分类」会刷出所有合集的卡,
 * 导致「未分类」这个合集反而无法被单独复习。
 */
export const ALL_COLLECTIONS_ID = '__all__'

/** 「全部」在 UI 上的显示名。 */
export const ALL_COLLECTIONS_NAME = '全部'

/** 是否为「全部合集」范围。 */
export function isAllScope(collectionId: string): boolean {
  return collectionId === ALL_COLLECTIONS_ID
}
