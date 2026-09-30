/**
 * 页面级集成测试 —— 挂载**真实的** index.vue / settings.vue,
 * 跑真实的 IndexedDB 仓储与调度服务。
 *
 * 这层测试的价值:组件单测只能证明"卡片画得对",而这里能证明
 * 「页面装配起来能跑、手势回调接线正确、数据真的落库」——
 * 是浏览器冒烟测试在 CI 里最接近的替代品。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import IndexPage from '~/pages/index.vue'
import SettingsPage from '~/pages/settings.vue'
import AdminPage from '~/pages/admin.vue'
// Nuxt 会自动注册 components/ 下的组件;测试里等价显式注册,
// 这样测的才是真实页面装配,而不是把子组件 stub 掉
import CardStack from '~/components/CardStack.vue'
import ComposeSheet from '~/components/ComposeSheet.vue'
import KnowledgeCard from '~/components/KnowledgeCard.vue'
import { useCardRepository, __setRepository, DEFAULT_COLLECTION_ID } from '~/lib/db'
import { useCollections } from '~/composables/useAppState'
import { ALL_COLLECTIONS_ID } from '~/lib/db-constants'
// 直接指向替身文件:与 vitest.config.ts 中 `#imports` 的 alias 是同一个模块
import { __resetNuxtState } from '~/tests/stubs/nuxt-imports'

/** NuxtLink 与 NuxtPage 的轻量替身。 */
const NuxtLinkStub = defineComponent({
  props: { to: { type: [String, Object], default: '/' } },
  setup(props, { slots }) {
    return () => h('a', { href: String(props.to), class: 'nuxt-link-stub' }, slots.default?.())
  },
})

const globalStubs = {
  NuxtLink: NuxtLinkStub,
  NuxtPage: { template: '<div />' },
}

/** 与 Nuxt 自动注册等价的全局组件表。 */
const globalComponents = {
  CardStack,
  ComposeSheet,
  KnowledgeCard,
}

function mountOptions() {
  return {
    global: {
      stubs: globalStubs,
      components: globalComponents,
    },
  }
}

/** 挂载首页并等所有异步初始化跑完。 */
async function mountHome() {
  const wrapper = mount(IndexPage, mountOptions())
  await settle()
  return wrapper
}

// 每个用例后自动卸载挂载的页面:
// 否则残留的 onMounted 异步链会在库关闭后继续访问,造成跨用例污染
enableAutoUnmount(afterEach)

beforeEach(() => {
  __setRepository(null)
  __resetNuxtState()
})

/**
 * 等页面里的多段异步链(读库 → 写库 → 刷新)全部落定。
 *
 * 注意:fake-indexeddb 的回调走的是**宏任务**,只 flushPromises()
 * 只会清微任务,读不到结果。所以这里宏微交替地清。
 */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await flushPromises()
}

