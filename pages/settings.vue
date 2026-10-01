<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
/**
 * 设置页 —— 录入知识点 + 三项:AI 接口配置 / 合集管理 / 数据导入导出。
 *
 * 首页不再放任何录入入口(双击已移除、合集栏按钮已移至本页),录入统一从设置页进。
 */
import type { AIConfig, AIProvider, Collection } from '~/types'
import { PROVIDER_PRESETS, groupModels, listModels, testAIConnection } from '~/lib/ai'
import {
  ANKI_IMPORT_ACCEPT,
  exportForAnki,
  exportNativeBackupZip,
  importAnkiFile,
  importNativeBackup,
} from '~/lib/anki-io'
import {
  saveExportFile,
  hapticTap,
  platformFetch,
  applyFullscreen,
  getFullscreenPreference,
  setFullscreenPreference,
  isNativePlatform,
} from '~/composables/useNativeBridge'
import {
  APP_VERSION,
  UPDATE_REPO_NAME,
  UPDATE_REPO_OWNER,
  checkForUpdate,
  type UpdateCheckResult,
} from '~/lib/update'
import { useCardRepository } from '~/lib/db'
import { createReviewService } from '~/lib/review-service'
import { SEED_COLLECTIONS, SEED_SPECS, clearDemoData, seedDemoData } from '~/lib/seed'
import { useAIConfigState, useCollections } from '~/composables/useAppState'
import { useCheckinState } from '~/composables/useCheckinState'
import { useLanServer } from '~/composables/useLanServer'
import { ALL_COLLECTIONS_ID, ALL_COLLECTIONS_NAME } from '~/lib/db-constants'

const { aiConfig, load: loadAIConfig, save: saveAIConfig } = useAIConfigState()
const {
  collections,
  activeCollectionId,
  refresh: refreshCollections,
  create,
  rename,
  remove,
  select,
} = useCollections()

const repo = useCardRepository()
const service = createReviewService(repo)

const checkin = useCheckinState()
/** 局域网 Web 服务(管理卡片/合集/配置)。 */
const lanServer = useLanServer()
/** 打卡表单本地副本,改动即保存,无需独立「保存」按钮 */
const checkinEnabled = ref(false)
const checkinStart = ref('09:00')
const checkinEnd = ref('22:00')
/** 打卡提醒卡片是否展开(独立折叠,默认收起,与其他面板互不影响) */
const checkinOpen = ref(false)
/** 全屏沉浸(隐藏状态栏)开关状态 */
const fullscreenOn = ref(false)
/** 一天内的分钟数 <-> HH:MM。 */
function minutesToTime(m: number): string {
  const h = Math.floor(m / 60) % 24
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
function syncCheckinForm() {
  checkinEnabled.value = checkin.config.value.enabled
  checkinStart.value = minutesToTime(checkin.config.value.startMinute)
  checkinEnd.value = minutesToTime(checkin.config.value.endMinute)
}
async function onCheckinToggle(e: Event) {
  const enabled = (e.target as HTMLInputElement).checked
  checkinEnabled.value = enabled
  await checkin.updateConfig({ enabled })
  syncCheckinForm()
  showToast(enabled ? '打卡提醒已开启' : '打卡提醒已关闭')
}
async function onCheckinStartChange() {
  await checkin.updateConfig({ startMinute: timeToMinutes(checkinStart.value) })
  syncCheckinForm()
  showToast('开始时间已更新')
}
async function onCheckinEndChange() {
  await checkin.updateConfig({ endMinute: timeToMinutes(checkinEnd.value) })
  syncCheckinForm()
  showToast('结束时间已更新')
}

/** 当前打开的折叠面板(none / ai / collections / data)。 */
const panel = ref<'none' | 'fullscreen' | 'ai' | 'collections' | 'data'>('none')
const toast = ref('')
const busy = ref('')
const cardCount = ref(0)
/** 导入/导出明细,展示给用户确认结果 */
const lastReport = ref('')
/** 录入框开关(录入入口已从首页移至本页顶部按钮) */
const composeOpen = ref(false)

const newCollectionName = ref('')
/** 示例数据的真实规模,避免文案与数据脱节 */
const seedCount = SEED_SPECS.length
const seedScope = SEED_COLLECTIONS.join(' / ')

/** AI 表单的本地副本 —— 只有点保存才写回,避免边输边存。 */
const aiDraft = ref<AIConfig>({ ...aiConfig.value })

onMounted(async () => {
  await loadAIConfig()
  aiDraft.value = { ...aiConfig.value }
  await refreshCollections()
  cardCount.value = await repo.countCards()
  await checkin.load()
  syncCheckinForm()
  fullscreenOn.value = await getFullscreenPreference()
  // 局域网服务:恢复端口偏好,注册原生请求监听(仅原生环境生效)
  lanServer.loadPort()
  await lanServer.attachListener()
  // 原生环境读真实 versionName,与 build.gradle 保持一致
  if (isNativePlatform()) {
    try {
      const { App } = await import('@capacitor/app')
      const info = await App.getInfo()
      if (info?.version) localVersion.value = info.version
    } catch {
      /* 插件缺失保留常量 */
    }
  }
})

/** 切换全屏沉浸(隐藏状态栏):立即应用并持久化。 */
async function onFullscreenToggle(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  fullscreenOn.value = on
  const applied = await applyFullscreen(on)
  await setFullscreenPreference(on)
  showToast(
    on
      ? (applied ? '已进入全屏沉浸' : '已开启(当前环境无原生状态栏)')
      : '已退出全屏',
  )
}

function toggle(next: 'ai' | 'collections' | 'data') {
  if (panel.value === next) {
    panel.value = 'none'
    return
  }
  panel.value = next
  if (next === 'ai') aiDraft.value = { ...aiConfig.value }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2200)
}

