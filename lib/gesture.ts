/**
 * 手势识别引擎 —— 纯逻辑,不碰 DOM。
 *
 * 当前首页用到的手势在此收敛为可测的状态机:
 *   - 横向拖拽(跟手) → 右滑 pass / 左滑 fail
 *   - 单击/双击仲裁 → 单击翻面(双击已无业务,仅仲裁取消挂起单击)
 *
 * 仍保留下拉识别工具(shouldYieldToCollection / collectionProgress /
 * shouldOpenCollection)作为已测用的手势原语,但首页已不再消费。
 * 阈值与手势互斥规则集中在这里,组件只负责把 touch 事件喂进来。
 */

import type { ReviewVerdict } from '~/types'

/** 滑动判定阈值:屏幕宽度的 1/3。 */
export const SWIPE_THRESHOLD_RATIO = 1 / 3

/**
 * 滑动阈值绝对上限(px)。
 *
 * 完全按「宽 1/3」算的话,横屏视口宽约 844px,阈值会涨到 280px,
 * 用户要拖很远卡片才消失 —— 横竖屏手感不一致。
 * 用 min() 封顶:竖屏(390×1/3≈130px)不受影响,横屏压到与竖屏接近。
 */
export const SWIPE_THRESHOLD_MAX_PX = 150

/** 手势方向锁定的最小位移(px),低于此值不判定方向。 */
export const DIRECTION_LOCK_PX = 10

/** 双击允许的最大间隔(ms)与最大位移(px)。 */
export const DOUBLE_TAP_MS = 280
export const DOUBLE_TAP_SLOP_PX = 24

/** 顶部下拉唤起合集栏:起手必须落在屏幕顶部这个比例内。 */
export const TOP_EDGE_RATIO = 0.18

/** 合集栏下拉触发距离(px)与完全展开距离(px)。 */
export const COLLECTION_TRIGGER_PX = 48
export const COLLECTION_FULL_PX = 132

/** 判定滑动结果的阈值像素(横屏封顶,保证横竖屏手感一致)。 */
export function swipeThreshold(viewportWidth: number): number {
  return Math.min(viewportWidth * SWIPE_THRESHOLD_RATIO, SWIPE_THRESHOLD_MAX_PX)
}

/** 把横向位移映射为倾斜角(deg),用于 3D 跟手旋转。 */
export function tiltForOffset(dx: number, viewportWidth: number): number {
  const ratio = clamp(dx / viewportWidth, -1, 1)
  return ratio * 16
}

/** 把横向位移映射为卡片透明度 —— 滑得越远越淡。 */
export function opacityForOffset(dx: number, viewportWidth: number): number {
  const ratio = Math.abs(clamp(dx / viewportWidth, -1, 1))
  return 1 - ratio * 0.35
}

/** 跟手进度 0–1,超过阈值 = 1,用于对勾/时钟动效的渐显。 */
export function commitProgress(dx: number, viewportWidth: number): number {
  const threshold = swipeThreshold(viewportWidth)
  if (threshold <= 0) return 0
  return clamp(Math.abs(dx) / threshold, 0, 1)
}

/** 是否达到自动吸合(滑出)的力度。 */
export function shouldCommit(dx: number, viewportWidth: number): boolean {
  // 视口宽度未知时一律不提交,避免把任意位移判成"已滑够"
  if (!(viewportWidth > 0)) return false
  return Math.abs(dx) >= swipeThreshold(viewportWidth)
}

/** 由位移方向得到复习判定;未达阈值返回 null。 */
export function verdictForOffset(dx: number, viewportWidth: number): ReviewVerdict | null {
  if (!shouldCommit(dx, viewportWidth)) return null
  return dx > 0 ? 'pass' : 'fail'
}

/**
 * 判定本次横向拖拽是否应被"边缘手势"抢走。
 * 若起手点在顶部边缘区且纵向位移更大,则让位给合集栏。
 */
export function shouldYieldToCollection(
  startY: number,
  dx: number,
  dy: number,
  viewportHeight: number,
): boolean {
  const inTopEdge = startY <= viewportHeight * TOP_EDGE_RATIO
  return inTopEdge && dy > 0 && dy > Math.abs(dx)
}

