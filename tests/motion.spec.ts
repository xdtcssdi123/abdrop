/**
 * 缓动手感测试。
 *
 * 「弹性太足」是个主观描述,但它在 cubic-bezier 上是**可量化的**:
 * 曲线输出峰值超过 1 的部分就是过冲量(动画会冲过目标位置再回来)。
 *
 * 这组测试把过冲量钉在合理区间:既能通过测试守住"不许变弹",
 * 也防止将来有人为了"更活泼"把参数又调回去。
 */
import { describe, expect, it } from 'vitest'
import { DURATION, EASE_OUT, EASE_SPRING, STACK, motionDuration } from '~/lib/motion'

/** 三次贝塞尔在参数 t 处的 y 值。 */
function bezierY(t: number, y1: number, y2: number): number {
  const mt = 1 - t
  return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t
}

/** 三次贝塞尔在参数 t 处的 x 值。 */
function bezierX(t: number, x1: number, x2: number): number {
  const mt = 1 - t
  return 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t
}

/** 由 x 反解 t(牛顿迭代)。 */
function solveT(x: number, x1: number, x2: number): number {
  let t = x
  for (let i = 0; i < 20; i++) {
    const dx = bezierX(t, x1, x2) - x
    if (Math.abs(dx) < 1e-9) break
    const mt = 1 - t
    const d = 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2)
    if (Math.abs(d) < 1e-9) break
    t = Math.max(0, Math.min(1, t - dx / d))
  }
  return t
}

/** 采样曲线,返回峰值与对应的 x 位置。 */
function analyze(curve: readonly [number, number, number, number]) {
  const [x1, y1, x2, y2] = curve
  let max = 0
  let maxAt = 0
  for (let i = 0; i <= 2000; i++) {
    const x = i / 2000
    const y = bezierY(solveT(x, x1, x2), y1, y2)
    if (y > max) {
      max = y
      maxAt = x
    }
  }
  return { max, maxAt, overshoot: max - 1 }
}

describe('EASE_SPRING 过冲量', () => {
  const spring = analyze(EASE_SPRING)

  it('允许轻微过冲(保留"活着"的手感)', () => {
    // 完全无过冲会显得机械
    expect(spring.overshoot).toBeGreaterThan(0)
  })

  it('【关键】过冲不超过 6%(原来的 14.5% 太弹)', () => {
    expect(spring.overshoot).toBeLessThan(0.06)
  })

  it('过冲不低于 1%(太小的过冲等于没有回弹)', () => {
    expect(spring.overshoot).toBeGreaterThan(0.01)
  })

  it('过冲出现在动画后段(先到位再轻晃,而非中途甩过)', () => {
    expect(spring.maxAt).toBeGreaterThan(0.7)
  })

  it('起点与终点精确(0 → 1)', () => {
    expect(bezierY(solveT(0, EASE_SPRING[0], EASE_SPRING[2]), EASE_SPRING[1], EASE_SPRING[3])).toBeCloseTo(0, 6)
    expect(bezierY(solveT(1, EASE_SPRING[0], EASE_SPRING[2]), EASE_SPRING[1], EASE_SPRING[3])).toBeCloseTo(1, 6)
  })

  it('曲线单调收敛,只过冲一次(不是来回弹跳)', () => {
    // 采样后半段,确认只有一次"越过 1 再回来"
    let crossings = 0
    let prevAbove = false
    for (let i = 0; i <= 2000; i++) {
      const x = i / 2000
      const y = bezierY(solveT(x, EASE_SPRING[0], EASE_SPRING[2]), EASE_SPRING[1], EASE_SPRING[3])
      const above = y > 1
      if (above && !prevAbove) crossings++
      prevAbove = above
    }
    expect(crossings).toBeLessThanOrEqual(1)
  })

  it('对比:旧参数(1.56)明显更弹 —— 防止被改回去', () => {
    const old = analyze([0.34, 1.56, 0.64, 1])
    // 旧参数实测过冲约 9.8%
    expect(old.overshoot).toBeGreaterThan(0.09)
    // 新参数应显著更收敛(至少小 2.5 倍)
    expect(spring.overshoot).toBeLessThan(old.overshoot / 2.5)
  })
})

describe('EASE_OUT 无过冲', () => {
  it('峰值恰好为 1,不会冲过目标', () => {
    const out = analyze(EASE_OUT)
    expect(out.max).toBeCloseTo(1, 4)
  })

  it('单调递增,中途不下沉', () => {
    const [x1, y1, x2, y2] = EASE_OUT
    let prev = -1
    for (let i = 0; i <= 200; i++) {
      const x = i / 200
      const y = bezierY(solveT(x, x1, x2), y1, y2)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = y
    }
  })
})

describe('动效时长', () => {
  it('各时长都在"跟得上但不急促"的区间', () => {
    for (const [name, ms] of Object.entries(DURATION)) {
      expect(ms, name).toBeGreaterThanOrEqual(200)
      // refill 有意延长到 420ms(浮起补位需要更长时间展开),其余 ≤400
      expect(ms, name).toBeLessThanOrEqual(name === 'refill' ? 450 : 400)
    }
  })

  it('滑出比补位快(先送走再迎上,顺序感)', () => {
    expect(DURATION.flyOut).toBeLessThanOrEqual(DURATION.refill)
  })

  it('reduced-motion 下时长被压到 120ms 以内', () => {
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      expect(motionDuration(1000)).toBeLessThanOrEqual(120)
    } finally {
      window.matchMedia = original
    }
  })
})

describe('堆叠视觉常量', () => {
  it('层级位移/缩放都在克制范围(过大会显得散)', () => {
    expect(STACK.scaleStep).toBeLessThanOrEqual(0.08)
    expect(STACK.offsetStep).toBeLessThanOrEqual(16)
    expect(STACK.rotateStep).toBeLessThanOrEqual(2)
  })

  it('可见层数固定为 3', () => {
    expect(STACK.visible).toBe(3)
  })
})
