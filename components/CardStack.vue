<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
  type ComponentPublicInstance,
} from 'vue'
/**
 * CardStack —— 全屏 3D 卡片堆叠 + 全部首页手势的宿主。
 *
 * 分层结构:
 *   .stack (perspective)
 *     └ .stack__slot   ← Motion One 负责「滑出 / 补位」动画
 *         └ .stack__drag ← 手动跟手 transform(必须零延迟,不能过动画库)
 *             └ <KnowledgeCard> + 反馈徽标
 *
 * 跟手为什么不用动画库:补间库会给触摸加一帧以上延迟,直接写 transform +
 * `will-change: transform` 才能保持 60fps 的手指贴合感;而滑出/补位这类
 * 「非跟手」动画交给 Motion One,缓动统一、可中断。
 */
import { animate } from 'motion'
import type { KnowledgeCard, ReviewVerdict } from '~/types'
import {
  collectionProgress,
  commitProgress,
  constrainedOffset,
  createDragState,
  createTapDetector,
  shouldOpenCollection,
  shouldYieldToCollection,
  tiltForOffset,
  updateDrag,
  type DragState,
} from '~/lib/gesture'
import { DURATION, EASE_OUT, EASE_OUT_SOFT, EASE_SPRING, STACK, motionDuration } from '~/lib/motion'
import { hapticTap } from '~/composables/useNativeBridge'
import { paletteFor } from '~/lib/palette'
import ParticleLayer from '~/components/ParticleLayer.vue'
import { particleColor, particleCountFor } from '~/lib/particles'

const props = withDefaults(
  defineProps<{
    cards: readonly KnowledgeCard[]
    /** 合集名解析器,用于卡片角标 */
    collectionNameOf?: (card: KnowledgeCard) => string
    /** 合集序号解析器:用于无碰撞地分配卡片颜色 */
    paletteIndexOf?: (card: KnowledgeCard) => number | undefined
  }>(),
  { collectionNameOf: () => '', paletteIndexOf: () => undefined },
)

const emit = defineEmits<{
  (e: 'review', verdict: ReviewVerdict): void
  (e: 'compose'): void
  (e: 'collectionProgress', progress: number): void
  (e: 'collectionCommit'): void
}>()

const rootEl = ref<HTMLElement | null>(null)
const particleEl = ref<InstanceType<typeof ParticleLayer> | null>(null)
const slotRefs = new Map<string, HTMLElement>()
/** 正在飞出的卡片 id —— 期间屏蔽一切新手势。 */
const flyingId = ref<string | null>(null)

/**
 * 正在补位的新顶卡 id。
 *
 * 为什么需要它:飞出动画播完才 emit('review'),而那时 Vue 早已把
 * 下一张渲染成顶层且 opacity 正常 —— 如果等 watcher 再播"淡入",
 * 观感就是**新卡先亮着 → 突然消失 → 再淡入**,即肉眼可见的"闪回"。
 * 所以要在它**渲染出来的那一刻**就保持透明,交给补位动画淡入。
 */
const refillingId = ref<string | null>(null)

/** 顶层卡片是否已翻面显示答案(单击翻面)。 */
const revealed = ref(false)
/** 跟手位移(响应式,供模板与徽标使用)。 */
const dx = ref(0)
const dy = ref(0)
const progress = ref(0)
const dragging = ref(false)

/** 非响应式的手势工作区,避免每帧触发依赖收集之外的开销。 */
let drag: DragState | null = null
let pointerStartAt = 0
let mode: 'idle' | 'swipe' | 'collection' = 'idle'
let rafId = 0

const viewportWidth = () => (typeof window === 'undefined' ? 375 : window.innerWidth)
const viewportHeight = () => (typeof window === 'undefined' ? 667 : window.innerHeight)

/** 可见卡片(最多 3 层)。 */
const visibleCards = computed(() => props.cards.slice(0, STACK.visible))
const topCard = computed(() => props.cards[0] ?? null)

