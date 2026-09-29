/**
 * 真实 .apkg 端到端测试。
 *
 * 不用假数据:本文件用 sql.js 现场构造一个结构与 Anki 一致的
 * collection.anki2(SQLite),连同 media 索引一起 zip 成 .apkg,
 * 再用生产代码 parseApkg 解回来。这是"兼容 Anki"最硬的证据。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { FIELD_SEPARATOR, parseApkg } from '~/lib/anki'

let SQL: SqlJsStatic

beforeAll(async () => {
  SQL = await initSqlJs()
})

/** Anki 的 models JSON 结构(只保留本测试关心的字段)。 */
function modelsJson(): string {
  return JSON.stringify({
    '1000': {
      id: 1000,
      name: 'Basic',
      flds: [
        { name: 'Front', ord: 0 },
        { name: 'Back', ord: 1 },
      ],
      tmpls: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
    },
    '1001': {
      id: 1001,
      name: 'Basic (and reversed card)',
      flds: [
        { name: 'Front', ord: 0 },
        { name: 'Back', ord: 1 },
      ],
      tmpls: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{Back}}' }],
    },
  })
}

/** Anki 的 decks JSON 结构。 */
function decksJson(): string {
  return JSON.stringify({
    '1': { id: 1, name: 'Default' },
    '2000': { id: 2000, name: '考研::数学' },
  })
}

