/**
 * 示例数据 —— 用于首次体验与演示。
 *
 * 设计要点:
 * 1. **声明式**:每张卡只描述"内容 + 目标状态",具体时间戳由 `buildSeedCards`
 *    依据注入的 `now` 推导 —— 所以它是纯函数,可完整单测。
 * 2. **幂等**:卡片 id 由正面内容的哈希确定性生成,重复载入不会产生重复卡。
 * 3. **覆盖真实场景**:不同记忆等级、不同到期状态(逾期/到期/未来)、
 *    带标签与原文,让用户一眼看到调度系统的全部状态。
 */

import type { CardRepository } from '~/lib/db'
import { createCard } from '~/lib/db'
import { hash32 } from '~/lib/anki-map'
import { DAY_MS, intervalDaysForLevel, stateForLevel, DEFAULT_EASE } from '~/lib/srs'
import type { ImportReport, KnowledgeCard, MemoryLevel } from '~/types'

/** 种子卡片的声明式描述。 */
export interface SeedSpec {
  /** 正面:问题 */
  front: string
  /** 背面:答案 */
  back: string
  /** 原始录入文本(体现"原文 → AI 归纳"这条链路) */
  sourceText: string
  /** 目标合集名 */
  collection: string
  /** 标签 */
  tags: string[]
  /** 记忆等级 */
  level: MemoryLevel
  /**
   * 相对"现在"的到期偏移(天)。
   * 负数 = 已逾期;0 = 正好到期;正数 = 未来(首页不会显示)。
   */
  dueOffsetDays: number
  /** 累计复习次数 */
  reviewCount: number
  /** 累计遗忘次数 */
  lapses?: number
}

/** 示例合集名(与卡片的 collection 字段对应)。 */
export const SEED_COLLECTIONS = ['数学', '英语', '物理', '历史', '计算机'] as const

/**
 * 示例卡片。
 *
 * 覆盖三种到期状态:
 *   - 逾期 / 到期(负数或 0)→ 首页可见,且按逾期程度排序
 *   - 未来(正数)→ 首页不可见,用于验证"只拉到期和新录入"
 * 覆盖全部记忆等级 0–5,顶部记忆强度条会有明显差异。
 */
