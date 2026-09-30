<script setup lang="ts">
/**
 * 管理员页面。
 *
 * 与「设置」页的分工:
 *   - 设置页     → 日常三项(AI 配置 / 合集管理 / 数据导入导出),极简,人人可用
 *   - 管理员页   → 破坏性维护操作,带二次确认,误点代价高
 *
 * 入口刻意藏得深(设置页底部的「管理员」),避免日常误触。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useCardRepository, DEFAULT_COLLECTION_ID } from '~/lib/db'
import { ALL_COLLECTIONS_ID, ALL_COLLECTIONS_NAME, isAllScope } from '~/lib/db-constants'
import {
  RESET_MODE_INFO,
  describeReset,
  previewReset,
  resetCards,
  type ResetMode,
  type ResetReport,
} from '~/lib/admin'
import { SEED_COLLECTIONS, SEED_SPECS, countDemoData, seedDemoData, clearDemoData } from '~/lib/seed'
import { getClockOffsetMs, setClockOffsetMs, testNow } from '~/lib/clock'
import { useCollections } from '~/composables/useAppState'
import { hapticTap } from '~/composables/useNativeBridge'

const repo = useCardRepository()
const { collections, refresh: refreshCollections } = useCollections()

/** 选中的重置范围 */
const scopeId = ref<string>(ALL_COLLECTIONS_ID)
/** 选中的重置强度 */
const mode = ref<ResetMode>('schedule')

/** 预览数据:让用户在点之前就知道会影响多少张 */
const preview = ref({ total: 0, due: 0, scheduled: 0 })
/** 当前示例卡数量 */
const demoCount = ref(0)

/** 待确认的操作(非 null 时显示确认弹窗)。重置 / 移除示例数据共用。 */
type PendingAction =
  | { action: 'reset'; mode: ResetMode; label: string }
  | { action: 'clearDemo'; count: number }
const pending = ref<PendingAction | null>(null)

/** 时间调试:偏移分钟数与当前测试时间显示 */
const clockOffsetMin = ref(0)
const effectiveTime = ref('')
const CLOCK_PRESETS = [
  { label: '回到现在', ms: 0 },
  { label: '+1小时', ms: 3_600_000 },
  { label: '+1天', ms: 86_400_000 },
  { label: '+2天', ms: 2 * 86_400_000 },
] as const

function formatTestTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function refreshClockForm() {
  clockOffsetMin.value = Math.round(getClockOffsetMs() / 60_000)
  effectiveTime.value = formatTestTime(testNow())
}

function applyClockPreset(ms: number) {
  setClockOffsetMs(ms)
  refreshClockForm()
  void hapticTap('light')
  showToast(ms === 0 ? '已回到真实时间' : '测试时间已应用,回首页查看到期/打卡状态')
}

function applyClockOffset() {
  const min = Number(clockOffsetMin.value)
  if (!Number.isFinite(min)) return
  setClockOffsetMs(min * 60_000)
  refreshClockForm()
  void hapticTap('light')
  showToast('测试时间已应用,回首页查看状态')
}

const busy = ref<string>('')
const toast = ref('')
const lastReport = ref('')

/** 范围内可用的选项:「全部」+ 各真实合集 */
const scopeOptions = computed(() => [
  { id: ALL_COLLECTIONS_ID, name: ALL_COLLECTIONS_NAME },
  ...collections.value.map((c) => ({ id: c.id, name: c.name })),
])

const scopeLabel = computed(
  () => scopeOptions.value.find((o) => o.id === scopeId.value)?.name ?? '',
)

const modeInfo = computed(() => RESET_MODE_INFO[mode.value])

/** 只有当范围内确实有"未来计时"的卡片时,清计时才有意义 */
const hasScheduled = computed(() => preview.value.scheduled > 0)

/** 示例数据规模(与设置页文案保持一致) */
const seedCount = SEED_SPECS.length
const seedScope = SEED_COLLECTIONS.join(' / ')

async function loadPreview() {
  preview.value = await previewReset(repo, { collectionId: scopeId.value })
}

async function loadDemoCount() {
  demoCount.value = await countDemoData(repo)
}

onMounted(async () => {
  await refreshCollections()
  await loadPreview()
  await loadDemoCount()
  refreshClockForm()
})

async function onScopeChange(id: string) {
  scopeId.value = id
  await loadPreview()
}

/** 发起重置:先弹确认,不直接执行 */
function requestReset() {
  pending.value = { action: 'reset', mode: mode.value, label: scopeLabel.value }
}

