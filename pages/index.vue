<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
/**
 * 首页 —— 全屏卡片堆叠,除此之外什么都没有。
 *
 * 手势都从 CardStack 冒泡上来,由本页统一落库:
 *   左/右滑 → commitReview(调度记忆等级 + 重算复习时间)
 *   单击    → 翻面看答案
 * 复习分组切换入口在设置页(首页不再有下拉合集栏/录入入口)。
 */
import type { KnowledgeCard, ReviewVerdict } from '~/types'
import { createReviewService } from '~/lib/review-service'
import { describeDue } from '~/lib/srs'
import { useCardRepository } from '~/lib/db'
import { useCollections, useAIConfigState } from '~/composables/useAppState'
import { useCheckinState } from '~/composables/useCheckinState'
import { hapticTap } from '~/composables/useNativeBridge'
import { testNowMs } from '~/lib/clock'
import { ALL_COLLECTIONS_ID, isAllScope } from '~/lib/db-constants'

const {
  collections,
  activeCollectionId,
  activeCollection,
  refresh: refreshCollections,
} = useCollections()
const { aiConfig, load: loadAIConfig } = useAIConfigState()

const repo = useCardRepository()
const service = createReviewService(repo)
const checkin = useCheckinState()
// 顶层解构:模板里 ref 自动解包(直接挂在对象上访问会拿到 Ref 本体)
const { config: checkinConfig, checkedInToday } = checkin

const pool = ref<KnowledgeCard[]>([])
const composeOpen = ref(false)
const toast = ref('')

const collectionNameOf = computed(() => {
  const map = new Map(collections.value.map((c) => [c.id, c.name]))
  return (card: KnowledgeCard) => map.get(card.collectionId) ?? '未分类'
})

/**
 * 合集 id → 在列表中的序号。
 * 用它给卡片分配颜色,保证同一页面内不同合集颜色不重复。
 */
const paletteIndexOf = computed(() => {
  const order = new Map(collections.value.map((c, i) => [c.id, i]))
  return (card: KnowledgeCard) => order.get(card.collectionId)
})

/**
 * 各合集下的待复习数量,标签右侧小字。
 *
 * 注意:只统计**当前池子里**的卡。选中某个合集时池子已被过滤,
 * 若直接用它算数量会让其他合集显示 0 —— 所以这里基于全量到期数据。
 */
/** 全量到期卡(跨全部合集,用于录入后立即入队判定)。 */
const allDue = ref<KnowledgeCard[]>([])

async function loadPool() {
  // 全量到期卡:录入时「是否属于当前范围」用它统一判断
  allDue.value = await service.loadPool(ALL_COLLECTIONS_ID, testNowMs())
  // 当前范围的复习队列
  pool.value = await service.loadPool(activeCollectionId.value, testNowMs())
}

onMounted(async () => {
  await loadAIConfig()
  await refreshCollections()
  // 冷启动:文件管理器「用 ABDrop 打开 .apkg」→ 先导入再拉池子
  await handleLaunchApkg()
  await loadPool()
  await setupCheckinReminder()
  window.addEventListener('abdrop:imported', onDataImported)
})

// ── 滑动复习 ──────────────────────────────────────────────────
async function onReview(verdict: ReviewVerdict) {
  const card = pool.value[0]
  if (!card) return
  // 先出队(动画已把卡片送走),再落库,保证界面零等待
  pool.value = pool.value.slice(1)
  allDue.value = allDue.value.filter((c) => c.id !== card.id)
  const next = await service.commitReview(card, verdict, testNowMs())

  // 全部卡片刷完 → 自动打卡(打卡已开启且今天还没打时)。
  // 语义:当天复习完成即视为"今日已打卡",无需再手动点打卡按钮。
  if (
    pool.value.length === 0 &&
    checkinConfig.value.enabled &&
    !checkedInToday.value
  ) {
    await checkin.checkIn()
    showToast('今日复习完成 · 已自动打卡')
    return
  }

  showToast(
    verdict === 'pass'
      ? `已掌握 · 下次 ${describeDue(next, Date.now())}`
      : '转入待复习',
  )
}