const tilt = computed(() => tiltForOffset(dx.value, viewportWidth()))

/** 右滑绿勾渐显进度。 */
const passProgress = computed(() => (dx.value > 0 ? progress.value : 0))
/** 左滑黄钟渐显进度。 */
const failProgress = computed(() => (dx.value < 0 ? progress.value : 0))

/**
 * 反馈徽标的缩放。
 *
 * 原来按 `0.6 + progress * 0.55` 线性放大,到进度 1 时会停在 **1.15**
 * —— 也就是"弹过头后停住",是"弹性太足"的来源之一。
 * 改为收敛到 1.0,并用缓出曲线让后段更沉。
 */
const badgeScale = computed(() => {
  const p = Math.max(passProgress.value, failProgress.value)
  // 缓出:前段长得快、后段贴近终值,不会"冲过再停"
  const eased = 1 - (1 - p) * (1 - p)
  return 0.62 + eased * 0.38
})

/**
 * 交给模板的 ref 回调。
 *
 * 关键:必须为每个 id 返回**同一个函数实例**。
 * 若在模板里写内联箭头 `:ref="(el) => setSlotRef(card.id, el)"`,
 * 每次重渲染都会产生新函数,Vue 会先以 null 调用旧函数再调用新函数 ——
 * 跟手期间每帧重渲染,就变成每帧反复解绑/绑定,带来额外开销。
 */
const slotRefHandlers = new Map<string, (el: Element | ComponentPublicInstance | null) => void>()

function slotRefFor(id: string) {
  let handler = slotRefHandlers.get(id)
  if (!handler) {
    handler = (el: Element | ComponentPublicInstance | null) => {
      if (el && el instanceof HTMLElement) slotRefs.set(id, el)
      else slotRefs.delete(id)
    }
    slotRefHandlers.set(id, handler)
  }
  return handler
}

/** 清理不再可见卡片的 ref 缓存,避免长期运行后无限增长。 */
function pruneSlotRefs(visibleIds: readonly string[]) {
  const keep = new Set(visibleIds)
  for (const id of [...slotRefHandlers.keys()]) {
    if (!keep.has(id)) {
      slotRefHandlers.delete(id)
      slotRefs.delete(id)
    }
  }
}

/**
 * 动画接管期间的**冻结位移**。
 *
 * 为什么需要:松手提交时若把内层 transform 直接清空,卡片会先跳回中央,
 * 再被飞出动画从原位移拉走 —— 观感就是"弹回来一下再飞出去"。
 * 所以这里不清空,而是冻结在动画开始那一刻的值,让位移连续。
 */
let frozenDrag: { x: number; y: number } | null = null

/** 顶层卡片 wrapper 的 transform(仅跟手,静止时为空)。 */
function dragTransform(): string {
  // 动画接管期间:保持冻结值,不清空 —— 清空会造成视觉跳变
  if (frozenDrag) {
    return `translate3d(${frozenDrag.x}px, ${frozenDrag.y}px, 0)`
  }
  if (!dragging.value && dx.value === 0 && dy.value === 0) return ''
  return `translate3d(${dx.value}px, ${dy.value}px, 0)`
}

/** 冻结当前跟手位移(动画接管前调用)。 */
function freezeDrag() {
  frozenDrag = { x: dx.value, y: dy.value }
}

/** 解除冻结(动画结束、卡片已离场后调用)。 */
function unfreezeDrag() {
  frozenDrag = null
}

// ── 手势 ──────────────────────────────────────────────────────
/**
 * 单击 = 翻面看答案(Anki 式先回忆后核对)。
 * 双击 = 唤起录入框。
 * 两者共存靠 createTapDetector 的窗口仲裁,见 lib/gesture.ts 注释。
 */
