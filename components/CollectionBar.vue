<script setup lang="ts">
import { computed } from 'vue'
/**
 * CollectionBar —— 顶部下滑弹出的超薄合集标签栏。
 *
 * 行为契约:
 *   - progress 由 CardStack 的下拉手势驱动(0–1),纯 CSS 跟随,不过动画库
 *   - **一次只能选中一个范围**;选中后自动收起
 *   - 首项固定是「全部」(跨合集),其余是各个真实合集
 *   - 右侧固定一个「录入」按钮 —— 进入录入的主入口(双击空白处同样可用)
 *   - 高度极薄:始终单行,不占正文
 */
import type { Collection } from '~/types'
import { ALL_COLLECTIONS_ID, ALL_COLLECTIONS_NAME } from '~/lib/db-constants'

const props = defineProps<{
  /** 展开进度 0–1 */
  progress: number
  collections: readonly Collection[]
  activeId: string
  /** 每个合集下的到期卡片数 */
  counts?: Record<string, number>
  /** 「全部」范围下的到期总数 */
  totalCount?: number
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  /** 请求打开录入框 */
  (e: 'compose'): void
}>()

/** 卡片按压感:进度 0 时整体不可点。 */
const interactive = computed(() => props.progress > 0.5)

function onSelect(id: string) {
  if (!interactive.value) return
  emit('select', id)
}

function onCompose() {
  if (!interactive.value) return
  emit('compose')
}
</script>

<template>
  <div
    class="cbar"
    :class="{ 'cbar--live': interactive }"
    :style="{
      transform: `translateY(${(-1 + progress) * 100}%)`,
      opacity: Math.max(progress, 0),
    }"
    aria-hidden="false"
  >
    <div class="cbar__row">
      <!-- 左:横向滚动的合集标签 -->
      <div class="cbar__inner">
        <!-- 「全部」固定在首位:跨合集复习 -->
        <button
          class="cbar__chip"
          :class="{ 'cbar__chip--on': activeId === ALL_COLLECTIONS_ID }"
          type="button"
          @click="onSelect(ALL_COLLECTIONS_ID)"
        >
          {{ ALL_COLLECTIONS_NAME }}
          <span v-if="totalCount" class="cbar__count">{{ totalCount }}</span>
        </button>

        <span class="cbar__sep" aria-hidden="true" />

        <button
          v-for="col in collections"
          :key="col.id"
          class="cbar__chip"
          :class="{ 'cbar__chip--on': col.id === activeId }"
          type="button"
          @click="onSelect(col.id)"
        >
          {{ col.name }}
          <span v-if="counts?.[col.id]" class="cbar__count">{{ counts[col.id] }}</span>
        </button>
      </div>

      <!-- 右:固定不滚动的录入入口 —— 无论标签滚到哪都够得着 -->
      <button class="cbar__compose" type="button" aria-label="录入知识点" @click="onCompose">
        <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
          <path
            d="M12 5.5 V18.5 M5.5 12 H18.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
          />
        </svg>
        录入
      </button>
    </div>

    <div class="cbar__grip" />
  </div>
</template>

<style scoped>
.cbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--z-sheet);
  padding-top: var(--safe-top);
  /* 超薄:单行标签,不遮挡卡片主体 */
  background: rgba(248, 250, 251, 0.82);
  backdrop-filter: blur(16px) saturate(1.5);
  -webkit-backdrop-filter: blur(16px) saturate(1.5);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  will-change: transform, opacity;
}

/* 外层固定单行:左侧标签可滚,右侧按钮不动 */
.cbar__row {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 横屏时避让侧边刘海 */
  padding: 12px calc(16px + var(--safe-right)) 12px calc(16px + var(--safe-left));
}

.cbar__inner {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  gap: 9px;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
  /* 滚动到边缘时不产生额外的橡皮筋回弹,避免与下拉手势打架 */
  overscroll-behavior-x: contain;
}

.cbar__inner::-webkit-scrollbar {
  display: none;
}

.cbar__chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 500;
  padding: 9px 17px;
  min-height: 44px;
  border-radius: 999px;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.06);
  transition: background 160ms ease, color 160ms ease;
}

.cbar__chip--on {
  color: #fff;
  background: var(--ink-1);
}

.cbar__count {
  font-size: 13px;
  opacity: 0.72;
}

/* 「全部」与具体合集之间的细分割线 */
.cbar__sep {
  flex: 0 0 auto;
  width: 1px;
  height: 18px;
  background: rgba(27, 36, 48, 0.14);
  margin: 0 2px;
}

/* 录入入口:实色按钮,与合集标签视觉区分,是这一行唯一的主行动 */
.cbar__compose {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 18px 9px 15px;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 600;
  /* 触摸目标不低于 44px */
  min-height: 44px;
  color: #fff;
  background: var(--ink-1);
  box-shadow: 0 3px 12px rgba(15, 23, 42, 0.18);
  transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease;
}

.cbar__compose:active {
  transform: scale(0.95);
  opacity: 0.88;
}

/* 未充分展开时不可点,且视觉上给出暗示 */
.cbar:not(.cbar--live) .cbar__compose,
.cbar:not(.cbar--live) .cbar__chip {
  pointer-events: none;
}

.cbar__grip {
  width: 34px;
  height: 3px;
  border-radius: 2px;
  margin: 0 auto 6px;
  background: rgba(27, 36, 48, 0.16);
}
</style>
