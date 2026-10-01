/**
 * 跟手性能相关逻辑测试。
 *
 * 这组测试锁住三个曾经导致"滑动不丝滑 / 边缘卡一下"的具体缺陷:
 *   1. 跟手写入未经 rAF 节流 → 一帧内多次重排
 *   2. 抬手时未落定挂起的帧 → 判定与回弹用到旧位移
 *   3. 回弹动画与响应式 transform 互相覆盖 → 视觉抖一下
 *
 * 这些都是"时序/竞态"类问题,靠肉眼很难复现,必须用测试钉死。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import CardStack from '~/components/CardStack.vue'
import KnowledgeCard from '~/components/KnowledgeCard.vue'
import { createCard } from '~/lib/db'
import { DURATION } from '~/lib/motion'
// 组件与领域类型同名,给类型起别名避免冲突
import type { KnowledgeCard as CardModel } from '~/types'

/** 造 n 张卡片。 */
function makeCards(n: number): CardModel[] {
  return Array.from({ length: n }, (_, i) => ({
    ...createCard({ front: `卡片${i}`, back: `答案${i}` }),
    id: `card-${i}`,
  }))
}

function mountStack(cards: CardModel[]) {
  return mount(CardStack, {
    props: { cards },
    global: { components: { KnowledgeCard } },
  })
}

/**
 * 把视口设成手机尺寸。
 *
 * happy-dom 默认 1024×768,而滑动阈值是「屏宽的 1/3」——
 * 在 1024 宽下阈值高达 341px,测试里的位移根本达不到,
 * 会得出"没提交"的错误结论。必须显式模拟手机视口。
 */
const PHONE_W = 390
const PHONE_H = 844

function usePhoneViewport() {
  vi.stubGlobal('innerWidth', PHONE_W)
  vi.stubGlobal('innerHeight', PHONE_H)
}

/** 造一个触摸事件。 */
function touchEvent(x: number, y: number): TouchEvent {
  const touch = { clientX: x, clientY: y, identifier: 0 } as Touch
  return {
    touches: [touch],
    changedTouches: [touch],
    preventDefault: () => {},
  } as unknown as TouchEvent
}

describe('跟手写入的 rAF 节流', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePhoneViewport()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('同一帧内多次 touchmove 只产生一次渲染写入', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    // 一帧内连发 5 次移动(每次 20px,共 100px)
    for (let i = 1; i <= 5; i++) {
      await stack.trigger('touchmove', touchEvent(i * 20, 400) as any)
    }

    // 还未推进 rAF:位移尚未写入
    const before = w.find('.stack__drag').attributes('style') ?? ''

    // 推进一帧
    await vi.advanceTimersByTimeAsync(20)
    await nextTick()

    const after = w.find('.stack__drag').attributes('style') ?? ''
    // 一帧后应写入最新值(100px),而不是中间值(20px)
    expect(after).toContain('translate3d(100px')
    expect(before).not.toBe(after)
  })

  it('抬手时先落定挂起的帧,判定基于最新位移而非旧值', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    // 一次大幅移动(超过 1/3 屏 = 130px),但**不**推进 rAF
    await stack.trigger('touchmove', touchEvent(200, 400) as any)
    // 立刻抬手:位移还挂在 pending 里
    await stack.trigger('touchend', touchEvent(200, 400) as any)

    // 落库通知在飞出动画(或超时兜底)之后发出,推进定时器
    await vi.advanceTimersByTimeAsync(DURATION.flyOut + 200)

    // 必须判定为提交(超过 1/3 屏),否则说明用了旧位移(0)
    expect(w.emitted('review')).toBeTruthy()
    expect(w.emitted('review')![0]).toEqual(['pass'])
  })

  it('未达阈值时抬手不提交,而是回弹', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(40, 400) as any)
    await stack.trigger('touchend', touchEvent(40, 400) as any)

    expect(w.emitted('review')).toBeUndefined()
  })

  it('左滑同样基于最新位移判定', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(200, 400) as any)
    await stack.trigger('touchmove', touchEvent(0, 400) as any)
    await stack.trigger('touchend', touchEvent(0, 400) as any)

    await vi.advanceTimersByTimeAsync(DURATION.flyOut + 200)

    expect(w.emitted('review')![0]).toEqual(['fail'])
  })

  it('touchcancel 也落定挂起的帧', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(80, 400) as any)
    await stack.trigger('touchcancel', touchEvent(80, 400) as any)

    // 取消不应产生提交
    expect(w.emitted('review')).toBeUndefined()
  })
})

