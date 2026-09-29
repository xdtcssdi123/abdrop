/**
 * Anki 模型映射与导入编排测试。
 *
 * 覆盖:确定性 id(幂等导入的关键)、牌组→合集、标签清洗、
 * 以及「同一份 apkg 导入两次不产生重复卡片」这条最重要的验收项。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildCollectionPlan,
  cardToAnkiRow,
  extractImageRefs,
  hash32,
  missingCollections,
  normalizeTags,
  noteToCard,
  planAnkiImport,
  stableCardId,
  stripImagePlaceholders,
} from '~/lib/anki-map'
import { importParsedAnki } from '~/lib/anki-io'
import { createMemoryRepository, type CardRepository } from '~/lib/db'
import type { AnkiNote } from '~/lib/anki'
import { DEFAULT_EASE } from '~/lib/srs'

function makeNote(over: Partial<AnkiNote> = {}): AnkiNote {
  return {
    noteId: 'n1',
    front: '问题',
    back: '答案',
    extraFields: [],
    tags: [],
    deck: 'Default',
    modelName: 'Basic',
    ...over,
  }
}

describe('确定性 id', () => {
  it('相同输入产生相同 id —— 这是导入幂等的基础', () => {
    expect(stableCardId('n1', 'Q', 'A')).toBe(stableCardId('n1', 'Q', 'A'))
  })

  it('不同 noteId 或不同内容产生不同 id', () => {
    expect(stableCardId('n1', 'Q', 'A')).not.toBe(stableCardId('n2', 'Q', 'A'))
    expect(stableCardId('n1', 'Q', 'A')).not.toBe(stableCardId('n1', 'Q', 'B'))
  })

  it('id 带 anki- 前缀,便于溯源', () => {
    expect(stableCardId('n1', 'Q', 'A').startsWith('anki-')).toBe(true)
  })

  it('hash32 是确定性的且分布在 32 位内', () => {
    expect(hash32('abc')).toBe(hash32('abc'))
    expect(hash32('abc')).toBeGreaterThanOrEqual(0)
    expect(hash32('abc')).toBeLessThan(2 ** 32)
  })

  it('hash32 对相近字符串也能区分', () => {
    expect(hash32('abc')).not.toBe(hash32('abd'))
  })

  it('字段拼接不会因边界产生碰撞', () => {
    // "a\u0000b" 与 "ab" 必须不同
    expect(stableCardId('n', 'a', 'b')).not.toBe(stableCardId('n', 'ab', ''))
  })
})

describe('标签清洗', () => {
  it('去空白、去重、去前导 #', () => {
    expect(normalizeTags([' #数学 ', '数学', '数学 '])).toEqual(['数学'])
  })

  it('忽略大小写重复', () => {
    expect(normalizeTags(['Math', 'math'])).toEqual(['Math'])
  })

  it('剔除空串', () => {
    expect(normalizeTags(['', '  ', 'ok'])).toEqual(['ok'])
  })

  it('限制数量上限,防止异常数据撑爆', () => {
    const many = Array.from({ length: 100 }, (_, i) => `tag${i}`)
    expect(normalizeTags(many, 10)).toHaveLength(10)
  })

  it('剔除超长标签', () => {
    expect(normalizeTags(['x'.repeat(100)])).toEqual([])
  })
})

describe('图片占位处理', () => {
  it('提取所有图片引用', () => {
    expect(extractImageRefs('前[[img:a.png]]后[[img:b.jpg]]')).toEqual(['a.png', 'b.jpg'])
  })

  it('无引用时返回空数组', () => {
    expect(extractImageRefs('纯文本')).toEqual([])
  })

  it('从正文中移除占位符并压缩空行', () => {
    expect(stripImagePlaceholders('甲\n[[img:a.png]]\n\n\n乙')).toBe('甲\n\n乙')
  })
})

describe('noteToCard 映射', () => {
  const now = 1_700_000_000_000

  it('Front/Back 正确对位', () => {
    const card = noteToCard(makeNote(), { now })
    expect(card.front).toBe('问题')
    expect(card.back).toBe('答案')
  })

  it('front 为空时用模板名兜底,避免出现空卡片', () => {
    const card = noteToCard(makeNote({ front: '' }), { now })
    expect(card.front).toBe('Basic')
  })

  it('额外字段并入背面', () => {
    const card = noteToCard(makeNote({ extraFields: ['补充'] }), { now })
    expect(card.back).toContain('答案')
    expect(card.back).toContain('补充')
  })

  it('图片引用被解析成 imageUri', () => {
    const card = noteToCard(makeNote({ front: 'Q[[img:p.png]]' }), {
      now,
      media: { 'p.png': 'data:image/png;base64,AAA' },
    })
    expect(card.imageUri).toBe('data:image/png;base64,AAA')
    expect(card.front).toBe('Q')
  })

  it('媒体缺失时 imageUri 留空,不产生坏图', () => {
    const card = noteToCard(makeNote({ front: 'Q[[img:missing.png]]' }), { now, media: {} })
    expect(card.imageUri).toBe('')
  })

  it('标签被清洗后存入', () => {
    const card = noteToCard(makeNote({ tags: ['#数学', '数学', '英语'] }), { now })
    expect(card.tags).toEqual(['数学', '英语'])
  })

  it('保留 Anki 的调度字段', () => {
    const card = noteToCard(makeNote(), { now, intervalDays: 4, ankiType: 2, ease: 2600, lapses: 3 })
    expect(card.intervalDays).toBe(4)
    expect(card.ease).toBe(2600)
    expect(card.lapses).toBe(3)
    expect(card.level).toBe(3)
  })

  it('ease 非法时回落默认值', () => {
    expect(noteToCard(makeNote(), { now, ease: 0 }).ease).toBe(DEFAULT_EASE)
  })

  it('导入的卡片立即可见(nextReviewAt = now)', () => {
    const card = noteToCard(makeNote(), { now })
    expect(card.nextReviewAt).toBe(now)
  })

  it('保留 ankiNoteId 以便溯源与去重', () => {
    expect(noteToCard(makeNote({ noteId: 'abc' }), { now }).ankiNoteId).toBe('abc')
  })

  it('sourceText 是正反面拼合,供后续 AI 再归纳', () => {
    const card = noteToCard(makeNote(), { now })
    expect(card.sourceText).toBe('问题\n答案')
  })

  it('未删除、未编辑,状态干净', () => {
    const card = noteToCard(makeNote(), { now })
    expect(card.deleted).toBe(false)
    expect(card.backEdited).toBe(false)
    expect(card.reviewCount).toBe(0)
  })
})

describe('牌组 → 合集计划', () => {
  it('末级牌组名成为合集名', () => {
    const { names, byDeck } = buildCollectionPlan([
      makeNote({ deck: '考研::数学' }),
      makeNote({ deck: '考研::英语' }),
    ])
    expect(names).toEqual(['数学', '英语'])
    expect(byDeck['考研::数学']).toBe('数学')
  })

  it('无牌组时回落到未分类', () => {
    expect(buildCollectionPlan([makeNote({ deck: '' })]).names).toEqual(['未分类'])
  })

  it('同名牌组只产生一个合集', () => {
    const { names } = buildCollectionPlan([
      makeNote({ deck: 'Default' }),
      makeNote({ deck: 'Default' }),
    ])
    expect(names).toEqual(['Default'])
  })

  it('missingCollections 只补不存在的', () => {
    const existing = [{ id: 'x', name: '数学', order: 0, createdAt: 0 }]
    const add = missingCollections(['数学', '英语'], existing)
    expect(add).toHaveLength(1)
    expect(add[0]!.name).toBe('英语')
  })

  it('missingCollections 生成的 id 是确定性的', () => {
    const a = missingCollections(['英语'], [])
    const b = missingCollections(['英语'], [])
    expect(a[0]!.id).toBe(b[0]!.id)
  })
})

describe('planAnkiImport', () => {
  const now = 1_700_000_000_000

  it('把笔记铺平成卡片', () => {
    const { cards, report } = planAnkiImport(
      { notes: [makeNote(), makeNote({ noteId: 'n2' })], warnings: [], media: {} },
      new Set(),
      new Map([['Default', 'col-1']]),
      now,
    )
    expect(cards).toHaveLength(2)
    expect(report.added).toBe(2)
    expect(cards[0]!.collectionId).toBe('col-1')
  })

  it('已存在的 id 被跳过,不重复导入', () => {
    const note = makeNote()
    const existing = new Set([stableCardId(note.noteId, note.front, note.back)])
    const { cards, report } = planAnkiImport(
      { notes: [note], warnings: [], media: {} },
      existing,
      new Map(),
      now,
    )
    expect(cards).toHaveLength(0)
    expect(report.skipped).toBe(1)
  })

  it('空内容笔记被跳过', () => {
    const { report } = planAnkiImport(
      { notes: [makeNote({ front: '', back: '', modelName: '' })], warnings: [], media: {} },
      new Set(),
      new Map(),
      now,
    )
    expect(report.skipped).toBe(1)
  })

  it('未知牌组回落到默认合集,不会丢卡', () => {
    const { cards } = planAnkiImport(
      { notes: [makeNote({ deck: '未登记的牌组' })], warnings: [], media: {} },
      new Set(),
      new Map(),
      now,
    )
    expect(cards[0]!.collectionId).toBe('inbox')
  })

  it('透传解析阶段的警告并补充跳过统计', () => {
    const { report } = planAnkiImport(
      { notes: [makeNote()], warnings: ['模板缺失'], media: {} },
      new Set([stableCardId('n1', '问题', '答案')]),
      new Map(),
      now,
    )
    expect(report.warnings.some((w) => w.includes('模板缺失'))).toBe(true)
    expect(report.warnings.some((w) => w.includes('跳过'))).toBe(true)
  })
})

describe('cardToAnkiRow 导出映射', () => {
  it('带上等级标签,便于在 Anki 侧筛选', () => {
    const card = noteToCard(makeNote({ tags: ['数学'] }), { now: 0 })
    const row = cardToAnkiRow(card, '考研')
    expect(row.tags).toContain('数学')
    expect(row.tags).toContain('abdrop-lv0')
    expect(row.deck).toBe('考研')
  })

  it('无合集名时用 ABDrop 作为默认牌组', () => {
    expect(cardToAnkiRow(noteToCard(makeNote(), { now: 0 })).deck).toBe('ABDrop')
  })
})

describe('importParsedAnki 编排', () => {
  let repo: CardRepository

  beforeEach(() => {
    repo = createMemoryRepository()
  })

  it('导入后卡片入库,且牌组变成合集', async () => {
    const report = await importParsedAnki(
      {
        notes: [makeNote({ deck: '考研::数学' }), makeNote({ noteId: 'n2', deck: '考研::英语' })],
        warnings: [],
        media: {},
      },
      repo,
      1000,
    )
    expect(report.added).toBe(2)
    expect(report.collections).toEqual(['数学', '英语'])
    const cols = await repo.listCollections()
    expect(cols.map((c) => c.name)).toEqual(['未分类', '数学', '英语'])
  })

  it('同一份数据导入两次不产生重复卡片(幂等)', async () => {
    const parsed = { notes: [makeNote()], warnings: [], media: {} }

    const first = await importParsedAnki(parsed, repo, 1000)
    const second = await importParsedAnki(parsed, repo, 2000)

    expect(first.added).toBe(1)
    expect(second.added).toBe(0)
    expect(second.skipped).toBe(1)
    expect(await repo.countCards()).toBe(1)
  })

  it('重复导入不会重复创建同名合集', async () => {
    const parsed = { notes: [makeNote({ deck: '数学' })], warnings: [], media: {} }
    await importParsedAnki(parsed, repo, 1000)
    await importParsedAnki(parsed, repo, 2000)
    const cols = await repo.listCollections()
    expect(cols.filter((c) => c.name === '数学')).toHaveLength(1)
  })

  it('空解析结果返回警告而不写库', async () => {
    const report = await importParsedAnki({ notes: [], warnings: [], media: {} }, repo)
    expect(report.added).toBe(0)
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(await repo.countCards()).toBe(0)
  })

  it('导入的卡片立刻可复习(在到期池里)', async () => {
    await importParsedAnki({ notes: [makeNote()], warnings: [], media: {} }, repo, 1000)
    const due = await repo.listDueCards(1000)
    expect(due).toHaveLength(1)
    expect(due[0]!.front).toBe('问题')
  })

  it('导入后可以直接参与调度,进度被正确推进', async () => {
    await importParsedAnki(
      { notes: [makeNote()], warnings: [], media: {} },
      repo,
      1000,
    )
    const due = await repo.listDueCards(1000)
    expect(due[0]!.level).toBe(0)

    // 复习一次后不再到期
    const card = due[0]!
    await repo.putCard({ ...card, level: 1, nextReviewAt: 1000 + 86400000 })
    expect(await repo.listDueCards(1000)).toHaveLength(0)
  })
})
