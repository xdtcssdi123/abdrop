<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
/**
 * AnswerOverlay —— 全屏答案层。
 *
 * 需求:单击卡片看答案时,答案要全屏展示 —— 问题收成小标题置顶,
 * 答案正文大字可滚动,图片完整显示,不再受小卡片尺寸挤压。
 *
 * 手势:
 *   - 纵向:内容区原生滚动(pan-y)
 *   - 横向:右滑 pass / 左滑 fail,跟手位移 + 滑出动画,结束后 emit('review')
 *   - 轻点(空白处):关闭本层,回到卡片 —— 全屏查看的直觉交互
 *
 * 关闭(不产生判定,回到卡片):
 *   - 轻点面板空白处
 *   - 右上角 ✕
 *   - Android 返回键(app.vue 探测到本层存在时,关闭本层而非退出应用)
 *   - 桌面 Esc(CardStack 统一处理)
 */
import type { KnowledgeCard, ReviewVerdict } from '~/types'
import { hapticTap } from '~/composables/useNativeBridge'
import { memoryStrength, syncStateLabel } from '~/lib/srs'
import { paletteFor, paletteVars } from '~/lib/palette'
import { renderMarkdown } from '~/lib/markdown'
import { swipeThreshold } from '~/lib/gesture'
import { animate } from 'motion'
import { EASE_OUT, DURATION, motionDuration } from '~/lib/motion'

const props = withDefaults(
  defineProps<{
    card: KnowledgeCard
    collectionName?: string
    paletteIndex?: number
  }>(),
  { collectionName: '', paletteIndex: undefined },
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'review', verdict: ReviewVerdict): void
}>()

const rootEl = ref<HTMLElement | null>(null)

/** 全屏层自身的跟手位移(横向判定用)。 */
const dx = ref(0)
const dragging = ref(false)

let startX = 0
let startY = 0
let startAt = 0
/** 触摸起点目标:用于识别「点的是链接/按钮」——它们不该被轻点关闭吞掉。 */
let startTarget: EventTarget | null = null
/** 该次触摸是否发生过明显滚动(滚动不算轻点)。 */
let scrolled = false
let committed = false
let rafId = 0

const palette = paletteFor(props.card.collectionId, props.paletteIndex)
const paletteStyle = paletteVars(palette)

/** 轻点关闭的位移 / 时间阈值(与 CardStack 的 tap 判定一致)。 */
const TAP_SLOP_PX = 24
const TAP_MAX_MS = 300

function onTouchStart(e: TouchEvent) {
  // 阻断冒泡:答案层是 .stack(卡片手势容器)的子元素,不阻断的话
  // 轻点/滑动手势会漏给底层卡片,被误判成"单击卡片"→ 关闭后立刻重开。
  e.stopPropagation()
  if (committed) return
  const t = e.touches[0]
  if (!t) return
  startX = t.clientX
  startY = t.clientY
  startAt = performance.now()
  scrolled = false
  startTarget = e.target
  dragging.value = true
}

function onTouchMove(e: TouchEvent) {
  e.stopPropagation()
  if (!dragging.value || committed) return
  const t = e.touches[0]
  if (!t) return
  const deltaX = t.clientX - startX
  const deltaY = t.clientY - startY
  // 只认横向主导的手势;纵向交给内容区滚动,不参与判定
  if (Math.abs(deltaX) < Math.abs(deltaY)) {
    dx.value = 0
    // 纵向位移超过阈值视为「滚动」,不算轻点(避免滚动完抬手误关)
    if (Math.abs(deltaY) > 16) scrolled = true
    return
  }
  dx.value = deltaX
  e.preventDefault()
}

function onTouchEnd(e: TouchEvent) {
  e.stopPropagation()
  if (!dragging.value || committed) return
  dragging.value = false
  const vw = typeof window === 'undefined' ? 375 : window.innerWidth
  const current = dx.value

  // 未形成横向滑动且未滚动过:视为轻点
  if (!scrolled && Math.abs(current) < TAP_SLOP_PX) {
    // 点的是链接/按钮交给它们自己(如打开链接),这里只对空白处关闭
    const el = startTarget instanceof HTMLElement ? startTarget : null
    const interactive = el?.closest('a, button, [contenteditable]')
    if (!interactive && performance.now() - startAt < TAP_MAX_MS) {
      close()
      return
    }
  }

  if (Math.abs(current) >= swipeThreshold(vw)) {
    commit(current > 0 ? 'pass' : 'fail')
    return
  }
  // 未达阈值:回弹复位
  dx.value = 0
}

/** 滑出动画 + emit:与卡片提交共用一条 review 通道。 */
async function commit(verdict: ReviewVerdict) {
  if (committed) return
  committed = true
  void hapticTap('medium')
  const el = rootEl.value
  if (el) {
    const dir = verdict === 'pass' ? 1 : -1
    /*
     * 动画与超时赛跑:动画挂起(切后台/低端机)也必须照常提交,
     * 否则这次判定会永远丢失。与 CardStack.commitSwipe 同一策略。
     */
    const flyOut = (async () => {
      await animate(
        el as any,
        {
          x: [0, dir * (typeof window === 'undefined' ? 400 : window.innerWidth) * 1.15],
          opacity: [1, 0.6, 0],
        },
        {
          duration: motionDuration(DURATION.flyOut) / 1000,
          ease: EASE_OUT,
          times: [0, 0.35, 1],
        },
      )
    })()
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, motionDuration(DURATION.flyOut) + 120),
    )
    await Promise.race([flyOut, timeout])
  }
  emit('review', verdict)
}

