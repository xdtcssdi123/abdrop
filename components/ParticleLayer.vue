<script setup lang="ts">
/**
 * ParticleLayer —— 卡片消散效果的 canvas 渲染层。
 *
 * 设计要点:
 *   1. **canvas 而非 DOM**:上百个粒子若用 DOM,就是上百个节点参与合成,
 *      会把上一轮优化掉的性能还回去。canvas 只占一个合成层。
 *   2. **用完即停**:没有粒子时立刻 cancelAnimationFrame 并隐藏 canvas,
 *      空闲时零开销。
 *   3. **按需创建**:首次触发才创建 canvas 与 2D context,避免拖慢首屏。
 *   4. **尊重减弱动效偏好**:系统开启 prefers-reduced-motion 时不播放。
 *
 * 粒子物理在 `lib/particles.ts`,本组件只负责画。
 */
import { ref, onBeforeUnmount } from 'vue'
import {
  capLiveParticles,
  createBurst,
  particleOpacity,
  particleSize,
  stepParticles,
  type Particle,
} from '~/lib/particles'
import { prefersReducedMotion } from '~/lib/motion'

const canvasEl = ref<HTMLCanvasElement | null>(null)
/** 隐藏 canvas 时用 visibility 而非 display,避免重排 */
const active = ref(false)

let ctx: CanvasRenderingContext2D | null = null
let particles: Particle[] = []
let raf = 0
let lastTime = 0
/** 画布尺寸(已按 DPR 放大) */
let canvasW = 0
let canvasH = 0

/** 确保 canvas 与设备像素比匹配。 */
function ensureCanvas(): CanvasRenderingContext2D | null {
  const canvas = canvasEl.value
  if (!canvas) return null

  const dpr = Math.min(window.devicePixelRatio || 1, 2) // 上限 2:再高收益极小、代价陡增
  const w = window.innerWidth
  const h = window.innerHeight

  if (canvasW !== w || canvasH !== h) {
    canvasW = w
    canvasH = h
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx = canvas.getContext('2d')
    // 用 DPR 缩放一次,之后绘制直接用 CSS 像素坐标
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  } else if (!ctx) {
    ctx = canvas.getContext('2d')
  }

  return ctx
}

/** 绘制一帧。 */
function draw() {
  const context = ctx
  if (!context) return

  context.clearRect(0, 0, canvasW, canvasH)

  for (const p of particles) {
    if (p.age >= p.life) continue
    const alpha = particleOpacity(p)
    if (alpha <= 0.01) continue

    const size = particleSize(p)
    context.globalAlpha = alpha
    context.fillStyle = p.color

    // 有旋转时走 transform,否则直接 fillRect(更快)
    if (p.vr !== 0) {
      context.save()
      context.translate(p.x, p.y)
      context.rotate(p.rot)
      context.fillRect(-size / 2, -size / 2, size, size)
      context.restore()
    } else {
      context.fillRect(p.x - size / 2, p.y - size / 2, size, size)
    }
  }

  context.globalAlpha = 1
}

/** 主循环。 */
function loop(time: number) {
  // 首帧没有基准时间,补一个近似 16ms 的步长
  const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0.016
  lastTime = time

  const alive = stepParticles(particles, dt)
  draw()

  if (alive) {
    raf = requestAnimationFrame(loop)
  } else {
    // 全部消亡:停帧、清画布、隐藏
    raf = 0
    lastTime = 0
    particles = []
    ctx?.clearRect(0, 0, canvasW, canvasH)
    active.value = false
  }
}

export interface BurstParams {
  /** 卡片矩形(视口坐标) */
  rect: { x: number; y: number; width: number; height: number }
  /** 滑出方向 */
  direction: 1 | -1
  /** 配色(通常由合集决定) */
  colors: readonly string[]
  /** 粒子数;不传按面积自动推导 */
  count?: number
}

/**
 * 在指定矩形处触发一次消散。
 *
 * 可重入:连续滑动时把新粒子追加进现有系统,不打断已有动画。
 */
function burst(params: BurstParams): void {
  if (prefersReducedMotion()) return
  if (typeof window === 'undefined') return

  const context = ensureCanvas()
  if (!context) return

  const fresh = createBurst({
    rect: params.rect,
    direction: params.direction,
    colors: params.colors,
    count: params.count,
    // 用时间做种子:每次消散的形态都不同,又不依赖 Math.random 的可测性
    seed: (Date.now() ^ (params.rect.x * 31)) >>> 0,
  })

  // 裁剪总量:快速连滑时防止粒子无限累积拖垮帧率
  particles = capLiveParticles(particles.concat(fresh))
  active.value = true

  if (!raf) {
    lastTime = 0
    raf = requestAnimationFrame(loop)
  }
}

/** 立即停止并清空(用于页面切换/卸载)。 */
function stop(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  lastTime = 0
  particles = []
  ctx?.clearRect(0, 0, canvasW, canvasH)
  active.value = false
}

onBeforeUnmount(stop)

defineExpose({ burst, stop })
</script>

<template>
  <canvas
    ref="canvasEl"
    class="particles"
    :class="{ 'particles--on': active }"
    aria-hidden="true"
  />
</template>

<style scoped>
.particles {
  position: absolute;
  inset: 0;
  /*
   * 层级必须高于卡片(.stack__slot 用 z-index 10 - depth,最高 10)。
   * 曾经写成 5,粒子被卡片整个盖住 —— 完全看不见效果。
   */
  z-index: 20;
  pointer-events: none;
  /* 隐藏用 visibility:不参与绘制,也不触发重排 */
  visibility: hidden;
}

.particles--on {
  visibility: visible;
}
</style>