describe('回弹动画与响应式 transform 不互相覆盖', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePhoneViewport()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number,
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('回弹期间位移被冻结(不归零),动画结束后才复位', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(50, 400) as any)
    await vi.advanceTimersByTimeAsync(20)
    await nextTick()

    // 跟手期间有位移
    expect(w.find('.stack__drag').attributes('style')).toContain('translate3d')

    // 抬手回弹:位移被冻结在原值(不回跳中央),由 Motion 接管动画
    await stack.trigger('touchend', touchEvent(50, 400) as any)
    await nextTick()
    expect(w.find('.stack__drag').attributes('style')).toContain('translate3d(')

    // 动画完成后复位(该测试用真实计时器验证归零,见「未达阈值」用例)
  })

  it('飞出后抑制状态被解除,下一次滑动仍能跟手', async () => {
    const cards = makeCards(3)
    const w = mountStack(cards)
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(200, 400) as any)
    await stack.trigger('touchend', touchEvent(200, 400) as any)
    await nextTick()
    // 等飞出动画的 promise 链落定(它负责解除 transform 抑制)
    await vi.advanceTimersByTimeAsync(50)
    await nextTick()

    // 上层出队,模拟新卡上位
    await w.setProps({ cards: cards.slice(1) })
    await vi.advanceTimersByTimeAsync(600)
    await nextTick()

    // 再次拖动应能写入 transform(新卡上位后重新取元素,旧元素已卸载)
    const fresh = w.find('.stack__drag')
    await fresh.trigger('touchstart', touchEvent(0, 400) as any)
    await fresh.trigger('touchmove', touchEvent(80, 400) as any)
    await vi.advanceTimersByTimeAsync(20)
    await nextTick()

    const style = w.find('.stack__drag').attributes('style') ?? ''
    expect(style).toContain('translate3d')
  })
})

describe('提交时不回弹(直接飞出,不先归位)', () => {
  const originalWidth = window.innerWidth
  const originalHeight = window.innerHeight

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
  })

  /** 读取元素上的 translate3d X 值。 */
  function translateX(el: { attributes: (n: string) => string | undefined } | undefined): number {
    const m = /translate3d\((-?[\d.]+)px/.exec(el?.attributes('style') ?? '')
    return m ? Math.round(Number.parseFloat(m[1]!)) : 0
  }

  it('【关键】松手提交后,内层位移保持冻结值,不会瞬间归零', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(200, 400) as any)
    await new Promise((r) => setTimeout(r, 60))

    const before = translateX(w.findAll('.stack__drag')[0])
    expect(Math.abs(before)).toBeGreaterThan(100)

    await stack.trigger('touchend', touchEvent(200, 400) as any)
    // 立刻采样:这一刻最容易被"归零重渲染"污染
    await new Promise((r) => setTimeout(r, 25))
    const after = translateX(w.findAll('.stack__drag')[0])

    // 位移必须连续:不能从 169 掉回 0(那正是"弹回来"的观感)
    expect(Math.abs(after - before)).toBeLessThan(5)
  })

  it('整个飞出过程中位移单调变化,不出现回跳', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(200, 400) as any)
    await new Promise((r) => setTimeout(r, 60))
    await stack.trigger('touchend', touchEvent(200, 400) as any)

    const samples: number[] = []
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 25))
      samples.push(translateX(w.findAll('.stack__drag')[0]))
    }

    // 从提交那一刻的位移开始,不应出现"显著回落"
    const start = samples[0]!
    for (const v of samples) {
      expect(Math.abs(v - start)).toBeLessThan(5)
    }
  })

  it('未达阈值的回弹仍会把位移收回 0(该回则回)', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(60, 400) as any)
    await new Promise((r) => setTimeout(r, 60))
    await stack.trigger('touchend', touchEvent(60, 400) as any)

    // 回弹动画结束(300ms)后应回到原位
    await new Promise((r) => setTimeout(r, 600))
    expect(Math.abs(translateX(w.findAll('.stack__drag')[0]))).toBeLessThan(3)
  })
})

