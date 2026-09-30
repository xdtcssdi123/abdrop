/**
 * 全局类型定义 —— 全项目唯一的领域模型出口。
 *
 * 模型对齐原则:**与 Anki 笔记 1:1 对应**。
 *   Anki Note.flds[0] → front   (正面/问题)
 *   Anki Note.flds[1] → back    (背面/答案)
 *   Anki Note.tags     → tags
 *   Anki Card.ivl      → intervalDays
 *   Anki Card.factor   → ease
 *   Anki Card.type     → syncState
 * 这样 `.apkg` 导入、TSV 导入、导出回 Anki 三向都不丢信息。
 */

/** Ebbinghaus 记忆阶梯等级。 */
export type MemoryLevel = 0 | 1 | 2 | 3 | 4 | 5

/** Anki 卡片状态(与 Anki `cards.type` 语义一致)。 */
export type AnkiSyncState = 'new' | 'learning' | 'review' | 'relearning'

/**
 * 一条知识卡片。
 * 字段与 IndexedDB objectStore 一一对应。
 */
export interface KnowledgeCard {
  /** 主键,`crypto.randomUUID()` */
  id: string

  // ── 内容(Anki 字段) ─────────────────────────────────────
  /** 正面:问题 / 知识点标题 */
  front: string
  /** 背面:答案 / 解释 */
  back: string
  /** 原始录入文本(手输原文或拍照识别结果);AI 归纳的输入源 */
  sourceText: string

  // ── 组织 ────────────────────────────────────────────────
  /** 所属合集 id;`DEFAULT_COLLECTION_ID` 为「未分类」 */
  collectionId: string
  /** Anki 标签 */
  tags: string[]
  /** 来源笔记模板名(Anki 导入时保留) */
  modelName: string

  // ── 调度 ────────────────────────────────────────────────
  /** Ebbinghaus 阶梯等级 0–5,决定间隔 */
  level: MemoryLevel
  /** 当前间隔天数(Anki `ivl` 对应字段) */
  intervalDays: number
  /** 难度因子,千分制(Anki `factor`,默认 2500 = 2.5) */
  ease: number
  /** 卡片状态 */
  syncState: AnkiSyncState
  /** 累计遗忘次数(Anki `lapses`) */
  lapses: number

  /** 首次录入时间戳(ms) */
  createdAt: number
  /** 下次复习时间戳(ms);<= now 即到期 */
  nextReviewAt: number
  /** 最近一次复习时间戳(ms),未复习过为 0 */
  lastReviewedAt: number
  /** 累计复习次数 */
  reviewCount: number
  /** 累计「已掌握」右滑次数 */
  passCount: number
  /** 累计「待复习」左滑次数 */
  failCount: number

  // ── 媒体与溯源 ──────────────────────────────────────────
  /** 图片本地路径或 dataURL(base64),无图为空串 */
  imageUri: string
  /** Anki 笔记 id(导入来源),自建卡片为空串 */
  ankiNoteId: string
  /** 用户是否手动编辑过 AI 归纳结果(阻止再次覆盖) */
  backEdited: boolean
  /** 软删除标记 */
  deleted: boolean
  /** 最后更新时间戳(ms) */
  updatedAt: number
}

/** 新建卡片时的输入载荷(其余字段由工厂补齐)。 */
export interface NewCardInput {
  front: string
  back?: string
  sourceText?: string
  collectionId?: string
  tags?: string[]
  imageUri?: string
  modelName?: string
  ankiNoteId?: string
}

/** 合集。 */
export interface Collection {
  id: string
  name: string
  /** 排序权重,小的在前 */
  order: number
  createdAt: number
}

/** 左滑/右滑的判定结果。 */
export type ReviewVerdict = 'pass' | 'fail'

/** 首页卡片池的筛选模式。 */
export type CardPoolMode = 'due' | 'all'

/** AI 服务商预设。 */
export type AIProvider = 'openai' | 'anthropic' | 'deepseek' | 'custom'

/** AI 接口配置,持久化在 localStorage / Preferences。 */
export interface AIConfig {
  enabled: boolean
  provider: AIProvider
  baseUrl: string
  apiKey: string
  model: string
  /** 单次请求超时(ms) */
  timeoutMs: number
  /** 最近一次连通性测试是否通过 */
  lastTestOk: boolean | null
  lastTestedAt: number
  lastTestMessage: string
}

/** AI 归纳的返回结构。 */
export interface AISummary {
  /** 正面:提炼出的问题 / 标题 */
  front: string
  /** 背面:答案主体 */
  back: string
  /** 关键词,用于检索与标签 */
  keywords: string[]
}

/** 应用配置快照:AI 接口 + 当前复习范围。随原生备份一起导出/还原。 */
export interface AppConfigSnapshot {
  ai: AIConfig
  activeCollectionId: string
}

/** 数据导出包格式(ABDrop 原生备份)。 */
export interface ExportBundle {
  version: 3
  exportedAt: number
  /** 配置快照(AI 接口 + 复习范围);v2 及更早的备份无此字段。 */
  config?: AppConfigSnapshot
  cards: KnowledgeCard[]
  collections: Collection[]
}

/** 导入结果统计。 */
export interface ImportReport {
  added: number
  skipped: number
  collections: string[]
  warnings: string[]
}