const tapDetector = createTapDetector({
  onSingleTap: () => {
    if (!topCard.value?.back) return
    revealed.value = !revealed.value
    void hapticTap('light')
  },
  onDoubleTap: () => {
    void hapticTap('light')
    emit('compose')
  },
})

function onTouchStart(e: TouchEvent) {
  if (flyingId.value) return
  const t = e.touches[0]
  if (!t) return
  drag = createDragState(t.clientX, t.clientY)
  pointerStartAt = performance.now()
  mode = 'idle'
  dragging.value = true
}

function onTouchMove(e: TouchEvent) {
  if (!drag || flyingId.value) return
  const t = e.touches[0]
  if (!t) return

  drag = updateDrag(drag, t.clientX, t.clientY)
  const vw = viewportWidth()

  // 方向锁判定:顶部边缘起手且纵向为主 → 让位给合集栏
  if (mode === 'idle' && drag.locked !== 'none') {
    if (shouldYieldToCollection(drag.startY, drag.dx, drag.dy, viewportHeight())) {
      mode = 'collection'
    } else if (drag.locked === 'horizontal') {
      mode = 'swipe'
    } else {
      // 纵向下拉但不在顶部边缘 —— 直接吞掉,不产生任何位移
      mode = 'idle'
      drag = null
      dragging.value = false
      return
    }
  }

  if (mode === 'collection') {
    // 只在向下时给反馈,向上回弹归零
    const p = collectionProgress(Math.max(drag.dy, 0))
    emit('collectionProgress', p)
    e.preventDefault()
    return
  }

  if (mode === 'swipe') {
    const { dx: cdx, dy: cdy } = constrainedOffset(drag)
    // 先算好目标值,再交给 rAF 批量写入 —— 见 scheduleRender 注释
    pendingOffset = {
      dx: applyResistance(cdx, vw),
      dy: cdy * 0.25,
      progress: commitProgress(cdx, vw),
    }
    scheduleRender()
    e.preventDefault()
  }
}

/**
 * 跟手位移的待写入值。
 *
 * 触摸事件在 120Hz 屏或快速滑动时可能一帧触发多次;若每次都直接
 * 写响应式值,会在一帧内触发多次重排/重绘,表现就是"不丝滑"。
 * 这里把写入收敛到每帧一次(rAF),是跟手流畅度的关键。
 */
let pendingOffset: { dx: number; dy: number; progress: number } | null = null

let renderRaf = 0
function scheduleRender() {
  if (renderRaf) return
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0
    if (!pendingOffset) return
    dx.value = pendingOffset.dx
    dy.value = pendingOffset.dy
    progress.value = pendingOffset.progress
    pendingOffset = null
  })
}

/** 立即应用待写入值并取消挂起的帧(用于手势结束前取到最终值)。 */
function flushRender() {
  if (renderRaf) {
    cancelAnimationFrame(renderRaf)
    renderRaf = 0
  }
  if (pendingOffset) {
    dx.value = pendingOffset.dx
    dy.value = pendingOffset.dy
    progress.value = pendingOffset.progress
    pendingOffset = null
  }
}

/** 越过阈值后阻尼递增,避免无限拖拽。 */
function applyResistance(value: number, vw: number): number {
  const threshold = vw / 3
  const abs = Math.abs(value)
  if (abs <= threshold) return value
  const sign = Math.sign(value)
  const overshoot = abs - threshold
  // 渐进阻尼:最多再跟 55% 的额外位移
  return sign * (threshold + overshoot * 0.55)
}