/** 字节数 → 人类可读(B / KB / MB)。 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '未知大小'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
})

// ── AI 配置 ──────────────────────────────────────────────────
function applyPreset(provider: AIProvider) {
  const preset = PROVIDER_PRESETS[provider]
  aiDraft.value.provider = provider
  // 自定义保留用户已填的地址与模型
  if (provider !== 'custom') {
    aiDraft.value.baseUrl = preset.baseUrl
    aiDraft.value.model = preset.model
  }
}

async function onSaveAI() {
  await saveAIConfig({ ...aiDraft.value })
  showToast('AI 配置已保存')
}

async function onTestAI() {
  busy.value = 'ai'
  try {
    const result = await testAIConnection({ ...aiDraft.value, enabled: true }, platformFetch)
    aiDraft.value.lastTestOk = result.ok
    aiDraft.value.lastTestedAt = Date.now()
    aiDraft.value.lastTestMessage = result.message
    await saveAIConfig({ ...aiDraft.value })
    showToast(result.ok ? '连接正常' : `连接失败:${result.message}`)
  } finally {
    busy.value = ''
  }
}

/** 从网关拉取到的可用模型 id 列表(供下拉选择)。 */
const modelOptions = ref<string[]>([])
/** 模型列表拉取状态:'' 空闲 / 'models' 拉取中。 */
const modelBusy = ref(false)
/** 模型选择面板是否展开。 */
const modelPanelOpen = ref(false)
/** 模型列表搜索关键字(按 id 模糊过滤)。 */
const modelSearch = ref('')

/** 按下拉面板的分组 + 搜索过滤后的模型。 */
const groupedModels = computed(() => {
  const q = modelSearch.value.trim().toLowerCase()
  if (!modelOptions.value.length) return []
  const filtered = q
    ? modelOptions.value.filter((m) => m.toLowerCase().includes(q))
    : [...modelOptions.value]
  return groupModels(filtered)
})

/** 当前输入是否匹配列表里的某个 id(用于高亮)。 */
function isModelSelected(m: string): boolean {
  return aiDraft.value.model === m
}

/** 从面板选中一个模型。 */
function pickModel(m: string) {
  aiDraft.value.model = m
  modelPanelOpen.value = false
  modelSearch.value = ''
}

/** 从网关拉取模型列表,成功后填充到下拉。 */
async function onFetchModels() {
  if (modelBusy.value) return
  modelBusy.value = true
  try {
    const result = await listModels({ ...aiDraft.value }, platformFetch)
    if (result.ok) {
      modelOptions.value = result.models
      modelPanelOpen.value = true
      modelSearch.value = ''
      showToast(`已获取 ${result.models.length} 个模型`)
    } else {
      modelOptions.value = []
      showToast(`获取失败:${result.error}`)
    }
  } finally {
    modelBusy.value = false
  }
}

// ── 检查更新(GitHub Release)───────────────────────────────
/** 本机实际版本(原生读 build.gradle 的 versionName,Web 用常量)。 */
const localVersion = ref(APP_VERSION)
/** 最近一次检查结果。 */
const updateResult = ref<UpdateCheckResult | null>(null)
/** 检查中。 */
const updateBusy = ref(false)
/** 更新面板是否展开。 */
const updateOpen = ref(false)

/** 局域网管理面板是否展开。 */
const lanOpen = ref(false)

async function onLanStart() {
  const ok = await lanServer.start()
  showToast(ok ? 'Web 服务已开启' : (lanServer.error.value || '开启失败'))
}

async function onLanStop() {
  await lanServer.stop()
  showToast('Web 服务已关闭')
}

async function onCheckUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  updateResult.value = null
  try {
    const result = await checkForUpdate(
      UPDATE_REPO_OWNER,
      UPDATE_REPO_NAME,
      platformFetch,
      localVersion.value,
    )
    updateResult.value = result
    if (result.error) {
      showToast(`检查失败:${result.error}`)
    } else if (result.hasUpdate) {
      showToast(`发现新版本 ${result.latest}`)
    } else {
      showToast('已是最新版本')
    }
  } finally {
    updateBusy.value = false
  }
}