// ── 录入 ──────────────────────────────────────────────────────
/**
 * 打开录入框。
 *
 * 首页没有可见的录入入口(双击已移除、「录入」按钮在设置页);
 * 此函数仅由桌面调试的 Enter 键触发,正式入口是设置页的「录入知识点」按钮。
 */
function openCompose() {
  composeOpen.value = true
}

async function onSaveCard(payload: {
  sourceText: string
  front: string
  back: string
  imageUri: string
  tags: string[]
  collectionId: string
}) {
  const card = await service.addCard(
    {
      front: payload.front,
      back: payload.back,
      sourceText: payload.sourceText,
      imageUri: payload.imageUri,
      tags: payload.tags,
      collectionId: payload.collectionId,
    },
    testNowMs(),
  )
  // 新卡插到队首,但仅当它属于当前复习范围 ——
  // 否则「选了数学却能刷出刚录的英语卡」,范围就形同虚设
  const inScope = isAllScope(activeCollectionId.value) || card.collectionId === activeCollectionId.value
  allDue.value = [card, ...allDue.value]
  if (inScope) pool.value = [card, ...pool.value]
  composeOpen.value = false
  void hapticTap('light')
  showToast('已保存')
}

// ── 复习范围:切换入口已移至设置页「合集管理 → 复习范围」 ────────

// ── 轻提示 ────────────────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1600)
}

// ── 每日打卡 + 每小时提醒(设置页可配开始/结束时间) ─────────
/**
 * 提醒 = 系统后台通知:打开应用时排好今天剩余整点的通知(每小时一次),
 * 应用在后台/关闭时由系统按时发出;不做应用内弹提示。
 */
async function setupCheckinReminder() {
  await checkin.load()
  if (!checkin.config.value.enabled) return
  void checkin.scheduleNotificationsIfNeeded()
}

// ── 打开 .apkg 导入(手机文件管理器「用 ABDrop 打开」) ─────────
async function handleLaunchApkg() {
  if (typeof window === 'undefined') return
  const { isNativePlatform } = await import('~/composables/useNativeBridge')
  if (!isNativePlatform()) return
  try {
    const { App } = await import('@capacitor/app')
    const launch = await App.getLaunchUrl()
    if (!launch?.url) return
    const { importApkgFromUri } = await import('~/composables/useApkgOpen')
    const report = await importApkgFromUri(launch.url, repo)
    if (!report) return
    if (report.warnings.length && report.added === 0) {
      showToast(`导入失败:${report.warnings[0]}`)
      return
    }
    await refreshCollections()
    showToast(`已导入 ${report.added} 张卡片`)
  } catch {
    /* 原生取不到启动意图,静默 */
  }
}

/** 应用运行中收到「导入完成」事件(根组件 appUrlOpen 导入后广播)。 */
async function onDataImported() {
  await refreshCollections()
  await loadPool()
}

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
  window.removeEventListener('abdrop:imported', onDataImported)
})
</script>

<template>
  <main class="home">
    <!-- 唯一的内容:全屏卡片堆叠 -->
    <CardStack
      :cards="pool"
      :collection-name-of="collectionNameOf"
      :palette-index-of="paletteIndexOf"
      @review="onReview"
      @compose="openCompose"
    />

    <!-- 今日打卡状态标签(只读,不可点击):刷完全部卡片后自动打卡,这里反映当前状态 -->
    <Transition name="fade">
      <span
        v-if="checkinConfig.enabled"
        class="checkin"
        :class="{ 'checkin--done': checkedInToday }"
        aria-live="polite"
      >
        <span class="checkin__dot" />
        {{ checkedInToday ? '今日已打卡' : '今日未打卡' }}
      </span>
    </Transition>

    <!-- 当前复习范围:仅在锁定到单个合集时显示;切换入口在设置页 -->
    <Transition name="fade">
      <NuxtLink v-if="!isAllScope(activeCollectionId)" class="scope" to="/settings">
        <span class="scope__dot" />
        正在复习「{{ activeCollection.name }}」
        <span class="scope__hint">· 点此到设置切换</span>
      </NuxtLink>
    </Transition>

    <!-- 角落极小齿轮:唯一的设置入口 -->
    <NuxtLink class="gear" to="/settings" aria-label="设置">
      <svg viewBox="0 0 24 24" width="17" height="17">
        <path
          d="M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        />
        <path
          d="M19.4 13.6a7.7 7.7 0 0 0 0-3.2l1.7-1.3-1.9-3.3-2 .8a7.7 7.7 0 0 0-2.8-1.6L14 2.8h-3.8L9.8 5a7.7 7.7 0 0 0-2.8 1.6l-2-.8L3.1 9.1l1.7 1.3a7.7 7.7 0 0 0 0 3.2L3.1 14.9l1.9 3.3 2-.8a7.7 7.7 0 0 0 2.8 1.6l.4 2.2H14l.4-2.2a7.7 7.7 0 0 0 2.8-1.6l2 .8 1.9-3.3z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
      </svg>
    </NuxtLink>

    <!-- 录入框 -->
    <ComposeSheet
      :open="composeOpen"
      :collections="collections"
      :active-collection-id="activeCollectionId"
      :ai-config="aiConfig"
      @close="composeOpen = false"
      @save="onSaveCard"
    />

    <!-- 轻提示 -->
    <Transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </main>
