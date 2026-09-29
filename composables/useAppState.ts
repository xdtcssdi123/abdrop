/**
 * 应用级状态(合集 / 首选项)。
 *
 * 选择轻量 composable 而非 Pinia:状态面很小,少一层依赖少一份复杂度。
 * 用 `useState` 保证 SSR 关闭后依然单例。
 */

import { computed } from 'vue'
// 从 '#imports' 显式导入 Nuxt 内置,而非依赖全局注入 ——
// 这样单测环境(见 tests/stubs/nuxt-imports.ts)能跑到同一份代码
import { useState } from '#imports'
import { DEFAULT_COLLECTION_ID, DEFAULT_COLLECTION_NAME, useCardRepository } from '~/lib/db'
import { ALL_COLLECTIONS_ID } from '~/lib/db-constants'
import type { AIConfig, Collection, KnowledgeCard } from '~/types'
import { DEFAULT_AI_CONFIG } from '~/lib/ai'

const AI_CONFIG_KEY = 'abdrop.ai.config'
const ACTIVE_COLLECTION_KEY = 'abdrop.activeCollection'

/** 合集列表 + 当前选中合集。 */
export function useCollections() {
  const collections = useState<Collection[]>('abdrop.collections', () => [])
  /**
   * 当前复习范围。
   *
   * 默认「全部」—— 首次打开就能看到所有到期的卡,不会误以为 App 是空的。
   * 用户选定具体合集后,首页严格只刷那一个合集。
   */
  const activeCollectionId = useState<string>(
    'abdrop.activeCollectionId',
    () => ALL_COLLECTIONS_ID,
  )

  const repo = () => useCardRepository()

  async function refresh(): Promise<void> {
    collections.value = await repo().listCollections()
    // 选中的合集若已被删,回落到「全部」—— 保证池子不会为空
    const stillExists = collections.value.some((c) => c.id === activeCollectionId.value)
    if (!stillExists && activeCollectionId.value !== ALL_COLLECTIONS_ID) {
      activeCollectionId.value = ALL_COLLECTIONS_ID
    }
  }

  async function create(name: string): Promise<Collection> {
    const col = await repo().createCollection(name)
    await refresh()
    return col
  }

  async function rename(id: string, name: string): Promise<void> {
    await repo().renameCollection(id, name)
    await refresh()
  }

  async function remove(id: string): Promise<void> {
    await repo().removeCollection(id)
    await refresh()
  }

  function select(id: string): void {
    activeCollectionId.value = id
    persistActiveCollection(id)
  }

  /** 当前范围的显示信息(「全部」不在 collections 里,单独给出)。 */
  const activeCollection = computed(() => {
    if (activeCollectionId.value === ALL_COLLECTIONS_ID) {
      return { id: ALL_COLLECTIONS_ID, name: '全部', order: -1, createdAt: 0 }
    }
    return (
      collections.value.find((c) => c.id === activeCollectionId.value) ?? {
        id: DEFAULT_COLLECTION_ID,
        name: DEFAULT_COLLECTION_NAME,
        order: 0,
        createdAt: 0,
      }
    )
  })

  return {
    collections,
    activeCollectionId,
    activeCollection,
    refresh,
    create,
    rename,
    remove,
    select,
  }
}

// ── 本地偏好(跨端兼容:Capacitor Preferences 优先,降级 localStorage) ──
function persistActiveCollection(id: string): void {
  void setStoredValue(ACTIVE_COLLECTION_KEY, id)
}

/** 读取持久化字符串。 */
export async function getStoredValue(key: string): Promise<string | null> {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 写入持久化字符串。 */
export async function setStoredValue(key: string, value: string): Promise<void> {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下写入失败,静默忽略 */
  }
}

/** AI 配置读写。 */
export function useAIConfigState() {
  const aiConfig = useState<AIConfig>('abdrop.aiConfig', () => ({ ...DEFAULT_AI_CONFIG }))

  async function load(): Promise<void> {
    const raw = await getStoredValue(AI_CONFIG_KEY)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as Partial<AIConfig>
      aiConfig.value = { ...DEFAULT_AI_CONFIG, ...parsed }
    } catch {
      /* 配置损坏则用默认值,不阻塞启动 */
    }
  }

  async function save(next: Partial<AIConfig>): Promise<void> {
    aiConfig.value = { ...aiConfig.value, ...next }
    await setStoredValue(AI_CONFIG_KEY, JSON.stringify(aiConfig.value))
  }

  return { aiConfig, load, save }
}