/** 载入示例数据:幂等,直接执行(重复点击不产生重复卡) */
async function loadDemo() {
  busy.value = 'seed'
  try {
    const report = await seedDemoData(repo)
    await loadDemoCount()
    await refreshCollections()
    lastReport.value = report.added
      ? `已载入 ${report.added} 张示例卡片${report.skipped ? `,跳过 ${report.skipped} 张(已存在)` : ''}`
      : `示例数据已存在,跳过 ${report.skipped} 张`
    void hapticTap('light')
    showToast(lastReport.value)
  } finally {
    busy.value = ''
  }
}

/** 发起移除示例数据:先弹确认 */
function requestClearDemo() {
  if (demoCount.value === 0) return
  pending.value = { action: 'clearDemo', count: demoCount.value }
}

/** 确认后真正执行 */
async function confirmPending() {
  const target = pending.value
  if (!target) return
  pending.value = null

  busy.value = target.action === 'reset' ? 'reset' : 'seed'
  try {
    if (target.action === 'reset') {
      const report: ResetReport = await resetCards(
        repo,
        { collectionId: scopeId.value },
        target.mode,
        Date.now(),
        target.label,
      )
      lastReport.value = describeReset(report)
      await loadPreview()
      await refreshCollections()
      void hapticTap('medium')
    } else {
      const removed = await clearDemoData(repo)
      await loadDemoCount()
      await refreshCollections()
      lastReport.value = removed ? `已移除 ${removed} 张示例卡片` : '没有示例卡片可移除'
      void hapticTap('medium')
    }
    showToast(lastReport.value)
  } finally {
    busy.value = ''
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2600)
}

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <main class="admin">
    <header class="admin__head">
      <NuxtLink class="back" to="/settings" aria-label="返回设置">
        <svg viewBox="0 0 24 24" width="22" height="22">
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
      <h1 class="admin__title">管理员</h1>
      <span class="badge">维护工具</span>
    </header>

    <div class="admin__body scroll-area">
      <p class="lead">
        这里的操作会<strong>不可逆地</strong>改写复习进度。请先确认范围与强度。
      </p>

      <!-- ① 选择范围 -->
      <section class="panel">
        <h2 class="panel__title">重置范围</h2>
        <div class="chips">
          <button
            v-for="opt in scopeOptions"
            :key="opt.id"
            class="chip"
            :class="{ 'chip--on': scopeId === opt.id }"
            type="button"
            @click="onScopeChange(opt.id)"
          >
            {{ opt.name }}
          </button>
        </div>
        <p class="hint">
          共 {{ preview.total }} 张卡片 ·
          已到期 {{ preview.due }} 张 ·
          有未来计时 <strong>{{ preview.scheduled }}</strong> 张
        </p>
      </section>

      <!-- ② 选择强度 -->
      <section class="panel">
        <h2 class="panel__title">重置强度</h2>

        <label
          v-for="(info, key) in RESET_MODE_INFO"
          :key="key"
          class="mode"
          :class="{ 'mode--on': mode === key, 'mode--danger': info.destructive }"
        >
          <input v-model="mode" class="mode__radio" type="radio" :value="key" />
          <span class="mode__body">
            <span class="mode__label">
              {{ info.label }}
              <span v-if="info.destructive" class="mode__warn">不可恢复</span>
            </span>
            <span class="mode__desc">{{ info.description }}</span>
          </span>
        </label>

        <!-- 所选强度不适用时给出提示,避免用户困惑 -->
        <p v-if="mode === 'schedule' && !hasScheduled" class="hint hint--warn">
          当前范围内没有「未来计时」的卡片,清计时不会产生任何变化。
        </p>
      </section>

      <!-- ③ 执行 -->
      <section class="panel">
        <button
          class="action"
          :class="{ 'action--danger': modeInfo.destructive }"
          type="button"
          :disabled="Boolean(busy) || preview.total === 0"
          @click="requestReset"
        >
          {{
            busy
              ? '处理中…'
              : preview.total === 0
                ? '范围内没有卡片'
                : `${modeInfo.label} · 影响 ${preview.total} 张`
          }}
        </button>
        <p v-if="preview.total > 0" class="hint">
          将作用于:{{ isAllScope(scopeId) ? '全部合集' : `「${scopeLabel}」` }}
        </p>
      </section>

      <!-- ④ 示例数据 -->
      <section class="panel">
        <h2 class="panel__title">示例数据</h2>
        <p class="hint">
          载入 {{ seedCount }} 张覆盖各记忆等级与到期状态的示例卡片({{ seedScope }})。
          可重复载入,不会产生重复卡片。
        </p>
        <div class="btn-row">
          <button
            class="btn btn--ghost"
            type="button"
            :disabled="busy === 'seed'"
            @click="loadDemo"
          >
            载入示例数据
          </button>
          <button
            class="btn btn--ghost btn--danger-ghost"
            type="button"
            :disabled="busy === 'seed' || demoCount === 0"
            @click="requestClearDemo"
          >
            移除示例数据
          </button>
        </div>
        <p class="hint">
          当前有 <strong>{{ demoCount }}</strong> 张示例卡片。
          「移除」只删示例卡,不会碰你自己录入的内容。
        </p>
      </section>

      <!-- ⑤ 时间调试:验证「到点后 App 处于什么状态」 -->
      <section class="panel">
        <h2 class="panel__title">时间调试(测试)</h2>
        <p class="hint">
          把「当前时间」临时偏移,验证到点后的 App 状态(复习到期队列、打卡胶囊)。
          只影响 App 内的时间判断;系统通知按真实时钟发送,不受偏移影响。
        </p>
        <p class="hint">当前测试时间:<strong>{{ effectiveTime }}</strong></p>
        <div class="btn-row">
          <button
            v-for="p in CLOCK_PRESETS"
            :key="p.ms"
            class="btn btn--ghost clock-preset"
            type="button"
            @click="applyClockPreset(p.ms)"
          >
            {{ p.label }}
          </button>
        </div>
        <div class="btn-row">
          <input
            v-model.number="clockOffsetMin"
            class="clock-input"
            type="number"
            placeholder="偏移分钟数(可负)"
          />
          <button class="btn" type="button" @click="applyClockOffset">应用</button>
        </div>
      </section>

      <pre v-if="lastReport" class="report">{{ lastReport }}</pre>

      <p class="footnote">
        提示:「只清计时」适合积压太久想一次性拉回来;「完全重新开始」适合记忆记录已乱、想从头再来。
        两者都<strong>不会删除卡片内容</strong>。
      </p>
    </div>

    <!-- 二次确认:破坏性操作必须显式确认 -->
    <Transition name="fade">
      <div v-if="pending" class="confirm">
        <div class="confirm__scrim" @click="pending = null" />
        <div class="confirm__box" role="alertdialog" aria-modal="true">
          <!-- 重置:显示强度与影响范围 -->
          <template v-if="pending.action === 'reset'">
            <h3 class="confirm__title">确认要{{ RESET_MODE_INFO[pending.mode].label }}?</h3>
            <p class="confirm__text">
              将影响
              <strong>{{ pending.label }}</strong>
              范围内的 {{ preview.total }} 张卡片。
            </p>
            <p v-if="RESET_MODE_INFO[pending.mode].destructive" class="confirm__danger">
              记忆等级、复习次数、遗忘次数都会被清空,且无法撤销。
              建议先到「设置 → 数据导入导出」备份。
            </p>
            <p v-else class="confirm__note">
              卡片会立刻到期,记忆等级与复习统计保持不变。
            </p>
          </template>

          <!-- 移除示例数据:显示数量 -->
          <template v-else>
            <h3 class="confirm__title">确认移除示例数据?</h3>
            <p class="confirm__text">
              将移除
              <strong>{{ pending.count }}</strong>
              张示例卡片。它们可随时重新载入,你自己录入的内容不受影响。
            </p>
            <p class="confirm__note">此操作只影响以「demo-」开头的示例卡。</p>
          </template>

          <div class="confirm__actions">
            <button class="btn btn--ghost" type="button" @click="pending = null">取消</button>
            <button
              class="btn"
              :class="{
                'btn--danger': pending.action === 'reset'
                  ? RESET_MODE_INFO[pending.mode].destructive
                  : true,
              }"
              type="button"
              @click="confirmPending"
            >
              确认执行
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </main>
</template>