/** 下载/打开最新 APK:原生用系统浏览器下载,Web 开新标签。 */
function onDownloadUpdate() {
  const result = updateResult.value
  if (!result?.hasUpdate) return
  const url = result.apkAsset?.browser_download_url ?? result.release?.html_url
  if (!url) return
  if (isNativePlatform()) {
    // Android WebView 的 _system 目标交给系统浏览器打开
    window.open(url, '_system')
  } else {
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
}

// ── 录入(入口已移至设置页) ─────────────────────────────────
async function onSaveCard(payload: {
  sourceText: string
  front: string
  back: string
  imageUri: string
  tags: string[]
  collectionId: string
}) {
  await service.addCard({
    front: payload.front,
    back: payload.back,
    sourceText: payload.sourceText,
    imageUri: payload.imageUri,
    tags: payload.tags,
    collectionId: payload.collectionId,
  })
  // 保存后同步计数与合集列表;首页在导航返回时会重新加载,新卡立即可见
  await refreshCollections()
  cardCount.value = await repo.countCards()
  composeOpen.value = false
  void hapticTap('light')
  showToast('已保存')
}

// ── 合集管理 ─────────────────────────────────────────────────
/** 复习范围选项:「全部」+ 各真实合集(首页按此范围刷卡)。 */
const scopeOptions = computed(() => [
  { id: ALL_COLLECTIONS_ID, name: ALL_COLLECTIONS_NAME },
  ...collections.value.map((c) => ({ id: c.id, name: c.name })),
])

function onSelectScope(id: string) {
  select(id)
  showToast(id === ALL_COLLECTIONS_ID ? '已切换:复习全部合集' : '已切换复习范围')
}

async function onCreateCollection() {
  const name = newCollectionName.value.trim()
  if (!name) return
  await create(name)
  newCollectionName.value = ''
  showToast(`已创建合集「${name}」`)
}

async function onRenameCollection(col: Collection) {
  const next = window.prompt('重命名合集', col.name)
  if (next == null || !next.trim() || next === col.name) return
  await rename(col.id, next.trim())
  showToast('已重命名')
}

async function onRemoveCollection(col: Collection) {
  if (col.id === 'inbox') return
  const ok = window.confirm(`删除合集「${col.name}」?其下卡片会移入「未分类」,不会丢失。`)
  if (!ok) return
  await remove(col.id)
  await refreshCollections()
  cardCount.value = await repo.countCards()
  showToast('已删除,卡片已转入未分类')
}

// ── 数据导入导出 ─────────────────────────────────────────────
const ankiInput = ref<HTMLInputElement | null>(null)
const backupInput = ref<HTMLInputElement | null>(null)

async function onImportAnki(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  busy.value = 'import'
  lastReport.value = ''
  try {
    const report = await importAnkiFile(file, repo)
    cardCount.value = await repo.countCards()
    await refreshCollections()
    lastReport.value = buildImportReportText(report)
    showToast(`导入完成:新增 ${report.added} 张`)
  } catch (err) {
    lastReport.value = `导入失败:${err instanceof Error ? err.message : String(err)}`
    showToast('导入失败')
  } finally {
    busy.value = ''
    if (ankiInput.value) ankiInput.value.value = ''
  }
}

function buildImportReportText(report: {
  added: number
  skipped: number
  collections: string[]
  warnings: string[]
}): string {
  const lines = [`新增 ${report.added} 张,跳过 ${report.skipped} 张`]
  if (report.collections.length) lines.push(`涉及牌组:${report.collections.join(' / ')}`)
  if (report.warnings.length) lines.push(...report.warnings.map((w) => `· ${w}`))
  return lines.join('\n')
}

async function onImportBackup(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  busy.value = 'import'
  try {
    const report = await importNativeBackup(file, repo)
    cardCount.value = await repo.countCards()
    await refreshCollections()
    if (report.restoredConfig) {
      // 「加载配置」:配置快照覆盖当前 AI 配置与复习范围
      await saveAIConfig(report.restoredConfig.ai)
      select(report.restoredConfig.activeCollectionId)
      aiDraft.value = { ...aiConfig.value }
      lastReport.value =
        `${buildImportReportText(report)}\n已恢复 AI 配置与复习范围`
      showToast(`配置已加载:新增 ${report.added} 张`)
    } else {
      lastReport.value = buildImportReportText(report)
      showToast(`还原完成:新增 ${report.added} 张`)
    }
  } catch (err) {
    lastReport.value = `还原失败:${err instanceof Error ? err.message : String(err)}`
  } finally {
    busy.value = ''
    if (backupInput.value) backupInput.value.value = ''
  }
}

async function onExportAnki(format: 'tsv' | 'csv') {
  busy.value = 'export'
  try {
    const out = await exportForAnki(repo, format)
    const res = await saveExportFile(out.filename, out.content)
    showToast(res.ok ? `已导出 ${out.count} 张(${format.toUpperCase()})` : res.message)
  } finally {
    busy.value = ''
  }
}

async function onExportBackup() {
  busy.value = 'export'
  try {
    // 「保存配置」:zip 备份包 —— 图片外置 + 配置 + 合集 + 卡片(含复习进度)
    const out = await exportNativeBackupZip(repo, {
      ai: { ...aiConfig.value },
      activeCollectionId: activeCollectionId.value,
    })
    const res = await saveExportFile(out.filename, out.content)
    showToast(res.ok ? `已保存备份:${out.count} 张卡片` : res.message)
  } finally {
    busy.value = ''
  }
}

// ── 示例数据 ─────────────────────────────────────────────────
async function onSeedDemo() {
  busy.value = 'seed'
  try {
    const report = await seedDemoData(repo)
    cardCount.value = await repo.countCards()
    await refreshCollections()
    lastReport.value = report.added
      ? `已载入 ${report.added} 张示例卡片${report.skipped ? `,跳过 ${report.skipped} 张(已存在)` : ''}`
      : `示例数据已存在,跳过 ${report.skipped} 张`
  } finally {
    busy.value = ''
  }
}

async function onClearDemo() {
  busy.value = 'seed'
  try {
    const removed = await clearDemoData(repo)
    cardCount.value = await repo.countCards()
    lastReport.value = removed ? `已移除 ${removed} 张示例卡片` : '没有示例卡片可移除'
  } finally {
    busy.value = ''
  }
}

async function onClearAll() {
  const ok = window.confirm('清空全部卡片与合集?此操作不可撤销,建议先导出备份。')
  if (!ok) return
  await repo.clearAll()
  cardCount.value = await repo.countCards()
  await refreshCollections()
  showToast('已清空')
}
</script>

<template>
  <main class="settings">
    <header class="settings__head">
      <NuxtLink class="back" to="/" aria-label="返回">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path
            d="M14.5 5 L7.5 12 L14.5 19"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </NuxtLink>
      <h1 class="settings__title">设置</h1>
      <span class="settings__count">{{ cardCount }} 张卡片</span>
    </header>

    <div class="settings__body scroll-area">
      <button class="compose-entry" type="button" @click="composeOpen = true">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M12 5.5 V18.5 M5.5 12 H18.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
          />
        </svg>
        录入知识点
      </button>

      <!-- ② 合集管理 -->
      <section class="panel">
        <button class="panel__head" type="button" @click="toggle('collections')">
          <span class="panel__name">合集管理</span>
          <span class="panel__meta">{{ collections.length }} 个</span>
          <svg class="panel__caret" :class="{ 'panel__caret--open': panel === 'collections' }" viewBox="0 0 24 24" width="18" height="18">
            <path d="M9 6 L15 12 L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>

        <div v-if="panel === 'collections'" class="panel__body">
          <!-- 复习范围:首页按此分组刷卡 -->
          <div class="group">
            <span class="field__label">复习范围</span>
            <ul class="scope-list">
              <li v-for="opt in scopeOptions" :key="opt.id" class="scope-item">
                <button
                  class="scope-opt"
                  :class="{ 'scope-opt--on': activeCollectionId === opt.id }"
                  type="button"
                  @click="onSelectScope(opt.id)"
                >
                  <span class="scope-opt__name">{{ opt.name }}</span>
                  <span v-if="activeCollectionId === opt.id" class="scope-opt__check">✓</span>
                </button>
              </li>
            </ul>
            <p class="field__hint">选择后,首页只复习该分组的卡片;选「全部」复习所有合集。</p>
          </div>

          <div class="group">
            <span class="field__label">合集列表</span>
            <ul class="list">
              <li v-for="col in collections" :key="col.id" class="list__item">
                <span class="list__name">{{ col.name }}</span>
                <button class="mini" type="button" @click="onRenameCollection(col)">改名</button>
                <button v-if="col.id !== 'inbox'" class="mini mini--danger" type="button" @click="onRemoveCollection(col)">
                  删除
                </button>
              </li>
            </ul>
          </div>

          <div class="btn-row">
            <input v-model="newCollectionName" class="input input--grow" type="text" placeholder="新合集名称" @keyup.enter="onCreateCollection" />
            <button class="btn" type="button" @click="onCreateCollection">添加</button>
          </div>
        </div>
      </section>

      <!-- 每日打卡提醒:可折叠卡片(独立折叠,默认收起),首页右上角胶囊 + 每小时系统通知 -->
      <section class="panel checkin-panel">
        <button class="checkin-panel__head" type="button" @click="checkinOpen = !checkinOpen">
          <span class="panel__name">打卡提醒</span>
          <span class="panel__meta">{{ checkinEnabled ? `${checkinStart}–${checkinEnd} · 每小时` : '未启用' }}</span>
          <svg class="panel__caret" :class="{ 'panel__caret--open': checkinOpen }" viewBox="0 0 24 24" width="18" height="18">
            <path d="M9 6 L15 12 L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
        <div v-show="checkinOpen" class="checkin-panel__body">
          <label class="row">
            <span class="row__label">每日打卡提醒</span>
            <input v-model="checkinEnabled" class="switch" type="checkbox" @change="onCheckinToggle" />
          </label>

          <div class="field">
            <span class="field__label">开始时间</span>
            <input v-model="checkinStart" class="input" type="time" :disabled="!checkinEnabled" @change="onCheckinStartChange" />
          </div>

          <div class="field">
            <span class="field__label">结束时间</span>
            <input v-model="checkinEnd" class="input" type="time" :disabled="!checkinEnabled" @change="onCheckinEndChange" />
          </div>

          <p class="field__hint">
            开启后,当天若还没打卡,从开始时间起每小时发一条系统通知,直到打卡或到结束时间;
            打卡状态每天自动重置。提醒走系统后台通知,需授予通知权限。
          </p>
        </div>
      </section>

      <!-- ③ 数据导入导出 -->
      <section class="panel">
        <button class="panel__head" type="button" @click="toggle('data')">
          <span class="panel__name">数据导入导出</span>
          <span class="panel__meta">Anki 兼容</span>
          <svg class="panel__caret" :class="{ 'panel__caret--open': panel === 'data' }" viewBox="0 0 24 24" width="18" height="18">
            <path d="M9 6 L15 12 L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>

        <div v-if="panel === 'data'" class="panel__body">
          <p class="field__hint">
            支持导入 Anki 的 .apkg 集合包与「纯文本」导出(TSV/CSV);导出的文件可直接被 Anki 导入。
          </p>

          <!-- 导入 -->
          <div class="group">
            <span class="field__label">导入</span>
            <div class="btn-row">
              <button class="btn btn--ghost" type="button" :disabled="busy === 'import'" @click="ankiInput?.click()">
                {{ busy === 'import' ? '处理中…' : '导入 Anki 文件' }}
              </button>
              <button class="btn btn--ghost" type="button" :disabled="busy === 'import'" @click="backupInput?.click()">
                加载备份(还原)
              </button>
            </div>
            <input ref="ankiInput" class="hidden-input" type="file" :accept="ANKI_IMPORT_ACCEPT" @change="onImportAnki" />
            <input ref="backupInput" class="hidden-input" type="file" accept=".json,.zip,application/zip" @change="onImportBackup" />
          </div>

          <!-- 导出 -->
          <div class="group">
            <span class="field__label">导出</span>
            <div class="btn-row">
              <button class="btn btn--ghost" type="button" :disabled="busy === 'export'" @click="onExportAnki('tsv')">
                导出 Anki TSV
              </button>
              <button class="btn btn--ghost" type="button" :disabled="busy === 'export'" @click="onExportAnki('csv')">
                导出 Anki CSV
              </button>
            </div>
            <div class="btn-row">
              <button class="btn btn--ghost" type="button" :disabled="busy === 'export'" @click="onExportBackup">
                备份全部数据(zip)
              </button>
            </div>
            <p class="field__hint">
              「备份全部数据」导出 zip 包:卡片文字、图片(独立文件)、复习进度与全部配置(AI / 复习范围 / 打卡 / 全屏)完整包含。
              支持导入旧版 JSON 快照;文件含 API Key,请勿外传;「加载备份」会覆盖当前 AI 配置与复习范围,卡片按 id 幂等合并。
            </p>
          </div>

          <pre v-if="lastReport" class="report">{{ lastReport }}</pre>

          <!-- 示例数据:便于快速体验与演示 -->
          <div class="group">
            <span class="field__label">示例数据</span>
            <p class="field__hint">
              载入 {{ seedCount }} 张覆盖各记忆等级与到期状态的示例卡片({{ seedScope }})。
              可重复点击,不会产生重复卡片。
            </p>
            <div class="btn-row">
              <button class="btn btn--ghost" type="button" :disabled="busy === 'seed'" @click="onSeedDemo">
                载入示例数据
              </button>
              <button class="btn btn--ghost" type="button" :disabled="busy === 'seed'" @click="onClearDemo">
                移除示例数据
              </button>
            </div>
          </div>

          <div class="group">
            <button class="btn btn--danger" type="button" @click="onClearAll">清空全部数据</button>
          </div>
        </div>
      </section>

      <!-- ① AI 接口配置 -->
      <section class="panel">
        <button class="panel__head" type="button" @click="toggle('ai')">
          <span class="panel__name">AI 接口配置</span>
          <span class="panel__meta">{{ aiConfig.enabled ? aiConfig.model || '已启用' : '未启用' }}</span>
          <svg class="panel__caret" :class="{ 'panel__caret--open': panel === 'ai' }" viewBox="0 0 24 24" width="18" height="18">
            <path d="M9 6 L15 12 L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>

        <div v-if="panel === 'ai'" class="panel__body">
          <label class="row">
            <span class="row__label">启用 AI 归纳</span>
            <input v-model="aiDraft.enabled" class="switch" type="checkbox" />
          </label>

          <div class="field">
            <span class="field__label">服务商</span>
            <div class="chips">
              <button
                v-for="(preset, key) in PROVIDER_PRESETS"
                :key="key"
                class="chip"
                :class="{ 'chip--on': aiDraft.provider === key }"
                type="button"
                @click="applyPreset(key as AIProvider)"
              >
                {{ preset.label }}
              </button>
            </div>
            <p class="field__hint">{{ PROVIDER_PRESETS[aiDraft.provider].hint }}</p>
          </div>

          <label class="field">
            <span class="field__label">接口地址</span>
            <input v-model="aiDraft.baseUrl" class="input" type="url" placeholder="https://api.openai.com/v1" />
          </label>

          <label class="field">
            <span class="field__label">API Key</span>
            <input v-model="aiDraft.apiKey" class="input" type="password" placeholder="sk-…" autocomplete="off" />
          </label>

          <label class="field">
            <span class="field__label">模型</span>

            <!-- 面板展开时的全屏透明遮罩:点面板外任意处关闭 -->
            <Transition name="fade">
              <div
                v-if="modelPanelOpen && modelOptions.length"
                class="model-scrim"
                @click="modelPanelOpen = false"
              />
            </Transition>

            <div class="model-field">
              <input
                v-model="aiDraft.model"
                class="input"
                type="text"
                placeholder="gpt-4o-mini"
                @focus="modelSearch = ''; modelPanelOpen = modelOptions.length > 0"
              />
              <!-- 模型选择面板:可滚动 + 分组 + 搜索过滤 -->
              <Transition name="fade">
                <div v-if="modelPanelOpen && modelOptions.length" class="model-panel">
                  <div class="model-panel__search">
                    <input
                      v-model="modelSearch"
                      class="input model-panel__search-input"
                      type="text"
                      placeholder="搜索模型…"
                      @click.stop
                      @focus.stop
                    />
                  </div>
                  <div class="model-panel__list scroll-area">
                    <template v-if="groupedModels.length">
                      <template v-for="g in groupedModels" :key="g.label">
                        <div class="model-panel__group">{{ g.label }}</div>
                        <button
                          v-for="m in g.models"
                          :key="m"
                          class="model-panel__item"
                          :class="{ 'model-panel__item--on': isModelSelected(m) }"
                          type="button"
                          @click="pickModel(m)"
                        >
                          <span class="model-panel__name">{{ m }}</span>
                          <span v-if="isModelSelected(m)" class="model-panel__check">✓</span>
                        </button>
                      </template>
                    </template>
                    <p v-else class="model-panel__empty">没有匹配「{{ modelSearch }}」的模型</p>
                  </div>
                </div>
              </Transition>
            </div>
            <div class="btn-row">
              <button
                class="btn btn--ghost"
                type="button"
                :disabled="modelBusy || busy === 'ai'"
                @click="onFetchModels"
              >
                {{ modelBusy ? '获取中…' : '获取模型列表' }}
              </button>
              <span v-if="modelOptions.length" class="field__hint model-count">
                {{ modelOptions.length }} 个模型可用
              </span>
            </div>
          </label>

          <label class="field">
            <span class="field__label">超时(毫秒)</span>
            <input v-model.number="aiDraft.timeoutMs" class="input" type="number" min="3000" max="120000" step="1000" />
          </label>

          <div class="field">
            <span class="field__label">识别图片</span>
            <label class="row">
              <span class="row__label">允许 AI 读取录入图片</span>
              <input
                v-model="aiDraft.vision"
                class="switch"
                type="checkbox"
              />
            </label>
            <p class="field__hint">
              开启后,录入框拍照/选图时会把图片一并发送给模型,AI 直接读图生成卡片。
              需要模型本身支持图片输入(如 gpt-4o、claude 及多数新模型)。
            </p>
          </div>

          <p v-if="aiConfig.lastTestMessage" class="field__hint" :class="{ 'field__hint--bad': aiConfig.lastTestOk === false }">
            上次测试:{{ aiConfig.lastTestMessage }}
          </p>

          <div class="btn-row">
            <button class="btn btn--ghost" type="button" :disabled="busy === 'ai'" @click="onTestAI">
              {{ busy === 'ai' ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn" type="button" @click="onSaveAI">保存</button>
          </div>
        </div>
      </section>

      <!-- 检查更新:基于 GitHub Release 一键升级 -->
      <section class="panel">
        <button class="panel__head" type="button" @click="updateOpen = !updateOpen">
          <span class="panel__name">检查更新</span>
          <span class="panel__meta">
            {{ updateResult?.hasUpdate ? `发现新版本 ${updateResult.latest}` : `v${localVersion}` }}
          </span>
          <svg class="panel__caret" :class="{ 'panel__caret--open': updateOpen }" viewBox="0 0 24 24" width="18" height="18">
            <path d="M9 6 L15 12 L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
        <div v-if="updateOpen" class="panel__body">
          <p class="field__hint">
            App 通过 GitHub Release 分发更新。点击「检查更新」比对当前版本与最新发布;
            有新版本时可直接下载 APK 安装。
          </p>
          <div class="btn-row">
            <button class="btn btn--ghost" type="button" :disabled="updateBusy" @click="onCheckUpdate">
              {{ updateBusy ? '检查中…' : '检查更新' }}
            </button>
          </div>

          <p v-if="updateResult?.error" class="field__hint field__hint--bad">
            检查失败:{{ updateResult.error }}
          </p>

          <template v-else-if="updateResult?.hasUpdate">
            <div class="group">
              <span class="field__label">新版本 {{ updateResult.latest }} 可用</span>
              <p v-if="updateResult.release?.body" class="field__hint update-notes">{{ updateResult.release.body }}</p>
              <div class="btn-row">
                <button class="btn" type="button" @click="onDownloadUpdate">
                  {{ updateResult.apkAsset ? '下载并安装' : '前往 Release 页' }}
                </button>
              </div>
              <p class="field__hint">
                {{ updateResult.apkAsset
                  ? `下载 ${updateResult.apkAsset.name}(${formatBytes(updateResult.apkAsset.size)}),下载完成后点击通知即可安装。`
                  : '该 Release 未附带 APK,将打开 GitHub Release 页面。' }}
              </p>
            </div>
          </template>

          <p v-else-if="updateResult && !updateResult.error" class="field__hint">
            已是最新版本(v{{ updateResult.local }})。
          </p>
        </div>
      </section>

      <!-- 局域网 Web 服务:同网段设备浏览器管理 -->
      <section class="panel">
        <button class="panel__head" type="button" @click="lanOpen = !lanOpen">
          <span class="panel__name">局域网管理</span>
          <span class="panel__meta">
            {{ lanServer.running.value ? '运行中' : '未开启' }}
          </span>
          <svg class="panel__caret" :class="{ 'panel__caret--open': lanOpen }" viewBox="0 0 24 24" width="18" height="18">
            <path d="M9 6 L15 12 L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
        <div v-if="lanOpen" class="panel__body">
          <p class="field__hint">
            开启后在手机本地起一个网页服务。同一局域网的电脑 / 平板用浏览器打开
            下方链接,即可远程:浏览与新增 / 删除卡片、管理合集、切换复习范围、调整 AI 配置等,
            全部直接读写手机里的数据。仅局域网可访问,请勿在公共网络使用。
          </p>

          <div class="field">
            <span class="field__label">端口</span>
            <input v-model.number="lanServer.port.value" class="input" type="number" min="1" max="65535" :disabled="lanServer.running.value" />
          </div>

          <div class="btn-row">
            <button
              v-if="!lanServer.running.value"
              class="btn"
              type="button"
              @click="onLanStart"
            >
              开启 Web 服务
            </button>
            <button v-else class="btn btn--danger" type="button" @click="onLanStop">
              关闭服务
            </button>
          </div>

          <p v-if="lanServer.url.value" class="lan-url">
            <a :href="lanServer.url.value" target="_blank" rel="noopener">{{ lanServer.url.value }}</a>
          </p>
          <p v-if="lanServer.error.value" class="field__hint field__hint--bad">
            {{ lanServer.error.value }}
          </p>
          <p class="field__hint">
            开启后 App 会常驻一个小型网页服务;不用时请关闭。端口可修改,重启服务生效。
          </p>
        </div>
      </section>

      <!-- 全屏沉浸:隐藏系统状态栏 -->
      <section class="panel">
        <button class="panel__head" type="button" @click="panel === 'fullscreen' ? (panel = 'none') : (panel = 'fullscreen')">
          <span class="panel__name">全屏沉浸</span>
          <span class="panel__meta">{{ fullscreenOn ? '已开启' : '未开启' }}</span>
          <svg class="panel__caret" :class="{ 'panel__caret--open': panel === 'fullscreen' }" viewBox="0 0 24 24" width="18" height="18">
            <path d="M9 6 L15 12 L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
        <div v-if="panel === 'fullscreen'" class="panel__body">
          <label class="row">
            <span class="row__label">隐藏系统状态栏</span>
            <input
              class="switch"
              type="checkbox"
              :checked="fullscreenOn"
              @change="onFullscreenToggle"
            />
          </label>
          <p class="field__hint">
            开启后隐藏手机顶部状态栏(时钟、电量等),卡片占据整个屏幕,浏览更沉浸。
            原生容器内即时生效;网页预览无状态栏可隐藏。
          </p>
        </div>
      </section>

      <!--
        管理员入口:刻意不放进上面三个功能面板里,
        保持设置页"只有三项"的极简约束,同时让破坏性功能不那么容易被误入。
      -->
      <NuxtLink class="admin-link" to="/admin">
        <span class="admin-link__text">
          <span class="admin-link__title">管理员</span>
          <span class="admin-link__desc">重置复习进度等维护操作</span>
        </span>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M9 6 L15 12 L9 18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </NuxtLink>
    </div>

    <!-- 录入框(入口在本页顶部的「录入知识点」按钮) -->
    <ComposeSheet
      :open="composeOpen"
      :collections="collections"
      :active-collection-id="activeCollectionId"
      :ai-config="aiConfig"
      @close="composeOpen = false"
      @save="onSaveCard"
    />

    <Transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </main>
</template>

<style scoped>
.settings {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
}

.settings__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: calc(var(--safe-top) + 12px) calc(16px + var(--safe-right)) 10px
    calc(16px + var(--safe-left));
}

.back {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.05);
}

.settings__title {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  flex: 1;
}

.settings__count {
  font-size: 14px;
  color: var(--ink-3);
}

.settings__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px calc(16px + var(--safe-right)) calc(24px + var(--safe-bottom))
    calc(16px + var(--safe-left));
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 关键:flex 列滚动容器的子项禁止收缩。
 * .panel 带 overflow:hidden 会使 flex 自动最小尺寸失效(min-height:auto 变 0),
 * 内容多时 flexbox 会压缩面板而不是溢出滚动 —— 表现为"滑不动、内容被裁"。 */
.settings__body > * {
  flex-shrink: 0;
}

/* 录入入口:全宽主行动按钮,随页面一起滚动 */
.compose-entry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 52px;
  border-radius: 14px;
  font-size: 17px;
  font-weight: 600;
  color: #fff;
  background: var(--ink-1);
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.18);
  transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease;
}