function onTouchEnd(e: TouchEvent) {
  if (!drag) {
    dragging.value = false
    return
  }
  // 关键:先把挂起的 rAF 写入落定。
  // 否则快速滑动后抬手时,最后一次 touchend 的位移还没写进 dx,
  // 判定与回弹动画会用到"上一帧"的旧值 —— 这正是边缘卡顿的来源之一。
  flushRender()
  const vw = viewportWidth()
  const wasMode = mode
  const state = drag
  drag = null
  dragging.value = false

  const touch = e.changedTouches?.[0]
  const elapsed = performance.now() - pointerStartAt

  if (wasMode === 'collection') {
    const p = collectionProgress(Math.max(state.dy, 0))
    if (shouldOpenCollection(Math.max(state.dy, 0))) {
      void hapticTap('light')
      emit('collectionProgress', 1)
      emit('collectionCommit')
    } else {
      emit('collectionProgress', 0)
    }
    mode = 'idle'
    return
  }

  if (wasMode === 'swipe') {
    // ── 判定:右滑 pass / 左滑 fail ──
    const committed = Math.abs(state.dx) >= vw / 3
    if (committed) {
      void commitSwipe(state.dx > 0 ? 'pass' : 'fail')
      mode = 'idle'
      return
    }
    // 未达阈值 → 弹回
    snapBack()
    mode = 'idle'
    return
  }

  // 未形成拖拽:当作点击,交给单击/双击仲裁
  if (touch && elapsed < 260 && Math.hypot(state.dx, state.dy) < 24) {
    tapDetector.tap(touch.clientX, touch.clientY)
  } else {
    tapDetector.cancel()
  }
  mode = 'idle'
}

function onTouchCancel() {
  flushRender()
  drag = null
  dragging.value = false
  mode = 'idle'
  snapBack()
}

/** 未达阈值,卡片用弹簧回位。 */
function snapBack() {
  const id = topCard.value?.id
  const el = id ? slotRefs.get(id) : null
  const card = el?.querySelector<HTMLElement>('.stack__drag')
  const from = { x: dx.value, y: dy.value }

  if (!card) {
    // 没有可动画的元素时直接复位
    dx.value = 0
    dy.value = 0
    progress.value = 0
    return
  }

  /*
   * 回弹:冻结当前位移,再让 Motion 从冻结值播到 0。
   *
   * 用 `x`/`y` 简写而不是 transform 字符串 —— Motion 对 transform
   * 字符串关键帧的支持不可靠(实测不推进),简写是原生、可靠的能力。
   *
   * 冻结的意义:让 Vue 的 :style 绑定在动画期间输出"当前值",
   * Motion 首帧写 x=from.x 与之视觉连续,不会先跳回中央。
   */
  freezeDrag()
  progress.value = 0

  void animate(
    card,
    { x: [from.x, 0], y: [from.y, 0] },
    // 时长略延长到 300ms:过冲减小后,稍慢一点更显从容
    { duration: motionDuration(300) / 1000, ease: EASE_SPRING },
  ).finished.then(() => {
    unfreezeDrag()
    dx.value = 0
    dy.value = 0
  })
}

/**
 * 吸合滑出:整卡飞出屏幕 → 播报复习结果 → 下一张补位。
 * 飞出用 Motion One,位移量与旋转均由方向决定。
 */