describe('首页页面集成', () => {
  it('能够挂载并完成初始化,不抛异常', async () => {
    const w = await mountHome()
    expect(w.find('main.home').exists()).toBe(true)
  })

  it('空库时显示空态提示', async () => {
    const w = await mountHome()
    expect(w.text()).toContain('暂无待复习卡片')
    expect(w.text()).toContain('点右下角齿轮,到设置页录入知识点')
  })

  it('双击空白不再唤起录入框(录入只能走「录入」按钮/键盘)', async () => {
    const w = await mountHome()
    const stack = w.find('.stack')
    const tap = () => {
      const t = { clientX: 195, clientY: 400, identifier: 0 } as Touch
      return {
        touches: [t],
        changedTouches: [t],
        preventDefault: () => {},
      } as unknown as TouchEvent
    }
    // 两次快速靠近的点击 = 旧版双击手势;现在必须是空操作
    await stack.trigger('touchstart', tap() as any)
    await stack.trigger('touchend', tap() as any)
    await stack.trigger('touchstart', tap() as any)
    await stack.trigger('touchend', tap() as any)
    await settle(2)

    expect(w.find('.compose').exists()).toBe(false)
    expect(w.findComponent({ name: 'CardStack' }).emitted('compose')).toBeUndefined()
  })

  it('渲染出角落的设置入口齿轮(唯一导航入口)', async () => {
    const w = await mountHome()
    const gear = w.find('.gear')
    expect(gear.exists()).toBe(true)
    expect(gear.attributes('href')).toBe('/settings')
  })

  it('库中有到期卡片时渲染为卡片堆叠', async () => {
    const repo = useCardRepository()
    await repo.addCard({ front: '什么是极限', back: '描述趋近过程' })

    const w = await mountHome()
    expect(w.find('.stack').exists()).toBe(true)
    expect(w.text()).toContain('什么是极限')
    expect(w.text()).not.toContain('暂无待复习卡片')
  })

  it('只渲染到期卡片,未到期的不出现在首页', async () => {
    const repo = useCardRepository()
    await repo.addCard({ front: '到期的卡' })
    const future = await repo.addCard({ front: '未来的卡' })
    await repo.putCard({ ...future, nextReviewAt: Date.now() + 86400000 })

    const w = await mountHome()
    expect(w.text()).toContain('到期的卡')
    expect(w.text()).not.toContain('未来的卡')
  })

  it('最多只渲染 3 层堆叠卡片', async () => {
    const repo = useCardRepository()
    for (let i = 0; i < 6; i++) await repo.addCard({ front: `卡片${i}` })

    const w = await mountHome()
    expect(w.findAll('.stack__slot')).toHaveLength(3)
  })

  it('录入框默认关闭,收到 compose 事件后才打开', async () => {
    const w = await mountHome()
    expect(w.find('.compose').exists()).toBe(false)

    // 模拟 CardStack 冒泡上来的 compose 事件
    await w.findComponent({ name: 'CardStack' }).vm.$emit('compose')
    await flushPromises()
    expect(w.find('.compose').exists()).toBe(true)
  })

  it('保存新卡片后立即出现在堆叠中并落库', async () => {
    const repo = useCardRepository()
    const w = await mountHome()

    const stack = w.findComponent({ name: 'CardStack' })
    await stack.vm.$emit('compose')
    await settle()

    const sheet = w.findComponent({ name: 'ComposeSheet' })
    sheet.vm.$emit('save', {
      sourceText: '光合作用',
      front: '光合作用是什么',
      back: '把光能转成化学能',
      imageUri: '',
      tags: ['生物'],
      collectionId: 'inbox',
    })
    await settle()

    // 界面立即补位
    expect(w.text()).toContain('光合作用是什么')
    // 且真的写进了仓储
    expect(await repo.countCards()).toBe(1)
  })

  it('右滑复习:卡片出队、等级推进、并按新到期时间落库', async () => {
    const repo = useCardRepository()
    const card = await repo.addCard({ front: 'Q', back: 'A' })
    const w = await mountHome()
    expect(w.text()).toContain('Q')

    await w.findComponent({ name: 'CardStack' }).vm.$emit('review', 'pass')
    await settle()

    // 已从首页移出
    expect(w.text()).toContain('暂无待复习卡片')

    // 落库为等级 1、约 1 天后复习
    const stored = await repo.getCard(card.id)
    expect(stored?.level).toBe(1)
    expect(stored?.passCount).toBe(1)
    const days = (stored!.nextReviewAt - Date.now()) / 86400000
    expect(days).toBeGreaterThan(0.9)
    expect(days).toBeLessThan(1.1)
  })

  it('左滑复习:卡片转为待复习,等级回到 1', async () => {
    const repo = useCardRepository()
    const card = await repo.addCard({ front: 'Q', back: 'A' })
    const w = await mountHome()

    await w.findComponent({ name: 'CardStack' }).vm.$emit('review', 'fail')
    await settle()

    const stored = await repo.getCard(card.id)
    expect(stored?.level).toBe(1)
    expect(stored?.syncState).toBe('relearning')
    expect(stored?.failCount).toBe(1)
  })

  it('默认「全部」范围,首屏能看到所有合集的卡', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    await repo.addCard({ front: '数学题', collectionId: math.id })
    await repo.addCard({ front: '英语题' })

    const w = await mountHome()
    expect(w.text()).toContain('数学题')
    expect(w.text()).toContain('英语题')
  })

  it('选择单个合集后,首页严格只刷该合集', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    await repo.addCard({ front: '数学题', collectionId: math.id })
    await repo.addCard({ front: '英语题' })

    // 挂载前锁定复习范围(等价于设置页「合集管理 → 复习范围」选中)
    useCollections().select(math.id)
    const w = await mountHome()

    expect(w.text()).toContain('数学题')
    expect(w.text()).not.toContain('英语题')
  })

  it('锁定单合集时顶部出现范围提示条', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    await repo.addCard({ front: '数学题', collectionId: math.id })

    useCollections().select(math.id)
    const w = await mountHome()

    const scope = w.find('.scope')
    expect(scope.exists()).toBe(true)
    expect(scope.text()).toContain('数学')
  })

  it('锁定范围时顶部范围提示条指向设置页切换入口', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    await repo.addCard({ front: '数学题', collectionId: math.id })

    useCollections().select(math.id)
    const w = await mountHome()

    const scope = w.find('.scope')
    expect(scope.exists()).toBe(true)
    expect(scope.attributes('href')).toBe('/settings')
  })

  it('【回归】选「未分类」只复习未分类,不再是全部', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    await repo.addCard({ front: '数学题', collectionId: math.id })
    await repo.addCard({ front: '未分类题', collectionId: DEFAULT_COLLECTION_ID })

    useCollections().select(DEFAULT_COLLECTION_ID)
    const w = await mountHome()

    expect(w.text()).toContain('未分类题')
    expect(w.text()).not.toContain('数学题')
  })

  it('切到「全部」时范围提示条消失(避免冗余信息)', async () => {
    const repo = useCardRepository()
    await repo.addCard({ front: 'Q' })
    useCollections().select(ALL_COLLECTIONS_ID)
    const w = await mountHome()

    expect(w.find('.scope').exists()).toBe(false)
  })

  it('范围内录入的新卡立即出现', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    await repo.addCard({ front: '旧的数学题', collectionId: math.id })

    useCollections().select(math.id)
    const w = await mountHome()

    const sheet = w.findComponent({ name: 'ComposeSheet' })
    sheet.vm.$emit('save', {
      sourceText: '新知识点',
      front: '新的数学题',
      back: '答案',
      imageUri: '',
      tags: [],
      collectionId: math.id,
    })
    await settle()

    expect(w.text()).toContain('新的数学题')
  })

  it('【范围隔离】范围外录入的新卡不会混进当前队列', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    const english = await repo.createCollection('英语')
    await repo.addCard({ front: '数学题', collectionId: math.id })

    useCollections().select(math.id)
    const w = await mountHome()

    // 录入一张英语卡 —— 当前范围是数学,不应出现在队列里
    w.findComponent({ name: 'ComposeSheet' }).vm.$emit('save', {
      sourceText: '英语知识点',
      front: '英语题',
      back: '答案',
      imageUri: '',
      tags: [],
      collectionId: english.id,
    })
    await settle()

    expect(w.text()).not.toContain('英语题')
    // 但确实落库了
    expect(await repo.countCards()).toBe(2)
  })

  it('首页不再挂载合集栏与遮罩(切分组入口在设置页)', async () => {
    const w = await mountHome()
    expect(w.find('.cbar').exists()).toBe(false)
    expect(w.find('.scrim').exists()).toBe(false)
  })

  it('录入框拿到真实合集列表与 AI 配置', async () => {
    const repo = useCardRepository()
    await repo.createCollection('数学')
    const w = await mountHome()

    const sheet = w.findComponent({ name: 'ComposeSheet' })
    expect(sheet.props('collections').map((c: any) => c.name)).toContain('数学')
    expect(sheet.props('aiConfig')).toBeTruthy()
  })

  it('复习后显示结果轻提示', async () => {
    const repo = useCardRepository()
    await repo.addCard({ front: 'Q', back: 'A' })
    const w = await mountHome()

    await w.findComponent({ name: 'CardStack' }).vm.$emit('review', 'pass')
    await settle()

    expect(w.find('.toast').exists()).toBe(true)
    expect(w.text()).toContain('已掌握')
  })

  it('未开启打卡提醒时首页不显示打卡胶囊', async () => {
    const w = await mountHome()
    expect(w.find('.checkin').exists()).toBe(false)
  })

  it('开启打卡提醒后首页显示打卡胶囊,点击完成今日打卡', async () => {
    window.localStorage.setItem(
      'abdrop.checkin.config',
      JSON.stringify({ enabled: true, startMinute: 9 * 60, endMinute: 22 * 60 }),
    )
    const w = await mountHome()
    const pill = w.find('.checkin')
    expect(pill.exists()).toBe(true)
    expect(w.text()).toContain('今日未打卡')

    await pill.trigger('click')
    await settle()

    expect(w.find('.checkin').text()).toContain('今日已打卡')
    expect(window.localStorage.getItem('abdrop.checkin.date')).toBeTruthy()
  })
})

