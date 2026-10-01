/**
 * 手势引擎测试 —— 阈值、方向锁、双击仲裁。
 * 这些是"跟手手感"的规则来源,行为必须钉死。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  COLLECTION_FULL_PX,
  COLLECTION_TRIGGER_PX,
  DIRECTION_LOCK_PX,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  SWIPE_THRESHOLD_MAX_PX,
  SWIPE_THRESHOLD_RATIO,
  clamp,
  collectionProgress,
  commitProgress,
  constrainedOffset,
  createDoubleTapDetector,
  createDragState,
  createTapDetector,
  opacityForOffset,
  shouldCommit,
  shouldOpenCollection,
  shouldYieldToCollection,
  swipeThreshold,
  tiltForOffset,
  updateDrag,
  verdictForOffset,
} from '~/lib/gesture'

const VW = 390
const VH = 844

describe('滑动阈值 1/3 屏(横屏封顶)', () => {
  it('阈值常量为 1/3', () => {
    expect(SWIPE_THRESHOLD_RATIO).toBeCloseTo(1 / 3)
  })

  it('阈值随视口宽度换算', () => {
    expect(swipeThreshold(390)).toBeCloseTo(130)
  })

  it('横屏宽视口被绝对上限截断,避免要拖很远才生效', () => {
    // 844×1/3≈281;封顶后与竖屏手感接近
    expect(swipeThreshold(844)).toBe(SWIPE_THRESHOLD_MAX_PX)
    expect(swipeThreshold(844)).toBeLessThan(300)
    expect(SWIPE_THRESHOLD_MAX_PX).toBe(150)
  })

  it('刚好 1/3 屏即判定为提交(含边界)', () => {
    expect(shouldCommit(130, VW)).toBe(true)
    expect(shouldCommit(129.9, VW)).toBe(false)
  })

  it('反向同理,取绝对值', () => {
    expect(shouldCommit(-130, VW)).toBe(true)
    expect(shouldCommit(-129, VW)).toBe(false)
  })

  it('未达阈值不产生判定,避免误滑', () => {
    expect(verdictForOffset(50, VW)).toBeNull()
  })

  it('右滑为已掌握 pass', () => {
    expect(verdictForOffset(200, VW)).toBe('pass')
  })

  it('左滑为待复习 fail', () => {
    expect(verdictForOffset(-200, VW)).toBe('fail')
  })

  it('宽度为 0 时不误判提交', () => {
    expect(shouldCommit(10, 0)).toBe(false)
  })

  it('横屏下 150px 即可提交(手感对齐竖屏)', () => {
    expect(shouldCommit(150, 844)).toBe(true)
    expect(shouldCommit(149, 844)).toBe(false)
  })
})

describe('跟手视觉映射', () => {
  it('位移越远倾斜越大,且被夹在 ±16°', () => {
    expect(tiltForOffset(0, VW)).toBe(0)
    expect(tiltForOffset(VW / 2, VW)).toBeCloseTo(8)
    expect(tiltForOffset(VW * 5, VW)).toBe(16)
    expect(tiltForOffset(-VW * 5, VW)).toBe(-16)
  })

  it('位移越大卡片越淡,但不会完全透明', () => {
    expect(opacityForOffset(0, VW)).toBe(1)
    expect(opacityForOffset(VW * 2, VW)).toBeCloseTo(0.65)
  })

  it('commitProgress 到阈值即为 1,提供对勾/时钟的渐显驱动', () => {
    expect(commitProgress(0, VW)).toBe(0)
    expect(commitProgress(65, VW)).toBeCloseTo(0.5)
    expect(commitProgress(130, VW)).toBe(1)
    expect(commitProgress(500, VW)).toBe(1)
  })

  it('视口宽度为 0 时 commitProgress 返回 0,不会除零', () => {
    expect(commitProgress(100, 0)).toBe(0)
  })
})

describe('方向锁', () => {
  it('初始无锁,位移未超阈值仍无锁', () => {
    const s = createDragState(100, 100)
    expect(s.locked).toBe('none')
    expect(updateDrag(s, 100 + DIRECTION_LOCK_PX - 1, 100).locked).toBe('none')
  })

  it('横向位移占优时锁横向', () => {
    const s = updateDrag(createDragState(0, 0), 50, 10)
    expect(s.locked).toBe('horizontal')
  })

  it('纵向位移占优时锁纵向', () => {
    const s = updateDrag(createDragState(0, 0), 5, 60)
    expect(s.locked).toBe('vertical')
  })

  it('锁定后不再改变主轴,避免斜滑抖动', () => {
    let s = updateDrag(createDragState(0, 0), 50, 5)
    expect(s.locked).toBe('horizontal')
    s = updateDrag(s, 50, 200)
    expect(s.locked).toBe('horizontal')
  })

  it('未锁定时不给任何位移,防止误触', () => {
    expect(constrainedOffset(createDragState(0, 0))).toEqual({ dx: 0, dy: 0 })
  })

  it('横向锁定时剔除纵向分量,保证跟手纯净', () => {
    const s = updateDrag(createDragState(0, 0), 80, 30)
    expect(constrainedOffset(s)).toEqual({ dx: 80, dy: 0 })
  })

  it('纵向锁定时剔除横向分量', () => {
    const s = updateDrag(createDragState(0, 0), 10, 90)
    expect(constrainedOffset(s)).toEqual({ dx: 0, dy: 90 })
  })
})

describe('顶部下滑与横向滑动的互斥', () => {
  it('从顶部边缘起手且纵向为主 → 让位给合集栏', () => {
    expect(shouldYieldToCollection(20, 5, 40, VH)).toBe(true)
  })

  it('同样起手但在屏幕中部 → 不抢手势', () => {
    expect(shouldYieldToCollection(VH / 2, 5, 40, VH)).toBe(false)
  })

  it('顶部起手但横向为主 → 仍归卡片滑动', () => {
    expect(shouldYieldToCollection(20, 80, 30, VH)).toBe(false)
  })

  it('顶部起手但向上滑 → 不触发合集栏', () => {
    expect(shouldYieldToCollection(20, 5, -40, VH)).toBe(false)
  })
})

describe('合集栏展开', () => {
  it('未达触发距离不展开', () => {
    expect(shouldOpenCollection(COLLECTION_TRIGGER_PX - 1)).toBe(false)
  })

  it('达到触发距离即展开', () => {
    expect(shouldOpenCollection(COLLECTION_TRIGGER_PX)).toBe(true)
  })

  it('进度从触发点到全展开线性增长', () => {
    expect(collectionProgress(COLLECTION_TRIGGER_PX)).toBe(0)
    expect(collectionProgress(COLLECTION_FULL_PX)).toBe(1)
    const mid = (COLLECTION_TRIGGER_PX + COLLECTION_FULL_PX) / 2
    expect(collectionProgress(mid)).toBeCloseTo(0.5)
  })

  it('超量下拉被夹到 1', () => {
    expect(collectionProgress(9999)).toBe(1)
  })

  it('向上滑为负进度,夹到 0', () => {
    expect(collectionProgress(-50)).toBe(0)
  })
})

describe('双击检测(单双击共存仲裁)', () => {
  it('两次快速靠近的点击触发双击', () => {
    const onDouble = vi.fn()
    let t = 1000
    const d = createDoubleTapDetector(onDouble, { now: () => t })
    d.tap(100, 100)
    t += 100
    d.tap(105, 103)
    expect(onDouble).toHaveBeenCalledTimes(1)
  })

  it('超过时间窗口不算双击', () => {
    const onDouble = vi.fn()
    let t = 1000
    const d = createDoubleTapDetector(onDouble, { now: () => t })
    d.tap(100, 100)
    t += DOUBLE_TAP_MS + 20
    d.tap(100, 100)
    expect(onDouble).not.toHaveBeenCalled()
  })

  it('两次点击相距太远不算双击', () => {
    const onDouble = vi.fn()
    let t = 1000
    const d = createDoubleTapDetector(onDouble, { now: () => t })
    d.tap(10, 10)
    t += 50
    d.tap(10 + DOUBLE_TAP_SLOP_PX + 5, 10)
    expect(onDouble).not.toHaveBeenCalled()
  })

  it('双击后状态复位,第三次点击不会连锁触发', () => {
    const onDouble = vi.fn()
    let t = 1000
    const d = createDoubleTapDetector(onDouble, { now: () => t })
    d.tap(0, 0)
    t += 50
    d.tap(0, 0)
    t += 50
    d.tap(0, 0)
    expect(onDouble).toHaveBeenCalledTimes(1)
  })

  it('cancel 清掉挂起状态,拖拽后不会误判双击', () => {
    const onDouble = vi.fn()
    let t = 1000
    const d = createDoubleTapDetector(onDouble, { now: () => t })
    d.tap(0, 0)
    d.cancel()
    t += 50
    d.tap(0, 0)
    expect(onDouble).not.toHaveBeenCalled()
  })

  it('单击延迟到双击窗口之后才触发', () => {
    vi.useFakeTimers()
    try {
      const onSingle = vi.fn()
      const onDouble = vi.fn()
      const d = createTapDetector({ onSingleTap: onSingle, onDoubleTap: onDouble })
      d.tap(0, 0)
      expect(onSingle).not.toHaveBeenCalled()
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 10)
      expect(onSingle).toHaveBeenCalledTimes(1)
      expect(onDouble).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('双击时单击被取消 —— 绝不会两者都触发', () => {
    vi.useFakeTimers()
    try {
      const onSingle = vi.fn()
      const onDouble = vi.fn()
      let t = 1000
      const d = createTapDetector({ onSingleTap: onSingle, onDoubleTap: onDouble }, { now: () => t })
      d.tap(0, 0)
      t += 50
      d.tap(0, 0)
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 10)
      expect(onDouble).toHaveBeenCalledTimes(1)
      expect(onSingle).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('未提供单击回调时不排定时器(桌面端无副作用)', () => {
    vi.useFakeTimers()
    try {
      const onDouble = vi.fn()
      const d = createTapDetector({ onDoubleTap: onDouble })
      d.tap(0, 0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('clamp', () => {
  it('夹取边界', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(15, 0, 10)).toBe(10)
  })
})