async function commitSwipe(verdict: ReviewVerdict) {
  const card = topCard.value
  if (!card || flyingId.value) return
  flyingId.value = card.id
  revealed.value = false
  // 冻结跟手位移:内层保持原位,外层的飞出动画只负责"从此处再飞多远"
  freezeDrag()
  void hapticTap('medium')

  const el = slotRefs.get(card.id)
  const vw = viewportWidth()
  const dir = verdict === 'pass' ? 1 : -1

  // 在卡片当前位置撒出粒子,营造"消散"而非"凭空消失"
  emitParticles(el, card, dir)

  /*
   * 飞出动画作用在**外层** .stack__slot 上。
   *
   * 起点是 0 而不是当前位移:内层 .stack__drag 已被冻结在 (dx, dy),
   * 两层 transform 会叠加。若外层也从 (dx, dy) 开始,总位移会翻倍
   * —— 卡片会先向外弹一下再飞走。从 0 开始才是连续的。
   */
  const flyOut = (async () => {
    if (!el) return
    await animate(
      el as any,
      {
        // x/y/rotate/scale 简写:内层冻结位移与之叠加,起点 0 保证连续
        x: [0, dir * vw * 1.15],
        y: [0, 30],
        rotate: [0, dir * 20],
        scale: [1, 0.86],
        // 渐隐而非瞬灭:与粒子同步淡出,形成"散开"的观感
        opacity: [1, 0.85, 0],
      },
      {
        duration: motionDuration(DURATION.flyOut) / 1000,
        ease: EASE_OUT,
        // 后段才快速淡出,前段保持实体感
        times: [0, 0.35, 1],
      },
    )
  })()

  /*
   * 飞出动画与"落库通知"赛跑,并带超时兜底。
   *
   * 为什么不能简单 await 动画:
   *   复习结果必须尽快交给上层落库。若动画因任何原因挂起
   *   (页面切到后台、系统降频、动画被中断),单纯 await 会导致
   *   **这次复习永远不落库** —— 用户滑完立刻锁屏,记录就丢了。
   *   这里让等待最多持续 flyOut + 120ms,超时也照常提交。
   */
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, motionDuration(DURATION.flyOut) + 120),
  )
  await Promise.race([flyOut, timeout])

  // 复位跟手态,并把结果抛给上层(上层负责落库与出队)
  // 注意顺序:先解冻再复位 dx,否则冻结值会残留成下一次滑动的起点
  unfreezeDrag()
  dx.value = 0
  dy.value = 0
  progress.value = 0
  emit('review', verdict)

  await nextTick()
  flyingId.value = null
}

/**
 * 在卡片位置撒出消散粒子。
 *
 * 颜色取自卡片自身的合集配色(加深后的底色 + 强调色),所以粒子与卡片
 * 是同一套色系,视觉上才像"这张卡碎开了",而不是"旁边冒出一堆彩色点"。
 */
function emitParticles(el: HTMLElement | undefined, card: KnowledgeCard, direction: 1 | -1) {
  const layer = particleEl.value
  if (!layer || !el) return

  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  // 用合集序号取色,与卡片本体保持一致
  const index = props.paletteIndexOf?.(card)
  const palette = paletteFor(card.collectionId, index ?? undefined)

  layer.burst({
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    direction,
    colors: [
      particleColor(palette.tintA, palette.accent),
      particleColor(palette.tintB, palette.accent, 0.68, 0.62),
      // 强调色本身对比度已足够,直接使用
      palette.accent,
    ],
    count: particleCountFor(rect.width, rect.height),
  })
}

/**
 * 新顶层卡片补位:缩放淡入。
 * 监听队首变化触发,保证「滑出后下一张带缩放淡入补位」。
 */
watch(
  () => visibleCards.value.map((c) => c.id).join(','),
  (ids) => pruneSlotRefs(ids ? ids.split(',') : []),
)

/**
 * 飞出结束后,下一张卡进入"补位"状态。
 *
 * 用 flush: 'sync' 让状态在 DOM 更新**之前**就位 —— 否则新卡会先以
 * 完全可见的状态渲染一帧,补位动画再把它拉回透明,闪烁就是这么来的。
 */
watch(
  flyingId,
  (current, previous) => {
    if (current === null && previous !== null) {
      refillingId.value = topCard.value?.id ?? null
    }
  },
  { flush: 'sync' },
)