describe('管理员页面集成', () => {
  async function mountAdmin() {
    const wrapper = mount(AdminPage, mountOptions())
    await settle()
    return wrapper
  }

  /** 造一张有未来计时的卡。 */
  async function addScheduledCard(repo: ReturnType<typeof useCardRepository>, front: string, col: string) {
    const c = await repo.addCard({ front, back: '答案', collectionId: col })
    await repo.putCard({
      ...c,
      level: 4,
      intervalDays: 7,
      reviewCount: 9,
      nextReviewAt: Date.now() + 7 * 86400000,
    })
    return c
  }

  it('能够挂载', async () => {
    const w = await mountAdmin()
    expect(w.find('main.admin').exists()).toBe(true)
  })

  it('默认范围为「全部」、默认强度为「只清计时」', async () => {
    const w = await mountAdmin()
    const on = w.findAll('.chip--on')
    expect(on).toHaveLength(1)
    expect(on[0]!.text()).toContain('全部')

    const checked = w.find('.mode__radio:checked')
    expect((checked.element as HTMLInputElement).value).toBe('schedule')
  })

  it('显示范围内卡片统计', async () => {
    const repo = useCardRepository()
    await addScheduledCard(repo, 'A', 'inbox')
    await addScheduledCard(repo, 'B', 'inbox')

    const w = await mountAdmin()
    expect(w.text()).toContain('共 2 张卡片')
    expect(w.text()).toContain('有未来计时')
  })

  it('点击执行先弹确认,不立即改数据', async () => {
    const repo = useCardRepository()
    const card = await addScheduledCard(repo, 'A', 'inbox')

    const w = await mountAdmin()
    await w.find('.action').trigger('click')
    await settle()

    expect(w.find('.confirm').exists()).toBe(true)
    // 数据未变
    expect((await repo.getCard(card.id))!.level).toBe(4)
  })

  it('确认后真正执行「只清计时」', async () => {
    const repo = useCardRepository()
    const card = await addScheduledCard(repo, 'A', 'inbox')

    const w = await mountAdmin()
    await w.find('.action').trigger('click')
    await settle()
    await w.findAll('.confirm__actions .btn')[1]!.trigger('click')
    await settle()

    const stored = await repo.getCard(card.id)
    expect(stored!.nextReviewAt).toBeLessThanOrEqual(Date.now())
    // 只清计时:等级保留
    expect(stored!.level).toBe(4)
    expect(stored!.reviewCount).toBe(9)
  })

  it('取消确认不改动任何数据', async () => {
    const repo = useCardRepository()
    const card = await addScheduledCard(repo, 'A', 'inbox')
    const before = { ...(await repo.getCard(card.id))! }

    const w = await mountAdmin()
    await w.find('.action').trigger('click')
    await settle()
    await w.findAll('.confirm__actions .btn')[0]!.trigger('click')
    await settle()

    expect(w.find('.confirm').exists()).toBe(false)
    expect(await repo.getCard(card.id)).toEqual(before)
  })

  it('点遮罩也能取消', async () => {
    const repo = useCardRepository()
    await addScheduledCard(repo, 'A', 'inbox')
    const w = await mountAdmin()

    await w.find('.action').trigger('click')
    await settle()
    await w.find('.confirm__scrim').trigger('click')
    await settle()
    expect(w.find('.confirm').exists()).toBe(false)
  })

  it('「完全重新开始」会清空记忆进度', async () => {
    const repo = useCardRepository()
    const card = await addScheduledCard(repo, 'A', 'inbox')

    const w = await mountAdmin()
    // 切到 full
    const radios = w.findAll('.mode__radio')
    await radios[1]!.setValue()
    await settle()

    await w.find('.action').trigger('click')
    await settle()
    await w.findAll('.confirm__actions .btn')[1]!.trigger('click')
    await settle()

    const stored = await repo.getCard(card.id)
    expect(stored!.level).toBe(0)
    expect(stored!.reviewCount).toBe(0)
    // 内容仍在
    expect(stored!.front).toBe('A')
  })

  it('破坏性操作在确认框里有明确警告', async () => {
    const repo = useCardRepository()
    await addScheduledCard(repo, 'A', 'inbox')

    const w = await mountAdmin()
    await w.findAll('.mode__radio')[1]!.setValue()
    await settle()
    await w.find('.action').trigger('click')
    await settle()

    expect(w.find('.confirm__danger').exists()).toBe(true)
    expect(w.text()).toContain('无法撤销')
  })

  it('按范围重置:选数学不影响英语', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    const english = await repo.createCollection('英语')
    const m = await addScheduledCard(repo, 'M', math.id)
    const e = await addScheduledCard(repo, 'E', english.id)

    const w = await mountAdmin()
    // 选数学范围
    const chips = w.findAll('.chip')
    const mathChip = chips.find((c) => c.text() === '数学')!
    await mathChip.trigger('click')
    await settle()

    await w.findAll('.mode__radio')[1]!.setValue()
    await settle()
    await w.find('.action').trigger('click')
    await settle()
    await w.findAll('.confirm__actions .btn')[1]!.trigger('click')
    await settle()

    expect((await repo.getCard(m.id))!.level).toBe(0)
    expect((await repo.getCard(e.id))!.level).toBe(4)
  })

  it('范围内无卡片时按钮禁用', async () => {
    const w = await mountAdmin()
    expect(w.find('.action').attributes('disabled')).toBeDefined()
  })

  it('「只清计时」但无未来计时卡片时给出提示', async () => {
    const repo = useCardRepository()
    // 一张已到期的卡
    await repo.addCard({ front: 'A' })

    const w = await mountAdmin()
    expect(w.find('.hint--warn').exists()).toBe(true)
  })

  it('重置后回显结果摘要', async () => {
    const repo = useCardRepository()
    await addScheduledCard(repo, 'A', 'inbox')

    const w = await mountAdmin()
    await w.find('.action').trigger('click')
    await settle()
    await w.findAll('.confirm__actions .btn')[1]!.trigger('click')
    await settle()

    expect(w.find('.report').exists()).toBe(true)
    expect(w.text()).toContain('只清计时')
  })

  // ── 示例数据 ──────────────────────────────────────────────
  it('显示示例数据面板(载入/移除入口)', async () => {
    const w = await mountAdmin()
    expect(w.text()).toContain('示例数据')
    expect(w.text()).toContain('载入示例数据')
    expect(w.text()).toContain('移除示例数据')
    expect(w.text()).toContain('0 张示例卡片')
  })

  it('点击载入示例数据:卡片入库、数量更新', async () => {
    const repo = useCardRepository()
    const w = await mountAdmin()

    await w.find('.btn-row .btn--ghost').trigger('click')
    await settle()

    expect(await repo.countCards()).toBeGreaterThan(0)
    expect(w.text()).not.toContain('0 张示例卡片')
    expect(w.find('.report').exists()).toBe(true)
    expect(w.text()).toContain('已载入')
  })

  it('重复载入幂等:卡片数量不重复增长', async () => {
    const repo = useCardRepository()
    const w = await mountAdmin()

    await w.find('.btn-row .btn--ghost').trigger('click')
    await settle()
    const afterFirst = await repo.countCards()

    await w.find('.btn-row .btn--ghost').trigger('click')
    await settle()
    const afterSecond = await repo.countCards()

    expect(afterSecond).toBe(afterFirst)
  })

  it('移除示例数据前先弹确认', async () => {
    const repo = useCardRepository()
    const w = await mountAdmin()

    await w.find('.btn-row .btn--ghost').trigger('click')
    await settle()
    expect(await repo.countCards()).toBeGreaterThan(0)

    // 点移除 → 确认弹窗,数据未变
    const removeBtn = w.findAll('.btn-row .btn')[1]!
    await removeBtn.trigger('click')
    await settle()
    expect(w.find('.confirm').exists()).toBe(true)
    expect(await repo.countCards()).toBeGreaterThan(0)
  })

  it('确认移除示例数据:demo 卡删除、用户卡保留', async () => {
    const repo = useCardRepository()
    const mine = await repo.addCard({ front: '我自己录入的卡' })

    const w = await mountAdmin()
    await w.find('.btn-row .btn--ghost').trigger('click')
    await settle()
    const totalAfterLoad = await repo.countCards()
    expect(totalAfterLoad).toBeGreaterThan(1)

    await w.findAll('.btn-row .btn')[1]!.trigger('click')
    await settle()
    await w.findAll('.confirm__actions .btn')[1]!.trigger('click')
    await settle()

    // demo 卡全删,只剩用户自己的
    expect(await repo.countCards()).toBe(1)
    expect((await repo.getCard(mine.id))?.deleted).toBe(false)
    expect(w.find('.report').exists()).toBe(true)
    expect(w.text()).toContain('已移除')
  })

  it('无示例卡时移除按钮禁用', async () => {
    const w = await mountAdmin()
    const removeBtn = w.findAll('.btn-row .btn')[1]!
    expect(removeBtn.attributes('disabled')).toBeDefined()
  })
})

