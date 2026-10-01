/**
 * 移动端视口适配测试。
 *
 * 软件键盘避让是移动端网页最容易出错、又最难在真机上调试的部分,
 * 所以核心判定逻辑(`computeViewport`)必须被测试锁住。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { computeViewport, cardSizeForLandscape, startViewportTracking } from '~/composables/useViewport'

describe('computeViewport —— 键盘判定', () => {
  it('无键盘时 inset 为 0', () => {
    expect(computeViewport(800, 800)).toEqual({ keyboardInset: 0, keyboardOpen: false })
  })

  it('地址栏收起造成的小差异不被误判为键盘', () => {
    // iPhone 地址栏约 60px,低于 100px 阈值
    expect(computeViewport(800, 740)).toEqual({ keyboardInset: 0, keyboardOpen: false })
  })

  it('键盘弹出时给出真实占用高度', () => {
    const r = computeViewport(800, 460)
    expect(r.keyboardOpen).toBe(true)
    expect(r.keyboardInset).toBe(340)
  })

  it('阈值边界:刚好 100px 不算键盘,101px 算', () => {
    expect(computeViewport(800, 700).keyboardOpen).toBe(false)
    expect(computeViewport(800, 699).keyboardOpen).toBe(true)
  })

  it('可视高度大于布局高度时不产生负值', () => {
    // 某些浏览器的缩放/旋转中间态会出现这种情况
    const r = computeViewport(800, 850)
    expect(r.keyboardInset).toBe(0)
    expect(r.keyboardOpen).toBe(false)
  })

  it('取整避免小数造成 CSS 亚像素抖动', () => {
    const r = computeViewport(800.6, 460.2)
    expect(Number.isInteger(r.keyboardInset)).toBe(true)
  })
})

describe('cardSizeForLandscape —— 横屏卡片尺寸', () => {
  it('竖屏不干预(交还 CSS 默认)', () => {
    expect(cardSizeForLandscape(390, 844)).toBeNull()
    expect(cardSizeForLandscape(800, 800)).toBeNull()
  })

  it('手机横屏:高度接近整屏、宽度按 60vw 并封顶 340', () => {
    const s = cardSizeForLandscape(844, 390)
    expect(s).toEqual({ width: Math.min(844 * 0.6, 340), height: 390 - 16 })
  })

  it('大屏横屏:高度封顶 460、宽度封顶 340', () => {
    const s = cardSizeForLandscape(1920, 1080)
    expect(s).toEqual({ width: 340, height: 460 })
  })

  it('极端矮视口也不产生负高度', () => {
    const s = cardSizeForLandscape(640, 10)
    expect(s).not.toBeNull()
    expect(s!.height).toBe(0)
  })
})

describe('startViewportTracking', () => {
  const originalVV = window.visualViewport

  /** 造一个可控的 visualViewport 替身。 */
  function stubVisualViewport(height: number) {
    const listeners = new Map<string, Set<() => void>>()
    const vv = {
      height,
      width: 390,
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(fn)
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn)
      },
      /** 测试辅助:模拟键盘弹出 */
      __setHeight(next: number) {
        vv.height = next
        for (const fn of listeners.get('resize') ?? []) fn()
      },
      __listenerCount(type: string) {
        return listeners.get(type)?.size ?? 0
      },
    }
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
    return vv
  }

  beforeEach(() => {
    vi.stubGlobal('innerHeight', 800)
  })

  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
      value: originalVV,
      configurable: true,
    })
    vi.unstubAllGlobals()
    document.documentElement.style.removeProperty('--kb-inset')
    document.documentElement.style.removeProperty('--card-h')
    document.documentElement.style.removeProperty('--card-w')
    document.documentElement.classList.remove('kb-open')
  })

  it('写入 --kb-inset CSS 变量', async () => {
    stubVisualViewport(800)
    const stop = startViewportTracking()
    await new Promise((r) => requestAnimationFrame(() => r(null)))

    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('0px')
    stop()
  })

  it('键盘弹出时更新变量并打上 kb-open 标记', async () => {
    const vv = stubVisualViewport(800)
    const stop = startViewportTracking()
    await new Promise((r) => requestAnimationFrame(() => r(null)))

    vv.__setHeight(450)
    await new Promise((r) => requestAnimationFrame(() => r(null)))

    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('350px')
    expect(document.documentElement.classList.contains('kb-open')).toBe(true)
    stop()
  })

  it('键盘收起后变量归零、标记移除', async () => {
    const vv = stubVisualViewport(800)
    const stop = startViewportTracking()
    await new Promise((r) => requestAnimationFrame(() => r(null)))

    vv.__setHeight(450)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    vv.__setHeight(800)
    await new Promise((r) => requestAnimationFrame(() => r(null)))

    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('0px')
    expect(document.documentElement.classList.contains('kb-open')).toBe(false)
    stop()
  })

  it('清理函数移除全部监听,不留内存泄漏', () => {
    const vv = stubVisualViewport(800)
    const stop = startViewportTracking()
    expect(vv.__listenerCount('resize')).toBe(1)
    expect(vv.__listenerCount('scroll')).toBe(1)

    stop()
    expect(vv.__listenerCount('resize')).toBe(0)
    expect(vv.__listenerCount('scroll')).toBe(0)
  })

  it('清理函数移除 CSS 变量,避免污染后续页面', () => {
    stubVisualViewport(800)
    const stop = startViewportTracking()
    stop()
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('')
  })

  it('无 visualViewport 的环境(桌面浏览器)不崩溃', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    expect(() => {
      const stop = startViewportTracking()
      stop()
    }).not.toThrow()
  })

  it('重复启动互不干扰(各自持有独立监听)', () => {
    const vv = stubVisualViewport(800)
    const stopA = startViewportTracking()
    const stopB = startViewportTracking()
    expect(vv.__listenerCount('resize')).toBe(2)
    stopA()
    stopB()
    expect(vv.__listenerCount('resize')).toBe(0)
  })
})