export const SEED_SPECS: readonly SeedSpec[] = [
  // ── 数学 ────────────────────────────────────────────────
  {
    front: '函数极限的 ε-δ 定义是什么?',
    back: '设函数 f(x) 在点 x₀ 的某去心邻域内有定义。若对任意 ε>0,总存在 δ>0,使得当 0<|x-x₀|<δ 时,恒有 |f(x)-A|<ε,则称 A 为 f(x) 当 x→x₀ 时的极限。',
    sourceText: '极限的严格定义,epsilon-delta 语言',
    collection: '数学',
    tags: ['微积分', '极限'],
    level: 1,
    dueOffsetDays: -12,
    reviewCount: 2,
  },
  {
    front: '导数的几何意义是什么?',
    back: '曲线 y=f(x) 在点 (x₀, f(x₀)) 处切线的斜率,即 f′(x₀)=tan α,其中 α 是切线的倾角。',
    sourceText: '导数是切线斜率',
    collection: '数学',
    tags: ['微积分', '导数'],
    level: 3,
    dueOffsetDays: -7,
    reviewCount: 5,
  },
  {
    front: '洛必达法则的适用条件?',
    back: '① 0/0 或 ∞/∞ 型未定式;\n② 分子分母在去心邻域内可导,且分母导数不为 0;\n③ lim f′(x)/g′(x) 存在或为无穷。\n三者同时满足才可用。',
    sourceText: '洛必达法则使用前提',
    collection: '数学',
    tags: ['微积分', '极限'],
    level: 5,
    dueOffsetDays: -2,
    reviewCount: 11,
  },
  {
    front: '泰勒公式与麦克劳林公式的关系?',
    back: '麦克劳林公式是泰勒公式在 x₀=0 时的特例。\n泰勒:f(x)=Σ f⁽ⁿ⁾(x₀)(x-x₀)ⁿ/n! + Rₙ(x)\n麦克劳林:f(x)=Σ f⁽ⁿ⁾(0)xⁿ/n! + Rₙ(x)',
    sourceText: '泰勒展开,麦克劳林是 x0=0 的特殊情况',
    collection: '数学',
    tags: ['微积分', '级数'],
    level: 2,
    dueOffsetDays: -4,
    reviewCount: 3,
  },
  {
    front: '定积分与不定积分的本质区别?',
    back: '不定积分是求原函数族(结果含任意常数 C),是一个函数集合;\n定积分是一个确定的数值,几何上是曲边梯形的面积。\n二者由牛顿-莱布尼茨公式联系起来。',
    sourceText: '定积分是一个数,不定积分是函数族',
    collection: '数学',
    tags: ['微积分', '积分'],
    level: 0,
    dueOffsetDays: -1,
    reviewCount: 0,
  },

  // ── 英语 ────────────────────────────────────────────────
  {
    front: '现在完成时与一般过去时的区别?',
    back: '现在完成时强调过去动作对现在的影响或持续到现在,不与明确过去时间状语连用;\n一般过去时只陈述过去发生的事实,常与 yesterday、in 2020 等连用。',
    sourceText: '完成时强调对现在的影响,过去时只讲过去',
    collection: '英语',
    tags: ['语法', '时态'],
    level: 2,
    dueOffsetDays: -9,
    reviewCount: 4,
  },
  {
    front: '定语从句中 that 与 which 的用法区别?',
    back: '① 非限制性定语从句只能用 which,不能用 that;\n② 介词提前时只能用 which;\n③ 先行词为 all、everything、nothing 或有序数词/最高级修饰时,通常用 that。',
    sourceText: 'that 和 which 在定语从句里的区别',
    collection: '英语',
    tags: ['语法', '从句'],
    level: 4,
    dueOffsetDays: -3,
    reviewCount: 7,
  },
  {
    front: '虚拟语气中与现在事实相反的用法?',
    back: '从句用过去式(be 用 were),主句用 would/could/might + 动词原形。\n例:If I were you, I would take the job.',
    sourceText: '虚拟语气,与现在事实相反',
    collection: '英语',
    tags: ['语法', '虚拟语气'],
    level: 3,
    dueOffsetDays: -5,
    reviewCount: 6,
  },
  {
    front: '非谓语动词的三种形式及其含义?',
    back: '① 不定式 to do:表目的、将来、一次性动作;\n② 动名词 doing:表主动、进行、习惯性;\n③ 过去分词 done:表被动、完成。',
    sourceText: '非谓语动词 to do / doing / done',
    collection: '英语',
    tags: ['语法', '非谓语'],
    level: 0,
    dueOffsetDays: 0,
    reviewCount: 0,
  },

  // ── 物理 ────────────────────────────────────────────────
  {
    front: '牛顿第二定律的表达式与适用条件?',
    back: 'F合 = ma。\n适用条件:宏观低速、惯性参考系。\n它说明力是改变运动状态的原因,而非维持运动的原因。',
    sourceText: 'F=ma,宏观低速惯性系',
    collection: '物理',
    tags: ['力学', '牛顿定律'],
    level: 4,
    dueOffsetDays: -6,
    reviewCount: 8,
  },
  {
    front: '动量守恒定律的成立条件?',
    back: '系统不受外力,或所受合外力为零(或内力远大于外力的极短时间内,如碰撞、爆炸)。\n注意:动量守恒是矢量守恒,需按方向分别列式。',
    sourceText: '动量守恒条件:合外力为零',
    collection: '物理',
    tags: ['力学', '动量'],
    level: 2,
    dueOffsetDays: -11,
    reviewCount: 3,
  },
  {
    front: '楞次定律的内容是什么?',
    back: '感应电流的磁场总要阻碍引起感应电流的磁通量的变化。\n口诀:"增反减同" —— 磁通量增加时感应磁场与原磁场反向,减少时同向。',
    sourceText: '楞次定律,增反减同',
    collection: '物理',
    tags: ['电磁学'],
    level: 1,
    dueOffsetDays: -8,
    reviewCount: 2,
  },
  {
    front: '光电效应方程及其物理意义?',
    back: 'Ek = hν - W₀\n其中 hν 为入射光子能量,W₀ 为逸出功,Ek 为光电子最大初动能。\n说明光的能量是量子化的,是光的粒子性的直接证据。',
    sourceText: '光电效应方程,Ek = hv - W0',
    collection: '物理',
    tags: ['近代物理', '光电效应'],
    level: 5,
    dueOffsetDays: -1,
    reviewCount: 12,
  },

  // ── 历史 ────────────────────────────────────────────────
  {
    front: '辛亥革命的历史意义?',
    back: '① 推翻了清王朝,结束了两千多年的君主专制制度;\n② 建立中华民国,使民主共和观念深入人心;\n③ 促进民族资本主义发展;\n④ 局限:未改变半殖民地半封建的社会性质。',
    sourceText: '辛亥革命的意义与局限',
    collection: '历史',
    tags: ['近代史'],
    level: 3,
    dueOffsetDays: -10,
    reviewCount: 5,
  },
  {
    front: '五四运动的历史地位?',
    back: '① 是一次彻底的反帝反封建的爱国运动;\n② 是中国新民主主义革命的开端;\n③ 促进了马克思主义在中国的传播;\n④ 工人阶级开始登上政治舞台。',
    sourceText: '五四运动,新民主主义革命开端',
    collection: '历史',
    tags: ['近代史'],
    level: 2,
    dueOffsetDays: -2,
    reviewCount: 4,
  },
  {
    front: '改革开放的起点是哪次会议?',
    back: '1978 年 12 月召开的党的十一届三中全会。\n它重新确立了实事求是的思想路线,作出把党和国家工作中心转移到经济建设上来、实行改革开放的历史性决策。',
    sourceText: '改革开放起点:十一届三中全会',
    collection: '历史',
    tags: ['现代史'],
    level: 0,
    dueOffsetDays: -3,
    reviewCount: 0,
  },

  // ── 计算机 ──────────────────────────────────────────────
  {
    front: '常见排序算法的时间复杂度对比?',
    back: '快速排序:平均 O(n log n),最坏 O(n²)\n归并排序:稳定 O(n log n),空间 O(n)\n堆排序:O(n log n),原地\n冒泡/插入:平均 O(n²),最好 O(n)',
    sourceText: '排序算法复杂度对比表',
    collection: '计算机',
    tags: ['算法', '复杂度'],
    level: 4,
    dueOffsetDays: -4,
    reviewCount: 9,
  },
  {
    front: 'TCP 三次握手的过程?',
    back: '① 客户端发 SYN=1, seq=x;\n② 服务端回 SYN=1, ACK=1, seq=y, ack=x+1;\n③ 客户端发 ACK=1, ack=y+1。\n目的:确认双方收发能力正常,并同步初始序列号。',
    sourceText: 'TCP 三次握手流程图',
    collection: '计算机',
    tags: ['网络', 'TCP'],
    level: 3,
    dueOffsetDays: -1,
    reviewCount: 6,
  },

  // ── 未来到期的卡片(首页不显示,用于验证过滤逻辑) ────────
  {
    front: '什么是哈希表的负载因子?',
    back: '负载因子 = 已存元素数 / 桶数量。\n过高会导致冲突增多、查询退化;通常超过 0.75 就触发扩容(rehash)。',
    sourceText: '哈希表负载因子与扩容阈值',
    collection: '计算机',
    tags: ['数据结构'],
    level: 5,
    dueOffsetDays: 3,
    reviewCount: 14,
  },
  {
    front: '进程与线程的本质区别?',
    back: '进程是资源分配的基本单位,拥有独立地址空间;\n线程是 CPU 调度的基本单位,同一进程内的线程共享地址空间。\n因此线程切换开销远小于进程。',
    sourceText: '进程 vs 线程,资源分配 vs 调度单位',
    collection: '计算机',
    tags: ['操作系统'],
    level: 4,
    dueOffsetDays: 7,
    reviewCount: 8,
  },
  {
    front: '什么是矩阵的特征值与特征向量?',
    back: '若存在非零向量 x 和数 λ 使 Ax = λx,则 λ 为特征值,x 为对应的特征向量。\n几何意义:该向量在变换后方向不变,只被拉伸 λ 倍。',
    sourceText: '特征值特征向量定义与几何意义',
    collection: '数学',
    tags: ['线性代数'],
    level: 5,
    dueOffsetDays: 15,
    reviewCount: 10,
  },
  {
    front: '英语中 lie 与 lay 的区别?',
    back: 'lie(躺,不及物):lie - lay - lain - lying\nlay(放置,及物):lay - laid - laid - laying\n口诀:lie 自己躺,lay 把别人放。',
    sourceText: 'lie 和 lay 的变形与用法',
    collection: '英语',
    tags: ['词汇'],
    level: 3,
    dueOffsetDays: 2,
    reviewCount: 6,
  },
  {
    front: '热力学第一定律的表达式?',
    back: 'ΔU = Q + W(或 ΔU = Q - W,取决于符号约定)\n即:内能变化 = 吸收的热量 + 外界对系统做的功。\n本质是包含热现象的能量守恒定律。',
    sourceText: '热一律,能量守恒',
    collection: '物理',
    tags: ['热学'],
    level: 4,
    dueOffsetDays: 4,
    reviewCount: 7,
  },
  {
    front: '中国近代第一个不平等条约是什么?',
    back: '1842 年的《南京条约》。\n主要内容:割香港岛给英国、赔款 2100 万银元、开放五口通商、协定关税。\n它标志着中国开始沦为半殖民地半封建社会。',
    sourceText: '南京条约,第一个不平等条约',
    collection: '历史',
    tags: ['近代史'],
    level: 5,
    dueOffsetDays: 1,
    reviewCount: 13,
  },
]