watch(
  () => refillingId.value,
  async (id) => {
    if (!id) return
    // 等一帧,确保元素已挂载、ref 已就绪
    await nextTick()
    const el = slotRefs.get(id)

    if (!el) {
      refillingId.value = null
      return
    }

    /*
     * 补位动画:新卡从下方轻轻浮起 + 淡入。
     *
     * 为什么用 CSS transition 而不是 Motion:
     *   实测 Motion 的 `opacity` 关键帧在此环境下不可靠 —— y/scale
     *   正常跑,opacity 却从不写入,导致卡片全程透明、最后瞬间弹出
     *   (即用户看到的"很快出现")。CSS transition 对 opacity/transform
     *   的确定性高得多,且是一次性动画,完全够用。
     *
     * 状态机:refillingId 负责"初始透明 + 浮起位",然后下一帧加
     * `.stack__slot--refilling-in` 触发过渡到正常态。
     */
    // 双 rAF:确保初始态(透明/浮起)已渲染,再加 --refilling-in 触发过渡
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add('stack__slot--refilling-in')
      })
    })

    /*
     * 收尾:清掉补位类并复位状态。
     * 加超时兜底 —— 即便 rAF 链因故中断,也不能让卡片永久停在透明态。
     */
    const finish = () => {
      if (el instanceof HTMLElement) {
        el.classList.remove('stack__slot--refilling')
        el.classList.remove('stack__slot--refilling-in')
      }
      if (refillingId.value === id) refillingId.value = null
    }

    const timeout = setTimeout(finish, motionDuration(DURATION.refill) + 200)
  },
)

/** 键盘可达性:桌面调试用 → / ← 也可以提交。 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight') void commitSwipe('pass')
  else if (e.key === 'ArrowLeft') void commitSwipe('fail')
  else if (e.key === 'Enter') emit('compose')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  cancelAnimationFrame(rafId)
  if (renderRaf) cancelAnimationFrame(renderRaf)
  particleEl.value?.stop()
  tapDetector.cancel()
})

defineExpose({ commitSwipe, snapBack, revealed, emitParticles })
</script>

<template>
  <section
    ref="rootEl"
    class="stack"
    role="group"
    aria-label="知识卡片堆叠"
    @touchstart.passive="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
    @touchcancel="onTouchCancel"
  >
    <!-- 消散粒子层:位于卡片之上,只占一个合成层 -->
    <ParticleLayer ref="particleEl" />

    <div
      v-for="(card, i) in visibleCards"
      :key="card.id"
      :ref="slotRefFor(card.id)"
      class="stack__slot gpu"
      :class="{
        'stack__slot--top': i === 0,
        'stack__slot--refilling': card.id === refillingId,
      }"
      :style="{ zIndex: 10 - i }"
    >
      <!--
        跟手 transform 只施加在**顶层**卡片上。
        若每层都绑定,拖动时三张卡会一起位移 —— 堆叠的层次感就没了,
        看起来像"整叠纸在滑"而不是"抽出最上面那张"。
      -->
      <div class="stack__drag" :style="i === 0 ? { transform: dragTransform() } : undefined">
        <KnowledgeCard
          :card="card"
          :depth="i"
          :active="i === 0"
          :revealed="i === 0 && revealed"
          :collection-name="props.collectionNameOf(card)"
          :palette-index="props.paletteIndexOf(card)"
        />

        <!-- 反馈徽标:仅顶层渲染,随跟手进度渐显 -->
        <template v-if="i === 0">
          <div
            class="badge badge--pass"
            :style="{
              opacity: passProgress,
              transform: `translate(-50%, -50%) scale(${badgeScale})`,
            }"
            aria-hidden="true"
          >
            <svg viewBox="0 0 52 52" width="54" height="54">
              <path
                d="M14 27.5 L22.5 36 L38 18"
                fill="none"
                stroke="currentColor"
                stroke-width="5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div
            class="badge badge--fail"
            :style="{
              opacity: failProgress,
              transform: `translate(-50%, -50%) scale(${badgeScale})`,
            }"
            aria-hidden="true"
          >
            <svg viewBox="0 0 52 52" width="54" height="54">
              <circle cx="26" cy="26" r="18" fill="none" stroke="currentColor" stroke-width="4" />
              <path
                d="M26 15 V27 L34 32"
                fill="none"
                stroke="currentColor"
                stroke-width="4"
                stroke-linecap="round"
              />
            </svg>
          </div>
        </template>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!visibleCards.length" class="empty">
      <p class="empty__title">暂无待复习卡片</p>
      <p class="empty__hint">双击任意空白处录入</p>
    </div>
  </section>
</template>

<style scoped>
.stack {
  position: absolute;
  inset: 0;
  /* 3D 透视:堆叠层级靠 Z 轴拉开 */
  perspective: 1200px;
  perspective-origin: 50% 40%;
  touch-action: none;
  overflow: hidden;
}