.compose-entry:active {
  transform: scale(0.98);
  opacity: 0.9;
}

.panel {
  border-radius: 14px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.66);
  backdrop-filter: blur(14px) saturate(1.4);
  border: 1px solid rgba(255, 255, 255, 0.8);
}

.panel__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  min-height: 56px;
  text-align: left;
}

/* 打卡提醒:可折叠卡片头部(独立类,不进 .panel__head 折叠计数) */
.checkin-panel__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  min-height: 56px;
  text-align: left;
}

.checkin-panel__body {
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel__name {
  font-size: 17px;
  font-weight: 500;
  flex: 1;
}

.panel__meta {
  font-size: 14px;
  color: var(--ink-3);
}

.panel__caret {
  color: var(--ink-3);
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}

.panel__caret--open {
  transform: rotate(90deg);
}

.panel__body {
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.row__label {
  font-size: 16px;
  color: var(--ink-1);
}

.switch {
  width: 42px;
  height: 24px;
  appearance: none;
  border-radius: 999px;
  background: rgba(27, 36, 48, 0.15);
  position: relative;
  transition: background 180ms ease;
  cursor: pointer;
}

.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.2);
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.switch:checked {
  background: var(--pass);
}

.switch:checked::after {
  transform: translateX(18px);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field__label {
  font-size: 14px;
  color: var(--ink-3);
}

.field__hint {
  margin: 0;
  font-size: 14px;
  color: var(--ink-3);
  line-height: 1.5;
}

.field__hint--bad {
  color: var(--danger);
}

/* 更新说明:多行文本,保留换行 */
.update-notes {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 140px;
  overflow-y: auto;
}

/* 局域网管理:连接地址醒目展示,可点击复制 */
.lan-url {
  margin: 10px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(47, 111, 237, 0.08);
  border: 1px solid rgba(47, 111, 237, 0.25);
  font-size: 15px;
  font-weight: 600;
  word-break: break-all;
}
.lan-url a {
  color: var(--accent, #2f6fed);
  text-decoration: none;
}

.input {
  width: 100%;
  padding: 10px 12px;
  min-height: 46px;
  border-radius: 10px;
  border: 1px solid rgba(27, 36, 48, 0.12);
  background: rgba(255, 255, 255, 0.85);
  font-size: 16px;
  outline: none;
}

.input:focus {
  border-color: rgba(63, 191, 127, 0.55);
  box-shadow: 0 0 0 3px rgba(63, 191, 127, 0.12);
}

.input--grow {
  flex: 1;
}

/* ── 模型选择面板 ─────────────────────────────────────────── */
.model-field {
  position: relative;
}

/* 全屏透明遮罩:点面板外关闭;在面板之下、页面之上 */
.model-scrim {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-sheet) - 5);
  background: transparent;
}

.model-panel {
  position: relative;
  z-index: calc(var(--z-sheet) - 4);
  margin-top: 6px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
  backdrop-filter: blur(16px) saturate(1.4);
  -webkit-backdrop-filter: blur(16px) saturate(1.4);
  overflow: hidden;
}

.model-panel__search {
  padding: 8px;
  border-bottom: 1px solid rgba(27, 36, 48, 0.06);
  flex: 0 0 auto;
}

.model-panel__search-input {
  min-height: 40px;
  font-size: 15px;
}

.model-panel__list {
  /* 面板高度上限:最多露出 6 行左右,搜索框常驻 */
  max-height: min(52dvh, 300px);
}

.model-panel__group {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 12px 4px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--ink-3);
  background: rgba(255, 255, 255, 0.96);
}