/** 示例卡片使用的确定性 id 前缀。 */
export const SEED_ID_PREFIX = 'demo'

/** 由正面内容推导确定性 id —— 保证重复载入幂等。 */
export function seedCardId(front: string): string {
  return `${SEED_ID_PREFIX}-${hash32(front).toString(36)}`
}

/**
 * 依据声明式描述构造完整卡片(纯函数,时间可注入)。
 *
 * @param specs             卡片描述
 * @param collectionIdByName 合集名 → 合集 id
 * @param now               时间基准
 */
export function buildSeedCards(
  specs: readonly SeedSpec[],
  collectionIdByName: ReadonlyMap<string, string>,
  now: number = Date.now(),
): KnowledgeCard[] {
  return specs.map((spec) => {
    // 复用 createCard 的字段默认值,再覆盖种子特有的调度状态
    const base = createCard(
      {
        front: spec.front,
        back: spec.back,
        sourceText: spec.sourceText,
        collectionId: collectionIdByName.get(spec.collection) ?? 'inbox',
        tags: spec.tags,
        modelName: '示例数据',
      },
      now,
    )

    const intervalDays = intervalDaysForLevel(spec.level)
    const nextReviewAt = now + spec.dueOffsetDays * DAY_MS
    // 已复习过的卡,把上次复习时间设成"下次到期往前一个间隔",保持自洽
    const lastReviewedAt =
      spec.reviewCount > 0 && intervalDays > 0
        ? nextReviewAt - intervalDays * DAY_MS
        : spec.reviewCount > 0
          ? now - DAY_MS
          : 0

    return {
      ...base,
      id: seedCardId(spec.front),
      level: spec.level,
      intervalDays,
      ease: DEFAULT_EASE,
      syncState: stateForLevel(spec.level),
      lapses: spec.lapses ?? 0,
      nextReviewAt,
      lastReviewedAt,
      reviewCount: spec.reviewCount,
      passCount: spec.reviewCount,
      failCount: spec.lapses ?? 0,
      backEdited: false,
      deleted: false,
    }
  })
}