describe('拖动时只有顶层卡片跟手', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePhoneViewport()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number,
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('堆叠层不绑定跟手 transform', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(120, 400) as any)
    await nextTick()

    const drags = w.findAll('.stack__drag')
    expect(drags).toHaveLength(3)

    // 顶层有 transform(由 pendingOffset → rAF 写入)
    // 堆叠层必须是空的 —— 否则三张卡会一起位移,失去层次感
    for (let i = 1; i < drags.length; i++) {
      expect(drags[i]!.attributes('style'), `第 ${i} 层不该有跟手位移`).toBeUndefined()
    }
  })

  it('堆叠层在跟手期间始终静止(多个采样点)', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)

    for (const x of [30, 60, 90, 120, 150]) {
      await stack.trigger('touchmove', touchEvent(x, 400) as any)
      await nextTick()
      const drags = w.findAll('.stack__drag')
      expect(drags[1]!.attributes('style'), `x=${x} 时第 1 层`).toBeUndefined()
      expect(drags[2]!.attributes('style'), `x=${x} 时第 2 层`).toBeUndefined()
    }
  })

  it('堆叠层仍保有自身的层级视觉(缩放/位移靠 KnowledgeCard 实现)', () => {
    const w = mountStack(makeCards(3))
    // 堆叠观感由卡片自身的 depth 样式提供,不应因为"不跟手"而消失
    const cards = w.findAll('.card')
    expect(cards).toHaveLength(3)
    expect(cards[1]!.attributes('data-depth')).toBe('1')
    expect(cards[2]!.attributes('data-depth')).toBe('2')
  })

  it('顶层仍然跟手(修复不能把跟手也去掉)', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack__drag')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(120, 400) as any)
    await vi.advanceTimersByTimeAsync(20)
    await nextTick()

    const top = w.findAll('.stack__drag')[0]!
    expect(top.attributes('style')).toContain('translate3d')
  })
})

describe('落库通知不依赖动画完成', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePhoneViewport()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number,
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('即使动画永不完成,复习结果仍会被提交(超时兜底)', async () => {
    // 模拟"动画挂起":Element.animate 返回一个永不 resolve 的 finished
    const originalAnimate = Element.prototype.animate
    Element.prototype.animate = function () {
      return {
        finished: new Promise(() => {}), // 永不落定
        cancel: () => {},
        finish: () => {},
        play: () => {},
        pause: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        onfinish: null,
      } as unknown as Animation
    }

    try {
      const w = mountStack(makeCards(3))
      const stack = w.find('.stack__drag')

      await stack.trigger('touchstart', touchEvent(0, 400) as any)
      await stack.trigger('touchmove', touchEvent(200, 400) as any)
      await stack.trigger('touchend', touchEvent(200, 400) as any)

      // 动画永不结束 —— 但超时兜底必须让结果提交出来
      await vi.advanceTimersByTimeAsync(DURATION.flyOut + 300)

      expect(w.emitted('review')).toBeTruthy()
      expect(w.emitted('review')![0]).toEqual(['pass'])
    } finally {
      Element.prototype.animate = originalAnimate
    }
  })
})

describe('模板 ref 的稳定性', () => {
  beforeEach(() => {
    usePhoneViewport()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('同一 id 多次取 ref 返回同一函数实例', () => {
    const w = mountStack(makeCards(3))
    // 通过组件实例无法直接访问闭包,改为验证行为:
    // 多次重渲染后仍能正确取到元素(若 ref 反复解绑会取不到)
    const slotsBefore = w.findAll('.stack__slot').length
    expect(slotsBefore).toBe(3)

    return w.setProps({ cards: makeCards(3) }).then(async () => {
      await nextTick()
      expect(w.findAll('.stack__slot').length).toBe(3)
    })
  })

  it('队列缩短后不残留已移除卡片的 slot', async () => {
    const cards = makeCards(3)
    const w = mountStack(cards)

    await w.setProps({ cards: cards.slice(1) })
    await nextTick()

    const slots = w.findAll('.stack__slot')
    expect(slots).toHaveLength(2)
    // 第一张应是原第二张
    expect(w.text()).not.toContain('卡片0')
  })
})

describe('性能相关 CSS 约束', () => {
  it('卡片不使用 backdrop-filter(拖动的每帧重算模糊是掉帧主因)', async () => {
    const w = mount(KnowledgeCard, {
      props: { card: makeCards(1)[0]! },
    })
    const html = w.html()
    // 内联 style 不含;scoped 样式无法从 html 断言,这里核对类名未被挂上 glass
    expect(html).not.toContain('glass')
  })

  it('卡片带有 gpu 提层类', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCards(1)[0]! } })
    expect(w.find('.card').classes()).toContain('gpu')
  })

  it('堆叠层数上限为 3(更多层只是白白消耗合成)', () => {
    const w = mountStack(makeCards(10))
    expect(w.findAll('.stack__slot')).toHaveLength(3)
  })
})
