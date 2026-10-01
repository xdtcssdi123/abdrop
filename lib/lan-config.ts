/**
 * 局域网配置读取 —— 直接从持久化存储(localStorage)读软件真实配置。
 *
 * 为什么需要绕过内存 state:
 * useAppState / useCheckinState 的 useState 初始值都是默认配置,
 * 只有设置页 onMounted 调用 load() 后内存里才有真实值;
 * activeCollectionId 更是从不从 localStorage 恢复(初始化固定 'all')。
 * 网页请求到达时 App 可能处于"从未进过设置页"的状态,
 * 因此读内存会拿到默认值 —— 必须直接读落盘的 localStorage。
 *
 * 纯函数,零框架依赖,可单测。
 */
import type { AIConfig } from '~/types'
import type { CheckinConfig } from '~/lib/checkin'
import { DEFAULT_AI_CONFIG } from '~/lib/ai'
import { DEFAULT_CHECKIN_CONFIG } from '~/lib/checkin'
import { ALL_COLLECTIONS_ID } from '~/lib/db-constants'

export const AI_CONFIG_KEY = 'abdrop.ai.config'
export const ACTIVE_COLLECTION_KEY = 'abdrop.activeCollection'
export const CHECKIN_CONFIG_KEY = 'abdrop.checkin.config'

/** 同步读 localStorage,窗口不存在或读取失败返回 null。 */
export function readStored(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 读 AI 配置;无记录或损坏时回退默认配置。 */
export function readAIConfigFromStorage(): AIConfig {
  const raw = readStored(AI_CONFIG_KEY)
  if (!raw) return { ...DEFAULT_AI_CONFIG }
  try {
    return { ...DEFAULT_AI_CONFIG, ...(JSON.parse(raw) as Partial<AIConfig>) }
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

/** 读当前复习范围;无记录时回退「全部」。 */
export function readActiveCollectionFromStorage(): string {
  return readStored(ACTIVE_COLLECTION_KEY) || ALL_COLLECTIONS_ID
}

/** 读打卡配置;无记录或损坏时回退默认配置。 */
export function readCheckinConfigFromStorage(): CheckinConfig {
  const raw = readStored(CHECKIN_CONFIG_KEY)
  if (!raw) return { ...DEFAULT_CHECKIN_CONFIG }
  try {
    return { ...DEFAULT_CHECKIN_CONFIG, ...(JSON.parse(raw) as Partial<CheckinConfig>) }
  } catch {
    return { ...DEFAULT_CHECKIN_CONFIG }
  }
}