<style scoped>
.admin {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
}

.admin__head {
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
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.05);
}

.admin__title {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  flex: 1;
}

.badge {
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 999px;
  color: var(--danger);
  background: rgba(224, 106, 106, 0.1);
}

.admin__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px calc(16px + var(--safe-right)) calc(28px + var(--safe-bottom))
    calc(16px + var(--safe-left));
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 同 settings:flex 列滚动容器子项禁止收缩,否则 overflow:hidden 的面板会被压缩而非滚动 */
.admin__body > * {
  flex-shrink: 0;
}

.lead {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink-2);
}

.panel {
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: rgba(255, 255, 255, 0.66);
  backdrop-filter: blur(14px) saturate(1.4);
  border: 1px solid rgba(255, 255, 255, 0.8);
}

.panel__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-1);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  font-size: 14px;
  padding: 9px 15px;
  min-height: 40px;
  border-radius: 999px;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.06);
  transition: background 160ms ease, color 160ms ease;
}

.chip--on {
  color: #fff;
  background: var(--ink-1);
}

/* 重置强度选项 */
.mode {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 13px 14px;
  border-radius: 12px;
  border: 1.5px solid rgba(27, 36, 48, 0.1);
  background: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease;
}

.mode--on {
  border-color: var(--ink-1);
  background: rgba(255, 255, 255, 0.92);
}