function close() {
  if (committed) return
  emit('close')
}

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
})
</script>

<template>
  <div ref="rootEl" class="answer">
    <div
      class="answer__panel gpu"
      :style="{
        ...paletteStyle,
        transform: dragging ? `translateX(${dx}px)` : undefined,
      }"
      role="dialog"
      aria-modal="true"
      aria-label="答案"
      @touchstart.passive="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
    >
      <!-- 顶栏:合集色小条 + 状态 + 关闭 -->
      <header class="answer__top">
        <div class="answer__accent" />
        <span class="answer__chip">{{ collectionName || '未分类' }}</span>
        <span class="answer__state">{{ syncStateLabel(card.syncState) }}</span>
        <span class="answer__strength" :aria-label="`记忆等级 ${card.level}`">
          记忆
          {{ (memoryStrength(card.level) * 100).toFixed(0) }}%
        </span>
        <button class="answer__close" type="button" aria-label="关闭答案" @click="close">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path
              d="M6 6 L18 18 M18 6 L6 18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>

      <!-- 内容:问题小标题 + 答案正文(Markdown)+ 图片,超高可滚动 -->
      <div class="answer__body scroll-area">
        <p class="answer__front">{{ card.front || card.back }}</p>
        <div v-if="card.front && card.back && card.front !== card.back" class="answer__divider" />
        <!-- 答案按 Markdown 渲染(标题/列表/代码块等),已 HTML 转义防注入 -->
        <div
          v-if="card.front && card.back && card.front !== card.back"
          class="answer__back md-body"
          v-html="renderMarkdown(card.back)"
        />
        <img v-if="card.imageUri" class="answer__image" :src="card.imageUri" alt="知识点配图" />
      </div>

      <!-- 底部提示:左右滑动判定 -->
      <footer class="answer__foot">
        <span class="answer__hint">← 待复习</span>
        <span class="answer__hint answer__hint--strong">左右滑动判定</span>
        <span class="answer__hint">已掌握 →</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.answer {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-sheet) + 2);
}

.answer__panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  color: var(--ink-1);
  background:
    linear-gradient(155deg, var(--card-tint-a, #fdfdfe) 0%, var(--card-tint-b, #f5f7fa) 100%);
  will-change: transform, opacity;
}

/* 顶栏 */
.answer__top {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: calc(var(--safe-top) + 14px) calc(18px + var(--safe-right)) 12px
    calc(18px + var(--safe-left));
}

.answer__accent {
  width: 4px;
  align-self: stretch;
  border-radius: 2px;
  background: var(--card-accent, rgba(27, 36, 48, 0.2));
}

.answer__chip {
  font-size: 13px;
  font-weight: 600;
  color: var(--card-accent, var(--ink-2));
}

.answer__state {
  font-size: 12px;
  color: var(--ink-3);
}

.answer__strength {
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-3);
  white-space: nowrap;
}

.answer__close {
  display: grid;
  place-items: center;
  /* 44px 热区:手指友好(关闭是全屏层最重要的出口之一) */
  width: 44px;
  height: 44px;
  margin: -5px -5px 0 0;
  border-radius: 50%;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.06);
}

/* 内容 */
.answer__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px calc(22px + var(--safe-right)) 20px calc(22px + var(--safe-left));
}

.answer__front {
  margin: 0;
  font-size: 20px;
  line-height: 1.5;
  font-weight: 650;
  color: var(--ink-1);
  white-space: pre-wrap;
  word-break: break-word;
}

.answer__divider {
  width: 40px;
  height: 2px;
  border-radius: 1px;
  background: var(--card-accent, var(--ink-2));
  opacity: 0.45;
  flex: 0 0 auto;
}

.answer__back {
  margin: 0;
  font-size: 20px;
  line-height: 1.72;
  color: var(--ink-1);
  word-break: break-word;
  flex: 0 0 auto;
}

/* Markdown 块级版式由全局 .md-body 统一提供,此处只定字号/间距 */

.answer__image {
  width: 100%;
  max-height: 56dvh;
  max-height: 56vh;
  object-fit: contain;
  border-radius: 14px;
  flex: 0 0 auto;
}

/* 底部提示 */
.answer__foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px calc(22px + var(--safe-right)) calc(16px + var(--safe-bottom))
    calc(22px + var(--safe-left));
  border-top: 1px solid rgba(27, 36, 48, 0.06);
}

.answer__hint {
  font-size: 13px;
  color: var(--ink-3);
}

.answer__hint--strong {
  font-weight: 600;
  color: var(--ink-2);
}
</style>