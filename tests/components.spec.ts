/**
 * 组件测试 —— 覆盖交互与渲染契约。
 *
 * 重点验证"用户看到/摸到"的行为:卡片正反面、滑动反馈徽标、
 * 录入框校验、合集栏落位。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ComposeSheet from '~/components/ComposeSheet.vue'
import KnowledgeCard from '~/components/KnowledgeCard.vue'
import { DEFAULT_AI_CONFIG } from '~/lib/ai'
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
    const w = mount(KnowledgeCard, { props: { card: makeCard({ level: 7 }) } })
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

describe('ComposeSheet 识图拆卡(多图 → 多卡)', () => {
  const aiCfg = {
    ...DEFAULT_AI_CONFIG,
    enabled: true,
    vision: true,
    apiKey: 'sk-test',
    baseUrl: 'https://example.com/v1',
    model: 'vision-model',
  }
  const collections: Collection[] = [{ id: 'inbox', name: '未分类', order: 0, createdAt: 0 }]

  function aiOK(front: string, back: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ front, back, keywords: [front] }) } }],
      }),
      text: async () => '',
    } as unknown as Response
  }

  /** 多卡响应:AI 返回卡片数组。 */
  function aiMany(...cards: Array<{ front: string; back: string }>) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(cards) } }],
      }),
      text: async () => '',
    } as unknown as Response
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('多图识别生成多张可编辑草稿,保存时逐张发出 save 事件', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(aiOK('图一知识点', '图一答案'))
      .mockResolvedValueOnce(aiOK('图二知识点', '图二答案'))
    vi.stubGlobal('fetch', fetchMock)

    const w = mount(ComposeSheet, {
      props: { open: true, collections, activeCollectionId: 'inbox', aiConfig: aiCfg },
    })
    await flushPromises()

    // 注入两张图片(组件内 images 数组)
    ;(w.vm as any).images = ['data:image/png;base64,AAA', 'data:image/png;base64,BBB']
    await flushPromises()
    expect(w.findAll('.img-cell')).toHaveLength(2)
    expect(w.text()).toContain('AI 识图拆卡 (2)')

    // 点 AI 识图拆卡
    await w.findAll('.ghost-btn')[1]!.trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const drafts = w.findAll('.draft')
    expect(drafts).toHaveLength(2)
    expect(w.text()).toContain('识别出的卡片(2)')
    expect(w.find('.save-btn').text()).toContain('保存 2 张卡片')

    // 保存 → 逐张发出 save,每卡带自己的图片
    await w.find('.save-btn').trigger('click')
    await flushPromises()

    const saves = w.emitted('save')!
    expect(saves).toHaveLength(2)
    expect(saves[0]![0]).toMatchObject({
      imageUri: 'data:image/png;base64,AAA',
      front: '图一知识点',
      back: '图一答案',
    })
    expect(saves[1]![0]).toMatchObject({
      imageUri: 'data:image/png;base64,BBB',
      front: '图二知识点',
      back: '图二答案',
    })
  })

  it('未开启图片识别时,多图 AI 给出提示而不发起请求', async () => {
    const config = { ...aiCfg, vision: false }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const w = mount(ComposeSheet, {
      props: { open: true, collections, activeCollectionId: 'inbox', aiConfig: config },
    })
    await flushPromises()
    ;(w.vm as any).images = ['data:image/png;base64,AAA']
    await flushPromises()

    await w.findAll('.ghost-btn')[1]!.trigger('click')
    await flushPromises()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(w.text()).toContain('未开启识别图片')
  })

  it('识别失败(非 2xx)不生成草稿,提示失败原因', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const w = mount(ComposeSheet, {
      props: { open: true, collections, activeCollectionId: 'inbox', aiConfig: aiCfg },
    })
    await flushPromises()
    ;(w.vm as any).images = ['data:image/png;base64,AAA']
    await flushPromises()

    await w.findAll('.ghost-btn')[1]!.trigger('click')
    await flushPromises()

    expect(w.findAll('.draft')).toHaveLength(0)
    expect(w.text()).toContain('识别失败')
  })

  it('一张图拆成多张卡:单图多卡草稿,保存时逐张入库', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(aiMany(
        { front: '要点一', back: '答案一' },
        { front: '要点二', back: '答案二' },
        { front: '要点三', back: '答案三' },
      ))
    vi.stubGlobal('fetch', fetchMock)

    const w = mount(ComposeSheet, {
      props: { open: true, collections, activeCollectionId: 'inbox', aiConfig: aiCfg },
    })
    await flushPromises()

    // 只选一张图
    ;(w.vm as any).images = ['data:image/png;base64,AAA']
    await flushPromises()
    expect(w.findAll('.img-cell')).toHaveLength(1)

    await w.findAll('.ghost-btn')[1]!.trigger('click')
    await flushPromises()

    // 一次请求,却拆出 3 张草稿
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(w.findAll('.draft')).toHaveLength(3)
    expect(w.text()).toContain('识别出的卡片(3)')
    expect(w.find('.save-btn').text()).toContain('保存 3 张卡片')

    // 保存 → 3 个 save 事件,共用同一张图
    await w.find('.save-btn').trigger('click')
    await flushPromises()
    const saves = w.emitted('save')!
    expect(saves).toHaveLength(3)
    expect(saves[0]![0]).toMatchObject({ imageUri: 'data:image/png;base64,AAA', front: '要点一' })
    expect(saves[1]![0]).toMatchObject({ imageUri: 'data:image/png;base64,AAA', front: '要点二' })
    expect(saves[2]![0]).toMatchObject({ imageUri: 'data:image/png;base64,AAA', front: '要点三' })
  })
})