.mode--danger.mode--on {
  border-color: var(--danger);
}

.mode__radio {
  margin-top: 3px;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  accent-color: var(--ink-1);
}

.mode--danger .mode__radio {
  accent-color: var(--danger);
}

.mode__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.mode__label {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-1);
  display: flex;
  align-items: center;
  gap: 8px;
}

.mode__warn {
  font-size: 11px;
  font-weight: 500;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--danger);
  background: rgba(224, 106, 106, 0.12);
}

.mode__desc {
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-2);
}

.hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-3);
}

.hint--warn {
  color: var(--fail);
}

.action {
  width: 100%;
  padding: 15px;
  min-height: 52px;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  background: var(--ink-1);
  transition: opacity 160ms ease, transform 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

.action--danger {
  background: var(--danger);
}

.action:disabled {
  opacity: 0.4;
}

.action:active:not(:disabled) {
  transform: scale(0.985);
}

.report {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(27, 36, 48, 0.05);
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.footnote {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-3);
}

/* 确认弹窗 */
.confirm {
  position: fixed;
  inset: 0;
  z-index: var(--z-toast);
  display: grid;
  place-items: center;
  padding: 24px;
}

.confirm__scrim {
  position: absolute;
  inset: 0;
  background: rgba(20, 28, 38, 0.4);
  backdrop-filter: blur(3px);
}

.confirm__box {
  position: relative;
  width: 100%;
  max-width: 380px;
  padding: 22px;
  border-radius: 18px;
  background: rgba(252, 253, 254, 0.97);
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.3);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.confirm__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--ink-1);
}

.confirm__text {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--ink-2);
}

.confirm__danger,
.confirm__note {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  padding: 10px 12px;
  border-radius: 10px;
}

.confirm__danger {
  color: var(--danger);
  background: rgba(224, 106, 106, 0.1);
}

.confirm__note {
  color: var(--ink-3);
  background: rgba(27, 36, 48, 0.05);
}

.confirm__actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.btn {
  flex: 1;
  padding: 13px;
  min-height: 48px;
  border-radius: 11px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  background: var(--ink-1);
}

.btn--ghost {
  color: var(--ink-1);
  background: rgba(27, 36, 48, 0.06);
}

.btn--danger {
  background: var(--danger);
}

/* 移除示例数据:红字透明底,提示"删除"但不抢主要视觉 */
.btn--danger-ghost {
  color: var(--danger);
  background: rgba(224, 106, 106, 0.1);
}

.btn-row {
  display: flex;
  gap: 10px;
}

/* 时间调试:预设按钮与分钟数输入 */
.clock-preset {
  flex: 1;
  padding: 9px 10px;
  min-height: 40px;
  font-size: 14px;
}

.clock-input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  min-height: 46px;
  border-radius: 10px;
  border: 1px solid rgba(27, 36, 48, 0.12);
  background: rgba(255, 255, 255, 0.85);
  font-size: 16px;
  outline: none;
}

.clock-input:focus {
  border-color: rgba(63, 191, 127, 0.55);
  box-shadow: 0 0 0 3px rgba(63, 191, 127, 0.12);
}

.toast {
  position: fixed;
  left: 50%;
  bottom: calc(28px + var(--safe-bottom));
  transform: translateX(-50%);
  z-index: var(--z-toast);
  padding: 11px 18px;
  border-radius: 999px;
  font-size: 14.5px;
  color: var(--ink-1);
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(12px);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
  max-width: calc(100vw - 48px);
  text-align: center;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 180ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
