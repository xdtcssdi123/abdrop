/**
 * 组件测试 —— 覆盖交互与渲染契约。
 *
 * 重点验证"用户看到/摸到"的行为:卡片正反面、滑动反馈徽标、
 * 录入框校验、合集栏落位。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import KnowledgeCard from '~/components/KnowledgeCard.vue'
import CollectionBar from '~/components/CollectionBar.vue'
import { createCard } from '~/lib/db'
import { ALL_COLLECTIONS_ID } from '~/lib/db-constants'
import type { Collection, KnowledgeCard as Card, MemoryLevel } from '~/types'

function makeCard(over: Partial<Card> = {}): Card {
  return {
    ...createCard({ front: '什么是极限', back: '描述趋近过程' }),
    ...over,
  }
}

describe('KnowledgeCard 渲染', () => {
  it('显示正面内容', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard() } })
    expect(w.text()).toContain('什么是极限')
  })

  it('未翻面时不显示背面 —— 保证先回忆再看答案', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard(), active: true, revealed: false } })
    expect(w.text()).not.toContain('描述趋近过程')
    expect(w.text()).toContain('单击查看答案')
  })

  it('翻面后显示背面', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard(), active: true, revealed: true } })
    expect(w.text()).toContain('描述趋近过程')
  })

  it('非顶层卡片即使 revealed 也不显示背面(避免堆叠层泄题)', () => {
    const w = mount(KnowledgeCard, {
      props: { card: makeCard(), depth: 1, active: false, revealed: true },
    })
    expect(w.text()).not.toContain('描述趋近过程')
  })

  it('无背面时不显示"查看答案"提示', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard({ back: '' }), active: true } })
    expect(w.text()).not.toContain('单击查看答案')
  })

  it('正面为空时兜底显示背面,不出现空白卡', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard({ front: '', back: '只有答案' }) } })
    expect(w.text()).toContain('只有答案')
  })

  it('正反面都为空时显示空卡片提示', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard({ front: '', back: '' }) } })
    expect(w.text()).toContain('空卡片')
  })

  it('显示合集名', () => {
    const w = mount(KnowledgeCard, {
      props: { card: makeCard(), collectionName: '考研数学' },
    })
    expect(w.text()).toContain('考研数学')
  })

  it('无合集名时显示未分类', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard() } })
    expect(w.text()).toContain('未分类')
  })

  it('显示标签与复习次数', () => {
    const w = mount(KnowledgeCard, {
      props: { card: makeCard({ tags: ['微积分'], reviewCount: 7 }) },
    })
    expect(w.text()).toContain('#微积分')
    expect(w.text()).toContain('复习 7 次')
  })

  it('显示 Anki 状态文案', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard({ syncState: 'relearning' }) } })
    expect(w.text()).toContain('重学中')
  })

  it('记忆等级驱动进度条宽度', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard({ level: 5 }) } })
    const fill = w.find('.meter__fill')
    expect(fill.attributes('style')).toContain('width: 100%')
  })

  it('有图片时渲染 img', () => {
    const w = mount(KnowledgeCard, {
      props: { card: makeCard({ imageUri: 'data:image/png;base64,AAA' }) },
    })
    expect(w.find('img').exists()).toBe(true)
  })

  it('无图片时不渲染 img', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard({ imageUri: '' }) } })
    expect(w.find('img').exists()).toBe(false)
  })

  it('深度越大层级与透明度随之变化', () => {
    const top = mount(KnowledgeCard, { props: { card: makeCard(), depth: 0 } })
    const deep = mount(KnowledgeCard, { props: { card: makeCard(), depth: 2 } })
    expect(top.attributes('style')).not.toBe(deep.attributes('style'))
    expect(deep.attributes('data-depth')).toBe('2')
  })

  it('有独立原文时不提供切换按钮(当前模型原文即正面)', () => {
    const w = mount(KnowledgeCard, { props: { card: makeCard({ sourceText: '完全不同的原文' }) } })
    expect(w.find('.card__raw-toggle').exists()).toBe(false)
  })

  it('各记忆等级都能正常渲染,不抛异常', () => {
    for (const level of [0, 1, 2, 3, 4, 5] as MemoryLevel[]) {
      const w = mount(KnowledgeCard, { props: { card: makeCard({ level }) } })
      expect(w.find('.card').exists()).toBe(true)
    }
  })
})

describe('CollectionBar 合集栏', () => {
  const collections: Collection[] = [
    { id: 'inbox', name: '未分类', order: 0, createdAt: 0 },
    { id: 'c1', name: '数学', order: 1, createdAt: 0 },
  ]

  it('渲染全部合集标签', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox' },
    })
    expect(w.text()).toContain('未分类')
    expect(w.text()).toContain('数学')
  })

  it('高亮当前合集', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'c1' },
    })
    const active = w.findAll('.cbar__chip--on')
    expect(active).toHaveLength(1)
    expect(active[0]!.text()).toContain('数学')
  })

  it('展开进度映射到位移,0 时完全收起', () => {
    const closed = mount(CollectionBar, {
      props: { progress: 0, collections, activeId: 'inbox' },
    })
    expect(closed.attributes('style')).toContain('translateY(-100%)')

    const open = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox' },
    })
    expect(open.attributes('style')).toContain('translateY(0%)')
  })

  it('半展开时进度被反映到透明度', () => {
    const w = mount(CollectionBar, {
      props: { progress: 0.5, collections, activeId: 'inbox' },
    })
    expect(w.attributes('style')).toContain('opacity: 0.5')
  })

  it('未充分展开时点击不触发选择,避免误触', async () => {
    const w = mount(CollectionBar, {
      props: { progress: 0.2, collections, activeId: 'inbox' },
    })
    await w.findAll('.cbar__chip')[1]!.trigger('click')
    expect(w.emitted('select')).toBeUndefined()
  })

  it('展开后点击触发选择事件', async () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox' },
    })
    // 第 0 个是「全部」,第 1 个起才是具体合集
    await w.findAll('.cbar__chip')[2]!.trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['c1'])
  })

  it('首项是「全部」,点击发出全部范围', async () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'c1' },
    })
    const first = w.findAll('.cbar__chip')[0]!
    expect(first.text()).toContain('全部')
    await first.trigger('click')
    expect(w.emitted('select')?.[0]).toEqual([ALL_COLLECTIONS_ID])
  })

  it('「全部」在选中态时高亮', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: ALL_COLLECTIONS_ID },
    })
    const on = w.findAll('.cbar__chip--on')
    expect(on).toHaveLength(1)
    expect(on[0]!.text()).toContain('全部')
  })

  it('显示「全部」的到期总数', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: ALL_COLLECTIONS_ID, totalCount: 42 },
    })
    expect(w.text()).toContain('42')
  })

  it('渲染「录入」按钮(下滑面板里的录入入口)', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox' },
    })
    const btn = w.find('.cbar__compose')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('录入')
  })

  it('点击「录入」发出 compose 事件', async () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox' },
    })
    await w.find('.cbar__compose').trigger('click')
    expect(w.emitted('compose')).toHaveLength(1)
  })

  it('面板未充分展开时「录入」不可点,避免误触', async () => {
    const w = mount(CollectionBar, {
      props: { progress: 0.2, collections, activeId: 'inbox' },
    })
    await w.find('.cbar__compose').trigger('click')
    expect(w.emitted('compose')).toBeUndefined()
  })

  it('「录入」按钮位于滚动区之外(标签滚到哪都够得着)', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox' },
    })
    // 结构:row > [滚动区 inner, 录入按钮],按钮不是 inner 的子节点
    expect(w.find('.cbar__inner .cbar__compose').exists()).toBe(false)
    expect(w.find('.cbar__row > .cbar__compose').exists()).toBe(true)
  })

  it('「录入」按钮自带无障碍标签', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox' },
    })
    expect(w.find('.cbar__compose').attributes('aria-label')).toBeTruthy()
  })

  it('「全部」与具体合集之间有分隔线', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox' },
    })
    expect(w.find('.cbar__sep').exists()).toBe(true)
  })

  it('显示各合集的待复习数量', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox', counts: { c1: 12 } },
    })
    expect(w.text()).toContain('12')
  })

  it('数量为 0 时不显示角标', () => {
    const w = mount(CollectionBar, {
      props: { progress: 1, collections, activeId: 'inbox', counts: { c1: 0 } },
    })
    expect(w.find('.cbar__count').exists()).toBe(false)
  })

  it('空合集列表也能渲染:只剩「全部」一项,不崩溃', () => {
    const w = mount(CollectionBar, { props: { progress: 1, collections: [], activeId: 'inbox' } })
    const chips = w.findAll('.cbar__chip')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.text()).toContain('全部')
  })
})
