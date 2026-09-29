<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
/**
 * 设置页 —— 只有三项:AI 接口配置 / 合集管理 / 数据导入导出。
 *
 * 产品约束:不放任何"高级选项"。每一项都直接服务于核心流程,
 * 多一个开关都是负担。
 */
import type { AIConfig, AIProvider, Collection } from '~/types'
import { PROVIDER_PRESETS, testAIConnection } from '~/lib/ai'
import {
  ANKI_IMPORT_ACCEPT,
  exportForAnki,
  exportNativeBackup,
  importAnkiFile,
  importNativeBackup,
} from '~/lib/anki-io'
import { saveExportFile } from '~/composables/useNativeBridge'
import { useCardRepository } from '~/lib/db'
import { SEED_COLLECTIONS, SEED_SPECS, clearDemoData, seedDemoData } from '~/lib/seed'
import { useAIConfigState, useCollections } from '~/composables/useAppState'

const { aiConfig, load: loadAIConfig, save: saveAIConfig } = useAIConfigState()
const { collections, refresh: refreshCollections, create, rename, remove } = useCollections()

const repo = useCardRepository()

/** 当前打开的折叠面板(none / ai / collections / data)。 */
const panel = ref<'none' | 'ai' | 'collections' | 'data'>('none')
const toast = ref('')
const busy = ref('')
const cardCount = ref(0)
/** 导入/导出明细,展示给用户确认结果 */
const lastReport = ref('')

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
})

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
    const result = await testAIConnection({ ...aiDraft.value, enabled: true })
    aiDraft.value.lastTestOk = result.ok
    aiDraft.value.lastTestedAt = Date.now()
    aiDraft.value.lastTestMessage = result.message
    await saveAIConfig({ ...aiDraft.value })
    showToast(result.ok ? '连接正常' : `连接失败:${result.message}`)
  } finally {
    busy.value = ''
  }
}

// ── 合集管理 ─────────────────────────────────────────────────
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
    lastReport.value = buildImportReportText(report)
    showToast(`还原完成:新增 ${report.added} 张`)
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
    const out = await exportNativeBackup(repo)
    const res = await saveExportFile(out.filename, out.content)
    showToast(res.ok ? `已备份 ${out.count} 张` : res.message)
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
            <input v-model="aiDraft.model" class="input" type="text" placeholder="gpt-4o-mini" />
          </label>

          <label class="field">
            <span class="field__label">超时(毫秒)</span>
            <input v-model.number="aiDraft.timeoutMs" class="input" type="number" min="3000" max="120000" step="1000" />
          </label>

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
          <ul class="list">
            <li v-for="col in collections" :key="col.id" class="list__item">
              <span class="list__name">{{ col.name }}</span>
              <button class="mini" type="button" @click="onRenameCollection(col)">改名</button>
              <button v-if="col.id !== 'inbox'" class="mini mini--danger" type="button" @click="onRemoveCollection(col)">
                删除
              </button>
            </li>
          </ul>

          <div class="btn-row">
            <input v-model="newCollectionName" class="input input--grow" type="text" placeholder="新合集名称" @keyup.enter="onCreateCollection" />
            <button class="btn" type="button" @click="onCreateCollection">添加</button>
          </div>
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
                还原 ABDrop 备份
              </button>
            </div>
            <input ref="ankiInput" class="hidden-input" type="file" :accept="ANKI_IMPORT_ACCEPT" @change="onImportAnki" />
            <input ref="backupInput" class="hidden-input" type="file" accept=".json" @change="onImportBackup" />
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
                完整备份 JSON(含复习进度)
              </button>
            </div>
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