/** 构造一个真实 apkg 的字节流。 */
function buildApkg(
  notes: Array<{ id: number; mid: number; flds: string[]; tags: string; did: number }>,
  options: { media?: Record<string, string>; mediaFiles?: Record<string, Uint8Array> } = {},
): Uint8Array {
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT, tags TEXT);
    CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ivl INTEGER, factor INTEGER, type INTEGER, lapses INTEGER);
  `)

  db.run('INSERT INTO col (id, models, decks) VALUES (1, ?, ?);', [modelsJson(), decksJson()])

  notes.forEach((n, i) => {
    db.run('INSERT INTO notes (id, mid, flds, tags) VALUES (?, ?, ?, ?);', [
      n.id,
      n.mid,
      n.flds.join(FIELD_SEPARATOR),
      n.tags,
    ])
    db.run(
      'INSERT INTO cards (id, nid, did, ivl, factor, type, lapses) VALUES (?, ?, ?, ?, ?, ?, ?);',
      [n.id * 10 + 1, n.id, n.did, i * 2, 2500, i === 0 ? 0 : 2, 0],
    )
  })

  const sqliteBytes = db.export()
  db.close()

  const zipEntries: Record<string, Uint8Array> = {
    'collection.anki2': sqliteBytes,
  }
  if (options.media) {
    zipEntries['media'] = strToU8(JSON.stringify(options.media))
    for (const [idx, bytes] of Object.entries(options.mediaFiles ?? {})) {
      zipEntries[idx] = bytes
    }
  }

  return zipSync(zipEntries)
}

/** 一张 1x1 透明 PNG。 */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
])

describe('parseApkg 端到端', () => {
  it('能从真实结构里读出笔记', async () => {
    const apkg = buildApkg([
      { id: 1, mid: 1000, flds: ['什么是极限', '描述趋近过程'], tags: '数学', did: 1 },
      { id: 2, mid: 1000, flds: ['什么是导数', '瞬时变化率'], tags: '数学 微积分', did: 1 },
    ])

    const res = await parseApkg(apkg)
    expect(res.notes).toHaveLength(2)
    expect(res.notes[0]!.front).toBe('什么是极限')
    expect(res.notes[0]!.back).toBe('描述趋近过程')
    expect(res.warnings).toEqual([])
  })

  it('用模板渲染出真正的正反面:背面只留答案,不重复题面', async () => {
    const apkg = buildApkg([{ id: 1, mid: 1000, flds: ['Q', 'A'], tags: '', did: 1 }])
    const res = await parseApkg(apkg)
    // afmt = {{FrontSide}}<hr id=answer>{{Back}}
    // FrontSide 是给 Anki 复现题面用的,ABDrop 的背面只放答案
    expect(res.notes[0]!.front).toBe('Q')
    expect(res.notes[0]!.back).toBe('A')
    expect(res.notes[0]!.back).not.toContain('<hr')
  })

  it('答案模板不含 FrontSide 时也能正确取到答案', async () => {
    // mid 1001 的 afmt 就是裸 {{Back}}
    const apkg = buildApkg([{ id: 1, mid: 1001, flds: ['Q', 'A'], tags: '', did: 1 }])
    const res = await parseApkg(apkg)
    expect(res.notes[0]!.front).toBe('Q')
    expect(res.notes[0]!.back).toBe('A')
  })

  it('解析标签', async () => {
    const apkg = buildApkg([{ id: 1, mid: 1000, flds: ['Q', 'A'], tags: '数学 极限', did: 1 }])
    const res = await parseApkg(apkg)
    expect(res.notes[0]!.tags).toEqual(['数学', '极限'])
  })

  it('解析牌组名(保留 Anki 的层级写法)', async () => {
    const apkg = buildApkg([{ id: 1, mid: 1000, flds: ['Q', 'A'], tags: '', did: 2000 }])
    const res = await parseApkg(apkg)
    expect(res.notes[0]!.deck).toBe('考研::数学')
  })

  it('解析笔记模板名', async () => {
    const apkg = buildApkg([{ id: 1, mid: 1001, flds: ['Q', 'A'], tags: '', did: 1 }])
    const res = await parseApkg(apkg)
    expect(res.notes[0]!.modelName).toBe('Basic (and reversed card)')
  })

  it('清理字段里的 HTML', async () => {
    const apkg = buildApkg([
      { id: 1, mid: 1000, flds: ['<b>加粗</b>问题', '<div>答案</div>'], tags: '', did: 1 },
    ])
    const res = await parseApkg(apkg)
    expect(res.notes[0]!.front).toBe('加粗问题')
    expect(res.notes[0]!.back).not.toContain('<div>')
  })

  it('保留超出模板字段的额外内容', async () => {
    const apkg = buildApkg([
      { id: 1, mid: 1000, flds: ['Q', 'A', '补充说明'], tags: '', did: 1 },
    ])
    const res = await parseApkg(apkg)
    expect(res.notes[0]!.extraFields).toEqual(['补充说明'])
  })

  it('把引用的图片导出为 dataURL', async () => {
    const apkg = buildApkg([{ id: 1, mid: 1000, flds: ['Q<img src="pic.png">', 'A'], tags: '', did: 1 }], {
      media: { '0': 'pic.png' },
      mediaFiles: { '0': TINY_PNG },
    })
    const res = await parseApkg(apkg)
    expect(res.media['pic.png']).toMatch(/^data:image\/png;base64,/)
    expect(res.notes[0]!.front).toContain('[[img:pic.png]]')
  })

  it('未引用的媒体不加载,避免无谓解码', async () => {
    const apkg = buildApkg([{ id: 1, mid: 1000, flds: ['Q', 'A'], tags: '', did: 1 }], {
      media: { '0': 'unused.png' },
      mediaFiles: { '0': TINY_PNG },
    })
    const res = await parseApkg(apkg)
    expect(Object.keys(res.media)).toHaveLength(0)
  })

  it('loadMedia=false 时完全跳过媒体处理', async () => {
    const apkg = buildApkg([{ id: 1, mid: 1000, flds: ['Q<img src="pic.png">', 'A'], tags: '', did: 1 }], {
      media: { '0': 'pic.png' },
      mediaFiles: { '0': TINY_PNG },
    })
    const res = await parseApkg(apkg, false)
    expect(res.media).toEqual({})
  })

  it('空笔记集合给出警告而不是崩溃', async () => {
    const apkg = buildApkg([])
    const res = await parseApkg(apkg)
    expect(res.notes).toHaveLength(0)
    expect(res.warnings.length).toBeGreaterThan(0)
  })

  it('非 zip 内容返回可读错误,不抛异常', async () => {
    const res = await parseApkg(strToU8('这显然不是一个 zip 文件'))
    expect(res.notes).toHaveLength(0)
    expect(res.warnings[0]).toContain('apkg')
  })

  it('zip 里缺 collection 文件时明确报错', async () => {
    const apkg = zipSync({ 'readme.txt': strToU8('hello') })
    const res = await parseApkg(apkg)
    expect(res.warnings[0]).toContain('collection')
  })

  it('损坏的 SQLite 被捕获为警告', async () => {
    const apkg = zipSync({ 'collection.anki2': strToU8('not a database at all') })
    const res = await parseApkg(apkg)
    expect(res.notes).toHaveLength(0)
    expect(res.warnings.length).toBeGreaterThan(0)
  })

  it('models 缺失时降级按前两字段解析,仍然可用', async () => {
    // 手搓一个没有 models 的库
    const db = new SQL.Database()
    db.run('CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT);')
    db.run("INSERT INTO col VALUES (1, '', '');")
    db.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT, tags TEXT);')
    db.run('CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER);')
    db.run('INSERT INTO notes VALUES (1, 1000, ?, "");', [['问题', '答案'].join(FIELD_SEPARATOR)])
    db.run('INSERT INTO cards VALUES (11, 1, 1);')
    const bytes = db.export()
    db.close()

    const res = await parseApkg(zipSync({ 'collection.anki2': bytes }))
    expect(res.notes).toHaveLength(1)
    expect(res.notes[0]!.front).toBe('问题')
    expect(res.notes[0]!.back).toBe('答案')
    expect(res.warnings.join('')).toContain('模板')
  })

  it('多条笔记且牌组不同,逐一正确归类', async () => {
    const apkg = buildApkg([
      { id: 1, mid: 1000, flds: ['Q1', 'A1'], tags: 'a', did: 1 },
      { id: 2, mid: 1000, flds: ['Q2', 'A2'], tags: 'b', did: 2000 },
      { id: 3, mid: 1000, flds: ['Q3', 'A3'], tags: '', did: 2000 },
    ])
    const res = await parseApkg(apkg)
    expect(res.notes).toHaveLength(3)
    expect(res.notes[0]!.deck).toBe('Default')
    expect(res.notes[1]!.deck).toBe('考研::数学')
    expect(res.notes[2]!.deck).toBe('考研::数学')
  })

  it('大量笔记也能完整读出(分块路径)', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      mid: 1000,
      flds: [`问题${i}`, `答案${i}`],
      tags: 'bulk',
      did: 1,
    }))
    const res = await parseApkg(buildApkg(many))
    expect(res.notes).toHaveLength(200)
    expect(res.notes[199]!.front).toBe('问题199')
  })
})