</template>

<style scoped>
.home {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.scope {
  position: absolute;
  top: calc(var(--safe-top) + 12px);
  /* 长合集名时不被安全区挤压 */
  max-width: calc(100vw - var(--safe-left) - var(--safe-right) - 32px);
  overflow: hidden;
  text-overflow: ellipsis;
  left: 50%;
  transform: translateX(-50%);
  z-index: calc(var(--z-sheet) + 1);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 17px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink-1);
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: blur(16px) saturate(1.5);
  -webkit-backdrop-filter: blur(16px) saturate(1.5);
  border: 1px solid rgba(255, 255, 255, 0.85);
  box-shadow:
    0 1px 1px rgba(255, 255, 255, 0.7) inset,
    0 8px 24px rgba(15, 23, 42, 0.1);
  white-space: nowrap;
  text-decoration: none;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 160ms ease;
}

.scope:active {
  transform: translateX(-50%) scale(0.96);
}

.scope__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink-1);
  opacity: 0.55;
}

.scope__hint {
  font-size: 12px;
  color: var(--ink-3);
}

/* 今日打卡状态标签:只读,不能点击,仅反映「已打卡 / 未打卡」 */
.checkin {
  position: absolute;
  top: calc(var(--safe-top) + 10px);
  right: calc(10px + var(--safe-right));
  z-index: calc(var(--z-sheet) - 1);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100vw - var(--safe-left) - var(--safe-right) - 140px);
  padding: 9px 15px;
  border-radius: 999px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fail);
  background: rgba(255, 251, 235, 0.88);
  backdrop-filter: blur(12px) saturate(1.4);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  border: 1px solid rgba(232, 181, 60, 0.28);
  box-shadow:
    0 1px 1px rgba(255, 255, 255, 0.65) inset,
    0 6px 18px rgba(15, 23, 42, 0.1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 只读:不做点击反馈 */
  pointer-events: none;
}

.checkin__dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.85;
}

.checkin--done {
  color: var(--pass);
  background: rgba(236, 253, 245, 0.88);
  border-color: rgba(63, 191, 127, 0.3);
}

/* 极小齿轮:低对比、不抢视线,但可点区域仍够大 */
.gear {
  position: absolute;
  right: calc(10px + var(--safe-right));
  bottom: calc(6px + var(--safe-bottom));
  z-index: calc(var(--z-sheet) + 1);
  display: grid;
  place-items: center;
  /* 图标很小(视觉要求"极小"),但触摸热区放宽到 44px 手指友好 */
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--ink-3);
  opacity: 0.55;
  transition: opacity 160ms ease, transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.gear:active {
  opacity: 0.9;
  transform: scale(0.92);
}

.toast {
  position: absolute;
  left: 50%;
  bottom: calc(64px + var(--safe-bottom));
  transform: translateX(-50%);
  z-index: var(--z-toast);
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 500;
  color: var(--ink-1);
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12);
  white-space: nowrap;
  pointer-events: none;
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