export interface SeedOptions {
  /** 时间基准(测试可注入) */
  now?: number
  /** 是否包含未来到期的卡片,默认 true */
  includeFuture?: boolean
  /** 只载入前 N 张(便于快速演示) */
  limit?: number
}

/**
 * 把示例数据写入仓储。
 *
 * 幂等:已存在的卡片会被跳过,所以可以放心地重复点击。
 * 缺失的合集会自动创建。
 */
export async function seedDemoData(
  repo: CardRepository,
  options: SeedOptions = {},
): Promise<ImportReport> {
  const now = options.now ?? Date.now()
  const specs = (options.includeFuture === false
    ? SEED_SPECS.filter((s) => s.dueOffsetDays <= 0)
    : SEED_SPECS
  ).slice(0, options.limit ?? SEED_SPECS.length)

  // 1. 补齐合集(已有的按名复用,不重复创建)
  const nameToId = new Map<string, string>()
  for (const name of SEED_COLLECTIONS) {
    const col = await repo.ensureCollection(name)
    nameToId.set(col.name, col.id)
  }

  // 2. 构造卡片,剔除仍然**有效**的(幂等保证)
  //
  // 注意:这里用 listCards()(只含未删除)而非 existingIds()(含软删记录)。
  // 否则「移除示例数据」(软删除)之后就无法重新载入 —— id 仍存在,
  // 会被误判成"已导入"而全部跳过。
  const live = await repo.listCards()
  const liveIds = new Set(live.map((c) => c.id))
  const all = buildSeedCards(specs, nameToId, now)
  const fresh = all.filter((c) => !liveIds.has(c.id))
  const skipped = all.length - fresh.length

  // 3. 批量写入(put 语义:已软删的同 id 卡片会被"复活"为示例卡)
  const added = await repo.addCards(fresh)

  return {
    added,
    skipped,
    collections: [...SEED_COLLECTIONS],
    warnings: [],
  }
}

/** 统计当前示例卡数量(未删除的)。管理员页展示用。 */
export async function countDemoData(repo: CardRepository): Promise<number> {
  const all = await repo.listCards()
  return all.filter((c) => c.id.startsWith(`${SEED_ID_PREFIX}-`)).length
}

/** 清除全部示例卡片(不动用户自己录入的卡)。 */
export async function clearDemoData(repo: CardRepository): Promise<number> {
  const all = await repo.listCards()
  const demo = all.filter((c) => c.id.startsWith(`${SEED_ID_PREFIX}-`))
  for (const card of demo) {
    await repo.removeCard(card.id)
  }
  return demo.length
}
