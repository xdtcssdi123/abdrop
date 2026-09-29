/**
 * 动效工具 —— Motion One 的统一封装。
 *
 * 全部动画集中在此,组件不散落 magic number。
 * 统一缓动/时长,是"60 帧跟手"与视觉一致性的前提。
 */

/** 标准减速缓动,无过冲。用于滑出、补位等"不该有回弹"的动画。 */
export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1]

/**
 * 更柔和的减速缓动。
 *
 * 与 EASE_OUT 相比,起始段加速略快、结束段减速更早 ——
 * 用在补位动画上,观感是"缓"而不是"冲"。
 */
export const EASE_OUT_SOFT: [number, number, number, number] = [0.16, 0.84, 0.22, 1]

/**
 * 回弹缓动(带轻微过冲),用于"松手后归位"。
 *
 * 过冲量由**第二控制点的 y**(即第 4 个参数)决定,第一控制点的 y
 * 只影响起步加速。实测:
 *   y2 = 1.56 → 过冲 14.5%  (弹跳明显,像橡皮筋)
 *   y2 = 1.40 → 过冲  8.9%
 *   y2 = 1.30 → 过冲  5.7%
 *   y2 = 1.22 → 过冲  3.5%  ← 采用:保留一点"活着"的手感,但不弹跳
 *   y2 = 1.16 → 过冲  2.0%  (几乎察觉不到回弹)
 *
 * 注意:这是 cubic-bezier 近似,不是真实弹簧 —— 只过冲一次即收敛。
 * 若要更"物理"的手感,应改用 Motion 的 `type: 'spring'`。
 */
export const EASE_SPRING: [number, number, number, number] = [0.34, 0.34, 0.64, 1.22]

/** 时长常量(ms)。 */
export const DURATION = {
  /** 卡片补位:延长到 420ms,给"浮起"的缓动足够时间展开 */
  refill: 420,
  /** 滑出屏幕 */
  flyOut: 260,
  /** 反馈图标浮现 */
  badge: 220,
  /** 合集栏 */
  collection: 280,
  /** 录入框 */
  compose: 260,
  /** 设置页 */
  settings: 240,
} as const

/**
 * 卡片堆叠的视觉常量 —— 全项目唯一的调参入口。
 *
 * 组件只消费这些值,不写字面量。这样"卡片偏大/偏小""层次感不够"
 * 这类调整只需改这一处,不会出现组件之间数值不一致。
 */
export const STACK = {
  /** 最多渲染几张卡片(3D 透视下超过 3 张几乎不可见) */
  visible: 3,
  /** 每深一层缩放(0.05 → 第三层约 90%) */
  scaleStep: 0.05,
  /** 每深一层下移(px) */
  offsetStep: 10,
  /** 每深一层旋转(deg) */
  rotateStep: 1.2,
  /** 每深一层沿 Z 轴后退(px),配合外层 perspective 产生纵深 */
  depthStep: 40,
  /** 顶层卡片圆角 */
  radius: 12,
  /** 阴影:基础模糊半径与每层增量 */
  shadowBlur: 18,
  shadowBlurStep: 10,
  /** 阴影:基础透明度与每层增量 */
  shadowAlpha: 0.1,
  shadowAlphaStep: 0.05,
  /** 每深一层的透明度衰减 */
  opacityStep: 0.12,
} as const

/**
 * 动效降级:系统偏好减少动态效果 / 低端机时,动效时长压到最低。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 依据用户偏好返回实际时长。 */
export function motionDuration(ms: number): number {
  return prefersReducedMotion() ? Math.min(ms, 120) : ms
}
