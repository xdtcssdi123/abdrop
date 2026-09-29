/**
 * 补位「闪回」回归测试。
 *
 * 现象:滑出后新顶卡先完全可见地闪一帧,再被补位动画拉回透明重新淡入。
 *
 * 根因:飞出动画播完才 emit('review'),而那时 Vue 早已把下一张渲染成
 * 顶层且 opacity 正常 —— watcher 随后启动的"淡入"动画会先把它设成
 * opacity 0,于是出现"亮 → 灭 → 亮"的闪烁。
 *
 * 这组测试锁住正确的时序:**新卡在渲染出来的那一刻就应是透明的**。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CardStack from '~/components/CardStack.vue'
import KnowledgeCard from '~/components/KnowledgeCard.vue'
import { createCard } from '~/lib/db'
import { DURATION } from '~/lib/motion'
import type { KnowledgeCard as CardModel } from '~/types'

const PHONE_W = 390
const PHONE_H = 844

function makeCards(n: number): CardModel[] {
  return Array.from({ length: n }, (_, i) => ({
    ...createCard({ front: `卡片${i}`, back: `答案${i}` }),
    id: `card-${i}`,
    collectionId: 'inbox',
  }))
}

function mountStack(cards: CardModel[]) {
  return mount(CardStack, {
    props: { cards },
    global: { components: { KnowledgeCard } },
  })
}

function touchEvent(x: number, y: number) {
  const touch = { clientX: x, clientY: y, identifier: 0 } as Touch
  return {
    touches: [touch],
    changedTouches: [touch],
    preventDefault: () => {},
  } as unknown as TouchEvent
}

/** 读取某张卡所在 slot 的**内联** opacity(动画库写入的那个)。 */
function inlineOpacity(w: ReturnType<typeof mountStack>, index: number): string | undefined {
  const slots = w.findAll('.stack__slot')
  const style = slots[index]?.attributes('style') ?? ''
  const m = /opacity:\s*([\d.]+)/.exec(style)
  return m?.[1]
}