describe('设置页页面集成', () => {
  async function mountSettings() {
    const wrapper = mount(SettingsPage, mountOptions())
    await settle()
    return wrapper
  }

  it('能够挂载', async () => {
    const w = await mountSettings()
    expect(w.find('main.settings').exists()).toBe(true)
  })

  it('提供管理员入口(但不占用功能面板位置)', async () => {
    const w = await mountSettings()
    const link = w.find('.admin-link')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/admin')
  })

  it('只保留三项功能面板,无冗余入口', async () => {
    const w = await mountSettings()
    const heads = w.findAll('.panel__head').map((h) => h.text())
    expect(heads).toHaveLength(3)
    expect(heads[0]).toContain('AI 接口配置')
    expect(heads[1]).toContain('合集管理')
    expect(heads[2]).toContain('数据导入导出')
  })

  it('显示卡片总数', async () => {
    const repo = useCardRepository()
    await repo.addCard({ front: 'A' })
    await repo.addCard({ front: 'B' })

    const w = await mountSettings()
    expect(w.text()).toContain('2 张卡片')
  })

  it('折叠面板默认全部收起', async () => {
    const w = await mountSettings()
    expect(w.findAll('.panel__body')).toHaveLength(0)
  })

  it('点击标题展开对应面板,再点收起', async () => {
    const w = await mountSettings()
    const first = w.findAll('.panel__head')[0]!

    await first.trigger('click')
    expect(w.findAll('.panel__body')).toHaveLength(1)

    await first.trigger('click')
    expect(w.findAll('.panel__body')).toHaveLength(0)
  })

  it('展开合集管理时列出全部合集并包含默认未分类', async () => {
    const repo = useCardRepository()
    await repo.createCollection('数学')

    const w = await mountSettings()
    await w.findAll('.panel__head')[1]!.trigger('click')
    await settle()

    expect(w.text()).toContain('未分类')
    expect(w.text()).toContain('数学')
  })

  it('默认合集不提供删除按钮(不能删掉唯一的兜底合集)', async () => {
    const w = await mountSettings()
    await w.findAll('.panel__head')[1]!.trigger('click')
    await settle()

    const items = w.findAll('.list__item')
    // 只有「未分类」时,删除按钮数量为 0
    expect(items).toHaveLength(1)
    expect(w.findAll('.mini--danger')).toHaveLength(0)
  })

  it('展开数据面板时提供 Anki 导入与导出入口', async () => {
    const w = await mountSettings()
    await w.findAll('.panel__head')[2]!.trigger('click')
    await settle()

    expect(w.text()).toContain('导入 Anki 文件')
    expect(w.text()).toContain('导出 Anki TSV')
    expect(w.text()).toContain('保存配置(含卡片与复习进度)')
  })

  it('AI 面板切换服务商时自动填充默认地址与模型', async () => {
    const w = await mountSettings()
    await w.findAll('.panel__head')[0]!.trigger('click')
    await settle()

    const chips = w.findAll('.chips .chip')
    const deepseek = chips.find((c) => c.text() === 'DeepSeek')!
    await deepseek.trigger('click')
    await settle()

    const inputs = w.findAll('.input')
    const baseUrl = inputs.find((i) => i.attributes('type') === 'url')!
    expect((baseUrl.element as HTMLInputElement).value).toContain('deepseek.com')
  })

  it('设置页顶部提供「录入知识点」入口', async () => {
    const w = await mountSettings()
    const entry = w.find('.compose-entry')
    expect(entry.exists()).toBe(true)
    expect(entry.text()).toContain('录入')
  })

  it('点击「录入知识点」打开录入框,保存后入库并刷新计数', async () => {
    const repo = useCardRepository()
    const w = await mountSettings()

    await w.find('.compose-entry').trigger('click')
    await settle()
    expect(w.find('.compose').exists()).toBe(true)

    const sheet = w.findComponent({ name: 'ComposeSheet' })
    sheet.vm.$emit('save', {
      sourceText: '光合作用',
      front: '光合作用是什么',
      back: '把光能转成化学能',
      imageUri: '',
      tags: ['生物'],
      collectionId: 'inbox',
    })
    await settle()

    expect(await repo.countCards()).toBe(1)
    expect(w.find('.compose').exists()).toBe(false)
    expect(w.text()).toContain('1 张卡片')
  })

  it('首页没有合集栏(切分组入口在设置页「合集管理 → 复习范围」)', async () => {
    const w = await mountHome()
    expect(w.find('.cbar').exists()).toBe(false)
  })

  it('合集管理提供复习范围选择,选中后高亮并持久化', async () => {
    const repo = useCardRepository()
    const math = await repo.createCollection('数学')
    const w = await mountSettings()

    await w.findAll('.panel__head')[1]!.trigger('click')
    await settle()

    const opts = w.findAll('.scope-opt')
    expect(opts.length).toBeGreaterThanOrEqual(2)
    const mathOpt = opts.find((o) => o.text().includes('数学'))!
    await mathOpt.trigger('click')
    await settle()

    expect(window.localStorage.getItem('abdrop.activeCollection')).toBe(math.id)
    expect(w.find('.scope-opt--on').text()).toContain('数学')
  })

  it('设置页提供「打卡提醒」卡片(开关 + 开始/结束时间)', async () => {
    const w = await mountSettings()
    expect(w.find('.checkin-panel').exists()).toBe(true)
    expect(w.text()).toContain('打卡提醒')
    expect(w.findAll('.checkin-panel input[type="time"]')).toHaveLength(2)
  })

  it('设置页开关打卡提醒并持久化配置', async () => {
    const w = await mountSettings()
    const sw = w.find('.checkin-panel .switch')
    await sw.setValue(true)
    await settle()

    const saved = window.localStorage.getItem('abdrop.checkin.config') ?? ''
    expect(saved).toContain('"enabled":true')
    expect(w.find('.checkin-panel .panel__meta').text()).toContain('每小时')
  })

  it('打卡提醒卡片可收起:点头部折叠/展开,默认收起', async () => {
    const w = await mountSettings()
    const bodyEl = () => w.find('.checkin-panel__body').element as HTMLElement
    // 默认收起(v-show 写入 display:none,输入区仍在 DOM)
    expect(w.find('.checkin-panel__head').exists()).toBe(true)
    expect(bodyEl().style.display).toBe('none')

    await w.find('.checkin-panel__head').trigger('click')
    await settle()
    expect(bodyEl().style.display).not.toBe('none')

    await w.find('.checkin-panel__head').trigger('click')
    await settle()
    expect(bodyEl().style.display).toBe('none')
  })
})