.stack__slot {
  position: absolute;
  inset: 0;
  /* 卡片实际尺寸,定义在 main.css 的 :root(唯一调参入口) */
  width: var(--card-w);
  height: var(--card-h);
  /*
   * 四边 inset:0 + margin:auto = 水平垂直居中。
   *
   * 刻意不用 transform 居中:外层 .stack__slot 正是 Motion One
   * 飞出动画的作用目标,写 translate(-50%,-50%) 会被动画覆盖,
   * 导致卡片飞出后错位。
   */
  margin: auto;
  transform-origin: 50% 90%;
}

/*
 * 补位状态机。
 *
 * 设计要点:**补位不是"从无到有淡入",而是第二张卡从它本来的位置
 * 平滑升为顶卡**。
 *
 * 第二张卡在滑出前就可见 —— 它是 scale(0.95)、下移 10px、透明度 0.88
 * 的第二层(STACK 常量对应:scaleStep=0.05 / offsetStep=10 / opacityStep=0.12)。
 * 若补位从 opacity:0 开始,等于让这张卡先"消失"再"重新出现",观感生硬。
 * 正确做法:初始态 = 第二层的视觉状态,过渡到顶卡状态 —— 它只是"被推上来"。
 *
 * --refilling    :初始态。无过渡,瞬间到位(不闪一帧)。
 * --refilling-in :下一帧加上 → 420ms 过渡到顶卡。
 */
.stack__slot--refilling {
  opacity: 0.88;
  transform: translateY(10px) scale(0.95);
  transition: none;
}

.stack__slot--refilling-in {
  opacity: 1;
  transform: translateY(0) scale(1);
  transition: opacity 420ms cubic-bezier(0.16, 0.84, 0.22, 1),
    transform 420ms cubic-bezier(0.16, 0.84, 0.22, 1);
}



/* 横屏:透视拉近一点,避免小卡片上视差过冲 */
@media (orientation: landscape) and (max-height: 500px) {
  .stack {
    perspective: 900px;
  }

  .empty {
    gap: 4px;
  }

  .empty__title {
    font-size: 17px;
  }
}

.stack__drag {
  position: absolute;
  inset: 0;
  will-change: transform;
  transform-origin: 50% 90%;
}

/* 反馈徽标:居中出现,颜色只在图标上 */
.badge {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  place-items: center;
  width: 108px;
  height: 108px;
  border-radius: 50%;
  pointer-events: none;
  will-change: opacity, transform;
}

.badge--pass {
  color: var(--pass);
  /* 半透明实色即可;不用 backdrop-filter ——
     它位于被拖动的卡片内,每帧重算模糊会直接拖慢跟手 */
  background: rgba(63, 191, 127, 0.16);
  border: 1.5px solid rgba(63, 191, 127, 0.35);
}

.badge--fail {
  color: var(--fail);
  background: rgba(232, 181, 60, 0.18);
  border: 1.5px solid rgba(232, 181, 60, 0.38);
}

.empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  /* 容器整体不拦截手势(否则会挡住双击录入),仅按钮自身可点 */
  pointer-events: none;
}

.empty__title {
  margin: 0;
  font-size: 20px;
  color: var(--ink-2);
  font-weight: 600;
}

.empty__hint {
  margin: 0;
  font-size: 15px;
  color: var(--ink-3);
}
</style>