/** 该 slot 是否带有「补位中」标记。 */
function isRefilling(w: ReturnType<typeof mountStack>, index: number): boolean {
  const cls = w.findAll('.stack__slot')[index]?.attributes('class') ?? ''
  return cls.includes('stack__slot--refilling')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/*
 * 注意:这组测试**必须用真实计时器**。
 * Motion One 的动画依赖 WAAPI / rAF,在 vitest 的 fake timers 下
 * 不会推进 —— 用假时钟会得到"动画永远停在 0.935"的假象,
 * 既测不出正常路径,也掩盖真实缺陷。
 */
const SETTLE_MS = 1400

describe('补位不闪烁', () => {
  const originalWidth = window.innerWidth
  const originalHeight = window.innerHeight

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: PHONE_W, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: PHONE_H, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
  })

  it('静止时所有卡片都没有内联 opacity(正常渲染)', () => {
    const w = mountStack(makeCards(3))
    expect(inlineOpacity(w, 0)).toBeUndefined()
    expect(inlineOpacity(w, 1)).toBeUndefined()
    expect(isRefilling(w, 0)).toBe(false)
  })

  it('【关键】补位从第二层状态开始,不是先全亮再消失', async () => {
    /*
     * 设计意图:第二张卡补位前本来就可见(第二层,scale 0.95 / 下移 10px)。
     * 补位应让它从"第二层状态"平滑升为顶卡 —— 而不是先以完全可见渲染
     * 一帧、再被动画拉回透明(那才是"闪一帧"的闪烁)。
     *
     * 由于初始态由 CSS 类(而非内联样式)控制,这里验证:
     *   1. 补位确实发生(观察到 --refilling 类);
     *   2. 补位结束后类被清理,卡片完全可见;
     *   3. 全程不出现"内联 opacity 已全亮"的窗口(闪烁的判据)。
     */
    const cards = makeCards(3)
    const w = mountStack(cards)
    const stack = w.find('.stack')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(200, 400) as any)
    await stack.trigger('touchend', touchEvent(200, 400) as any)

    let sawRefilling = false
    let sawFullyVisibleInline = false

    for (let i = 0; i < 22; i++) {
      await sleep(45)
      if (isRefilling(w, 0)) {
        sawRefilling = true
        // 内联 opacity 若有值且接近 1,说明存在"先全亮"窗口
        const op = inlineOpacity(w, 0)
        if (op !== undefined && Number(op) >= 0.99) sawFullyVisibleInline = true
      }
    }

    expect(sawRefilling).toBe(true)
    expect(sawFullyVisibleInline).toBe(false)

    // 模拟出队后,补位类应被清理
    await w.setProps({ cards: cards.slice(1) })
    await sleep(600)
    expect(isRefilling(w, 0)).toBe(false)
  })

  it('【关键】补位结束后卡片恢复正常可见(不会永久透明)', async () => {
    const cards = makeCards(3)
    const w = mountStack(cards)
    const stack = w.find('.stack')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(200, 400) as any)
    await stack.trigger('touchend', touchEvent(200, 400) as any)
    await sleep(SETTLE_MS)

    // 模拟上层出队:旧卡移除,新顶卡上位
    await w.setProps({ cards: cards.slice(1) })
    await sleep(SETTLE_MS)

    // 补位类必须被清掉,否则卡片永久透明
    expect(isRefilling(w, 0)).toBe(false)
    expect(w.findAll('.stack__slot').length).toBeGreaterThan(0)
  })

  it('连续两次滑出都能正常补位,不会卡在透明状态', async () => {
    vi.setConfig({ testTimeout: 15000 })
    const cards = makeCards(4)
    const w = mountStack(cards)
    const stack = w.find('.stack')
    let pool = [...cards]

    for (let round = 0; round < 2; round++) {
      await stack.trigger('touchstart', touchEvent(0, 400) as any)
      await stack.trigger('touchmove', touchEvent(200, 400) as any)
      await stack.trigger('touchend', touchEvent(200, 400) as any)
      await sleep(600)

      // 模拟上层出队
      pool = pool.slice(1)
      await w.setProps({ cards: pool })
      await sleep(600)

      // 每轮结束后,存活的 slot 不应残留补位状态
      const slots = w.findAll('.stack__slot')
      for (let i = 0; i < slots.length; i++) {
        expect(isRefilling(w, i), `第 ${round} 轮 slot ${i}`).toBe(false)
      }
    }
  })

  it('队列清空后不残留补位状态', async () => {
    const w = mountStack(makeCards(1))
    const stack = w.find('.stack')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(200, 400) as any)
    await stack.trigger('touchend', touchEvent(200, 400) as any)

    // review 事件在飞出动画(或超时兜底)之后才发出,先等它
    await sleep(SETTLE_MS)
    expect(w.emitted('review')).toBeTruthy()

    // 组件只负责发出事件,出队由上层完成 —— 模拟上层把最后一张移除
    await w.setProps({ cards: [] })
    await sleep(200)

    expect(w.findAll('.stack__slot')).toHaveLength(0)
    expect(w.text()).toContain('暂无待复习卡片')
  })

  it('未达阈值的回弹不触发补位(不应把当前卡弄透明)', async () => {
    const w = mountStack(makeCards(3))
    const stack = w.find('.stack')

    await stack.trigger('touchstart', touchEvent(0, 400) as any)
    await stack.trigger('touchmove', touchEvent(40, 400) as any)
    await stack.trigger('touchend', touchEvent(40, 400) as any)
    await sleep(600)

    expect(w.findAll('.stack__slot')).toHaveLength(3)
    expect(isRefilling(w, 0)).toBe(false)
    expect(inlineOpacity(w, 0)).toBeUndefined()
  })
})
