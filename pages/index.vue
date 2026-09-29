<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
/**
 * 首页 —— 全屏卡片堆叠,除此之外什么都没有。
 *
 * 三条手势都从 CardStack 冒泡上来,由本页统一落库:
 *   左/右滑 → commitReview(调度记忆等级 + 重算复习时间)
 *   双击    → 打开录入框
 *   顶部下滑 → 弹出合集栏
 */
import { useRouter } from 'vue-router'
import type { KnowledgeCard, ReviewVerdict } from '~/types'
import { createReviewService } from '~/lib/review-service'
import { useCardRepository } from '~/lib/db'
import { useCollections, useAIConfigState } from '~/composables/useAppState'
import { hapticTap } from '~/composables/useNativeBridge'
import { ALL_COLLECTIONS_ID, isAllScope } from '~/lib/db-constants'

const router = useRouter()

const {
  collections,
  activeCollectionId,
  activeCollection,
  refresh: refreshCollections,
  select,
} = useCollections()
const { aiConfig, load: loadAIConfig } = useAIConfigState()

const repo = useCardRepository()
const service = createReviewService(repo)

const pool = ref<KnowledgeCard[]>([])
const composeOpen = ref(false)
const collectionProg = ref(0)
/** 合集栏是否已吸合固定(选完才收起) */
const collectionPinned = ref(false)
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
const allDue = ref<KnowledgeCard[]>([])

const counts = computed(() => {
  const acc: Record<string, number> = {}
  for (const card of allDue.value) {
    acc[card.collectionId] = (acc[card.collectionId] ?? 0) + 1
  }
  return acc
})

/** 「全部」范围的到期总数。 */
const totalCount = computed(() => allDue.value.length)

async function loadPool() {
  // 全量到期卡:用于合集栏角标统计(不受当前范围影响)
  allDue.value = await service.loadPool(ALL_COLLECTIONS_ID)
  // 当前范围的复习队列
  pool.value = await service.loadPool(activeCollectionId.value)
}

onMounted(async () => {
  await loadAIConfig()
  await refreshCollections()
  await loadPool()
})

// ── 滑动复习 ──────────────────────────────────────────────────
async function onReview(verdict: ReviewVerdict) {
  const card = pool.value[0]
  if (!card) return
  // 先出队(动画已把卡片送走),再落库,保证界面零等待
  pool.value = pool.value.slice(1)
  allDue.value = allDue.value.filter((c) => c.id !== card.id)
  const next = await service.commitReview(card, verdict)
  showToast(
    verdict === 'pass'
      ? `已掌握 · 下次 ${Math.round((next.nextReviewAt - Date.now()) / 86400000)} 天后`
      : '转入待复习',
  )
}

// ── 录入 ──────────────────────────────────────────────────────
/**
 * 打开录入框。
 *
 * 两个入口共用:双击空白处、顶部下滑面板里的「录入」按钮。
 * 从面板进入时先把面板收起,避免录入框与面板叠在一起。
 */
function openCompose() {
  collapseCollection()
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
  const card = await service.addCard({
    front: payload.front,
    back: payload.back,
    sourceText: payload.sourceText,
    imageUri: payload.imageUri,
    tags: payload.tags,
    collectionId: payload.collectionId,
  })
  // 新卡插到队首,但仅当它属于当前复习范围 ——
  // 否则「选了数学却能刷出刚录的英语卡」,范围就形同虚设
  const inScope = isAllScope(activeCollectionId.value) || card.collectionId === activeCollectionId.value
  allDue.value = [card, ...allDue.value]
  if (inScope) pool.value = [card, ...pool.value]
  composeOpen.value = false
  void hapticTap('light')
  showToast('已保存')
}

// ── 合集栏 ────────────────────────────────────────────────────
function onCollectionProgress(p: number) {
  if (collectionPinned.value)
    return
  collectionProg.value = p
}

function onCollectionCommit() {
  collectionPinned.value = true
  collectionProg.value = 1
}

async function onSelectCollection(id: string) {
  select(id)
  collectionPinned.value = false
  collectionProg.value = 0
  void hapticTap('light')
  await loadPool()
}

function collapseCollection() {
  collectionPinned.value = false
  collectionProg.value = 0
}

// ── 轻提示 ────────────────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1600)
}

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
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
      @collection-progress="onCollectionProgress"
      @collection-commit="onCollectionCommit"
    />

    <!-- 当前复习范围:仅在锁定到单个合集时显示,避免"全部"时多一条冗余信息 -->
    <Transition name="fade">
      <div v-if="!isAllScope(activeCollectionId)" class="scope" @click="onSelectCollection(ALL_COLLECTIONS_ID)">
        <span class="scope__dot" />
        正在复习「{{ activeCollection.name }}」
        <span class="scope__hint">· 点此切换</span>
      </div>
    </Transition>

    <!-- 合集栏遮罩:仅在吸合后出现,点空白收起 -->
    <Transition name="fade">
      <div v-if="collectionPinned" class="scrim" @click="collapseCollection" />
    </Transition>

    <!-- 超薄合集标签栏 -->
    <CollectionBar
      :progress="collectionProg"
      :collections="collections"
      :active-id="activeCollectionId"
      :counts="counts"
      :total-count="totalCount"
      @select="onSelectCollection"
      @compose="openCompose"
    />

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
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink-1);
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(14px) saturate(1.4);
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.1);
  white-space: nowrap;
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

.scrim {
  position: absolute;
  inset: 0;
  z-index: calc(var(--z-sheet) - 1);
  background: rgba(20, 28, 38, 0.16);
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
  transition: opacity 160ms ease;
}

.gear:active {
  opacity: 0.9;
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