.model-panel__item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--ink-1);
  text-align: left;
  transition: background 120ms ease;
}

.model-panel__item:active {
  background: rgba(27, 36, 48, 0.06);
}

.model-panel__item--on {
  color: var(--pass);
  font-weight: 600;
}

.model-panel__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-panel__check {
  flex: 0 0 auto;
  font-weight: 700;
}

.model-panel__empty {
  margin: 0;
  padding: 18px 14px;
  font-size: 14px;
  color: var(--ink-3);
  text-align: center;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  font-size: 14px;
  padding: 8px 15px;
  border-radius: 999px;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.05);
}

.chip--on {
  color: #fff;
  background: var(--ink-1);
}

.btn-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.btn {
  padding: 12px 18px;
  min-height: 46px;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 500;
  color: #fff;
  background: var(--ink-1);
}

.btn:disabled {
  opacity: 0.5;
}

.btn--ghost {
  color: var(--ink-1);
  background: rgba(27, 36, 48, 0.06);
}

.btn--danger {
  color: var(--danger);
  background: rgba(224, 106, 106, 0.1);
  width: 100%;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.list__item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.list__name {
  flex: 1;
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 复习范围选项列表(独立类,避免与合集列表的 .list__item 混淆) */
.scope-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scope-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 复习范围选项:整行可点,当前范围高亮 */
.scope-opt {
  width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px 14px;
  border-radius: 999px;
  font-size: 15px;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.05);
  text-align: left;
}

.scope-opt--on {
  color: #fff;
  background: var(--ink-1);
}

.scope-opt__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scope-opt__check {
  flex: 0 0 auto;
  font-weight: 700;
}

.mini {
  font-size: 14px;
  min-height: 36px;
  padding: 7px 13px;
  border-radius: 999px;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.05);
}

.mini--danger {
  color: var(--danger);
}

.hidden-input {
  display: none;
}

.report {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(27, 36, 48, 0.04);
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

/* 管理员入口:低调、不与三个功能面板争视觉焦点 */
.admin-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  min-height: 56px;
  border-radius: 14px;
  text-decoration: none;
  color: var(--ink-3);
  background: rgba(255, 255, 255, 0.42);
  border: 1px dashed rgba(27, 36, 48, 0.14);
  transition: background 160ms ease, color 160ms ease;
}

.admin-link:active {
  background: rgba(255, 255, 255, 0.75);
  color: var(--ink-1);
}

.admin-link__text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.admin-link__title {
  font-size: 15px;
  font-weight: 600;
}

.admin-link__desc {
  font-size: 12.5px;
  opacity: 0.8;
}

.toast {
  position: absolute;
  left: 50%;
  bottom: calc(28px + var(--safe-bottom));
  transform: translateX(-50%);
  z-index: var(--z-toast);
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 15px;
  color: var(--ink-1);
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12);
  max-width: calc(100vw - var(--safe-left) - var(--safe-right) - 48px);
  text-align: center;
}
</style>