/** 判断是否达到合集栏展开阈值;返回 0–1 的展开进度。 */
export function collectionProgress(dy: number): number {
  const usable = COLLECTION_FULL_PX - COLLECTION_TRIGGER_PX
  if (usable <= 0) return dy >= COLLECTION_TRIGGER_PX ? 1 : 0
  return clamp((dy - COLLECTION_TRIGGER_PX) / usable, 0, 1)
}

/** 下拉是否已足以"选中并自动收起"。 */
export function shouldOpenCollection(dy: number): boolean {
  return dy >= COLLECTION_TRIGGER_PX
}

/** 双击检测器工厂 —— 有状态,但状态内聚、可注入时间源。 */
export function createDoubleTapDetector(
  onDoubleTap: () => void,
  options: { now?: () => number } = {},
) {
  const now = options.now ?? (() => Date.now())
  let lastTime = 0
  let lastX = 0
  let lastY = 0

  return {
    /** 每次 tap(快速触摸抬起)调用一次。 */
    tap(x: number, y: number): void {
      const t = now()
      const dt = t - lastTime
      const moved = Math.hypot(x - lastX, y - lastY)
      if (dt <= DOUBLE_TAP_MS && moved <= DOUBLE_TAP_SLOP_PX) {
        lastTime = 0
        onDoubleTap()
        return
      }
      lastTime = t
      lastX = x
      lastY = y
    },
    /** 取消挂起的双击(比如手势升级为拖拽)。 */
    cancel(): void {
      lastTime = 0
    },
  }
}

/**
 * 单击 + 双击共存的检测器。
 *
 * 冲突根源:单击要立即响应才有手感,但等一个双击窗口又会迟滞。
 * 取舍:单击延迟一个双击窗口(280ms)后再触发 —— 卡片翻面属于
 * 「非跟手」操作,这个延迟无感;双击如今无业务(仅用于取消挂起的单击)。
 */
export function createTapDetector(
  handlers: { onSingleTap?: () => void; onDoubleTap?: () => void },
  options: { now?: () => number; schedule?: (fn: () => void, ms: number) => unknown } = {},
) {
  const now = options.now ?? (() => Date.now())
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms))

  let lastTime = 0
  let lastX = 0
  let lastY = 0
  let pending: unknown = null

  function clearPending() {
    if (pending != null) {
      clearTimeout(pending as ReturnType<typeof setTimeout>)
      pending = null
    }
  }

  return {
    tap(x: number, y: number): void {
      const t = now()
      const dt = t - lastTime
      const moved = Math.hypot(x - lastX, y - lastY)

      if (dt <= DOUBLE_TAP_MS && moved <= DOUBLE_TAP_SLOP_PX) {
        clearPending()
        lastTime = 0
        handlers.onDoubleTap?.()
        return
      }

      lastTime = t
      lastX = x
      lastY = y
      clearPending()
      if (handlers.onSingleTap) {
        pending = schedule(() => {
          pending = null
          handlers.onSingleTap?.()
        }, DOUBLE_TAP_MS)
      }
    },
    cancel(): void {
      lastTime = 0
      clearPending()
    },
  }
}

/** 累加器:把一次 touchmove 序列换算成带方向锁的位移。 */
export interface DragState {
  startX: number
  startY: number
  dx: number
  dy: number
  locked: 'none' | 'horizontal' | 'vertical'
}

export function createDragState(x: number, y: number): DragState {
  return { startX: x, startY: y, dx: 0, dy: 0, locked: 'none' }
}

/**
 * 更新拖拽状态(纯函数,返回新对象)。
 * 首次超过 DIRECTION_LOCK_PX 时锁定主轴,避免斜滑时卡片抖动。
 */
export function updateDrag(state: DragState, x: number, y: number): DragState {
  const dx = x - state.startX
  const dy = y - state.startY
  let locked = state.locked
  if (locked === 'none') {
    if (Math.abs(dx) >= DIRECTION_LOCK_PX || Math.abs(dy) >= DIRECTION_LOCK_PX) {
      locked = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
    }
  }
  return { ...state, dx, dy, locked }
}

/** 按方向锁裁掉非主轴位移,保证跟手纯净。 */
export function constrainedOffset(state: DragState): { dx: number; dy: number } {
  if (state.locked === 'horizontal') return { dx: state.dx, dy: 0 }
  if (state.locked === 'vertical') return { dx: 0, dy: state.dy }
  return { dx: 0, dy: 0 }
}

/** 工具:夹取。 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}
