/**
 * Anki 互操作测试 —— HTML 清洗、文本解析、模板渲染、导出格式。
 * 这是"兼容 Anki"这一诉求的验收面。
 */
import { describe, expect, it } from 'vitest'
import {
  FIELD_SEPARATOR,
  ankiExportFilename,
  bytesToBase64,
  decodeEntities,
  emptyResult,
  findCollectionFile,
  parseAnkiText,
  parseTextHeader,
  renderAnkiTemplate,
  sniffSeparator,
  splitRespectingQuotes,
  splitTags,
  stripHtml,
  toAnkiCsv,
  toAnkiTsv,
  zipFields,
} from '~/lib/anki'

/**
 * 取导出的最后一行数据。
 * 刻意不 trim 整串 —— 末列可能为空,trim 会把那一列连 tab 一起吃掉,
 * 造成"列数少了"的假象。
 */
function lastDataLine(exported: string): string {
  const lines = exported.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'))
  return lines[lines.length - 1] ?? ''
}

describe('HTML 清洗', () => {
  it('剥离标签保留文字', () => {
    expect(stripHtml('<b>重点</b>内容')).toBe('重点内容')
  })

  it('br 转成换行', () => {
    expect(stripHtml('第一行<br>第二行')).toBe('第一行\n第二行')
  })

  it('块级标签闭合转成换行', () => {
    expect(stripHtml('<div>甲</div><div>乙</div>')).toBe('甲\n乙')
  })

  it('列表项带项目符号', () => {
    expect(stripHtml('<ul><li>一</li><li>二</li></ul>')).toContain('· 一')
  })

  it('图片标签转成占位符', () => {
    expect(stripHtml('<img src="a.png">')).toBe('[[img:a.png]]')
  })

  it('音频标签转成占位符', () => {
    expect(stripHtml('[sound:voice.mp3]')).toBe('[[audio:voice.mp3]]')
  })

  it('解码 HTML 实体', () => {
    expect(stripHtml('a &amp; b &lt; c &nbsp;d')).toBe('a & b < c  d')
  })

  it('压缩多余空行', () => {
    expect(stripHtml('甲<br><br><br><br>乙')).toBe('甲\n\n乙')
  })

  it('空输入返回空串', () => {
    expect(stripHtml('')).toBe('')
  })

  it('纯文本原样保留', () => {
    expect(stripHtml('  普通文本  ')).toBe('普通文本')
  })

  it('样式脚本内容不残留标签', () => {
    expect(stripHtml('<span style="color:red">红</span>')).toBe('红')
  })
})

describe('实体解码', () => {
  it('十进制实体', () => {
    expect(decodeEntities('&#65;')).toBe('A')
  })

  it('十六进制实体', () => {
    expect(decodeEntities('&#x4e2d;')).toBe('中')
  })

  it('命名实体', () => {
    expect(decodeEntities('&hellip;&mdash;')).toBe('…—')
  })

  it('未知实体原样保留,不吞字符', () => {
    expect(decodeEntities('&unknownthing;')).toBe('&unknownthing;')
  })

  it('非法码点不抛异常', () => {
    expect(() => decodeEntities('&#999999999;')).not.toThrow()
  })
})

describe('文本导出头部解析', () => {
  it('识别 tab 分隔符', () => {
    expect(parseTextHeader('#separator:tab\n').separator).toBe('\t')
  })

  it('识别具名分隔符', () => {
    expect(parseTextHeader('#separator:comma\n').separator).toBe(',')
    expect(parseTextHeader('#separator:pipe\n').separator).toBe('|')
  })

  it('识别自定义分隔符', () => {
    expect(parseTextHeader('#separator:;\n').separator).toBe(';')
  })

  it('识别 html 开关', () => {
    expect(parseTextHeader('#html:true\n').html).toBe(true)
    expect(parseTextHeader('#html:false\n').html).toBe(false)
  })

  it('识别 columns 并定位 tags/deck 列', () => {
    const h = parseTextHeader(
      '#separator:tab\n#html:false\n#columns:Front\tBack\tTags\tDeck\n#tags column:3\n#deck column:4\n',
    )
    expect(h.columns).toEqual(['front', 'back', 'tags', 'deck'])
    // 头部里是 1 起算的列号,内部统一转成 0 起算的数组下标
    expect(h.tagsColumn).toBe(2)
    expect(h.deckColumn).toBe(3)
  })

  it('列号 0 或非法值被识别为"未声明"', () => {
    expect(parseTextHeader('#tags column:0\n').tagsColumn).toBe(-1)
    expect(parseTextHeader('#tags column:abc\n').tagsColumn).toBe(-1)
  })

  it('无头部时给出安全默认值', () => {
    const h = parseTextHeader('没有头部')
    expect(h.separator).toBe('\t')
    expect(h.tagsColumn).toBe(-1)
  })
})

describe('分隔符嗅探', () => {
  it('优先识别出现最多的候选', () => {
    expect(sniffSeparator('a\tb\tc')).toBe('\t')
    expect(sniffSeparator('a,b,c')).toBe(',')
  })

  it('无分隔符时默认 tab', () => {
    expect(sniffSeparator('abc')).toBe('\t')
  })
})

describe('带引号的字段切分', () => {
  it('简单切分', () => {
    expect(splitRespectingQuotes('a\tb\tc', '\t')).toEqual(['a', 'b', 'c'])
  })

  it('引号内的分隔符不被切开', () => {
    expect(splitRespectingQuotes('"a,b",c', ',')).toEqual(['a,b', 'c'])
  })

  it('双引号转义', () => {
    expect(splitRespectingQuotes('"say ""hi""",b', ',')).toEqual(['say "hi"', 'b'])
  })

  it('空字段保留,保证列对齐', () => {
    expect(splitRespectingQuotes('a\t\tc', '\t')).toEqual(['a', '', 'c'])
  })
})

describe('纯文本导入解析', () => {
  it('解析基本 TSV 两列', () => {
    const res = parseAnkiText('#separator:tab\n#html:false\n问题一\t答案一\n问题二\t答案二\n')
    expect(res.notes).toHaveLength(2)
    expect(res.notes[0]!.front).toBe('问题一')
    expect(res.notes[0]!.back).toBe('答案一')
  })

  it('按 #tags column 提取标签', () => {
    const res = parseAnkiText(
      '#separator:tab\n#html:false\n#columns:Front\tBack\tTags\n#tags column:3\nQ\tA\t数学 极限\n',
    )
    expect(res.notes[0]!.tags).toEqual(['数学', '极限'])
  })

  it('按 #deck column 提取牌组名', () => {
    const res = parseAnkiText(
      '#separator:tab\n#html:false\n#columns:Front\tBack\tTags\tDeck\n#tags column:3\n#deck column:4\nQ\tA\t\t考研数学\n',
    )
    expect(res.notes[0]!.deck).toBe('考研数学')
  })

  it('html:true 时清洗标签', () => {
    const res = parseAnkiText('#separator:tab\n#html:true\n<b>Q</b>\t<i>A</i>\n')
    expect(res.notes[0]!.front).toBe('Q')
    expect(res.notes[0]!.back).toBe('A')
  })

  it('无头部时自动嗅探 CSV', () => {
    const res = parseAnkiText('Q1,A1\nQ2,A2\n')
    expect(res.notes).toHaveLength(2)
    expect(res.notes[0]!.back).toBe('A1')
  })

  it('跳过注释行与空行', () => {
    const res = parseAnkiText('#separator:tab\n\n\nQ\tA\n\n')
    expect(res.notes).toHaveLength(1)
  })

  it('整行空白被忽略', () => {
    const res = parseAnkiText('#separator:tab\n\t\t\nQ\tA\n')
    expect(res.notes).toHaveLength(1)
  })

  it('无有效数据时给出警告', () => {
    const res = parseAnkiText('#separator:tab\n')
    expect(res.notes).toHaveLength(0)
    expect(res.warnings.length).toBeGreaterThan(0)
  })

  it('CSV 引号内的逗号被正确保留', () => {
    const res = parseAnkiText('#separator:comma\n"a,b",c\n')
    expect(res.notes[0]!.front).toBe('a,b')
    expect(res.notes[0]!.back).toBe('c')
  })

  it('超出两列的其余字段进 extraFields', () => {
    const res = parseAnkiText('#separator:tab\nQ\tA\t额外\n')
    expect(res.notes[0]!.extraFields).toEqual(['额外'])
  })
})

describe('标签切分', () => {
  it('空格分隔', () => {
    expect(splitTags('a b c')).toEqual(['a', 'b', 'c'])
  })

  it('去掉前导 #', () => {
    expect(splitTags('#math #physics')).toEqual(['math', 'physics'])
  })

  it('空输入返回空数组', () => {
    expect(splitTags('')).toEqual([])
  })
})

describe('Anki 模板渲染', () => {
  const fields = { Front: '问题', Back: '答案', Extra: '' }

  it('替换普通字段', () => {
    expect(renderAnkiTemplate('{{Front}}', fields)).toBe('问题')
  })

  it('FrontSide 原样嵌入', () => {
    expect(renderAnkiTemplate('{{FrontSide}}<hr>{{Back}}', fields, '问题')).toBe('问题<hr>答案')
  })

  it('条件块在字段非空时展开', () => {
    expect(renderAnkiTemplate('{{#Back}}有答案{{/Back}}', fields)).toBe('有答案')
  })

  it('条件块在字段为空时消失', () => {
    expect(renderAnkiTemplate('{{#Extra}}有额外{{/Extra}}', fields)).toBe('')
  })

  it('反向条件块语义相反', () => {
    expect(renderAnkiTemplate('{{^Extra}}无额外{{/Extra}}', fields)).toBe('无额外')
  })

  it('带前缀的字段表达式能取到值', () => {
    expect(renderAnkiTemplate('{{type:Front}}', fields)).toBe('问题')
  })

  it('未知字段渲染为空串,不残留花括号', () => {
    expect(renderAnkiTemplate('[{{Nope}}]', fields)).toBe('[]')
  })
})

describe('字段映射与工具', () => {
  it('zipFields 按名字对齐值', () => {
    expect(zipFields(['a', 'b'], ['1', '2'])).toEqual({ a: '1', b: '2' })
  })

  it('值不足时补空串', () => {
    expect(zipFields(['a', 'b'], ['1'])).toEqual({ a: '1', b: '' })
  })

  it('字段分隔符是 ASCII 31', () => {
    expect(FIELD_SEPARATOR).toBe('\x1f')
    expect(FIELD_SEPARATOR.charCodeAt(0)).toBe(31)
  })

  it('emptyResult 结构完整', () => {
    expect(emptyResult()).toEqual({ notes: [], warnings: [], media: {} })
  })

  it('findCollectionFile 优先新版文件名', () => {
    expect(findCollectionFile({ 'collection.anki21': new Uint8Array() } as any)).toBe(
      'collection.anki21',
    )
  })

  it('findCollectionFile 兼容旧版', () => {
    expect(findCollectionFile({ 'collection.anki2': new Uint8Array() } as any)).toBe(
      'collection.anki2',
    )
  })

  it('找不到集合文件时返回 null', () => {
    expect(findCollectionFile({ 'other.txt': new Uint8Array() } as any)).toBeNull()
  })

  it('bytesToBase64 正确编码', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=')
  })

  it('bytesToBase64 处理较大输入(走分块路径)', () => {
    const big = new Uint8Array(70000).fill(65)
    expect(bytesToBase64(big).length).toBeGreaterThan(90000)
  })
})

describe('Anki 导出格式', () => {
  const rows = [
    { front: 'Q1', back: 'A1', tags: ['数学'] },
    { front: 'Q2', back: 'A2', tags: [] },
  ]

  it('TSV 带 Anki 可识别的头部', () => {
    const tsv = toAnkiTsv(rows)
    expect(tsv.startsWith('#separator:tab')).toBe(true)
    expect(tsv).toContain('#tags column:3')
  })

  it('TSV 每行是 tab 分隔的三列', () => {
    const dataLine = lastDataLine(toAnkiTsv(rows))
    expect(dataLine.split('\t')).toHaveLength(3)
  })

  it('includeDeck 时多出一列牌组', () => {
    const dataLine = lastDataLine(toAnkiTsv([{ ...rows[0]!, deck: '考研' }], true))
    expect(dataLine.split('\t')).toHaveLength(4)
    expect(dataLine).toContain('考研')
  })

  it('换行被转成 <br>,不破坏一行一卡的结构', () => {
    const dataLine = lastDataLine(toAnkiTsv([{ front: 'a\nb', back: 'c', tags: [] }]))
    expect(dataLine).toContain('<br>')
  })

  it('字段内的 tab 被替换,不会多切一列', () => {
    const dataLine = lastDataLine(toAnkiTsv([{ front: 'a\tb', back: 'c', tags: [] }]))
    expect(dataLine.split('\t')).toHaveLength(3)
  })

  it('CSV 用引号包裹并转义内部引号', () => {
    const csv = toAnkiCsv([{ front: 'say "hi"', back: 'b', tags: [] }])
    expect(csv).toContain('"say ""hi"""')
  })

  it('导出文件名带时间戳且符合扩展名', () => {
    const name = ankiExportFilename('abdrop-anki', 'tsv', new Date(2026, 0, 5, 9, 7))
    expect(name).toMatch(/^abdrop-anki-\d{8}-\d{4}\.tsv$/)
    expect(name).toContain('20260105')
  })

  it('导出的 TSV 能被自己的解析器读回(往返一致性)', () => {
    const tsv = toAnkiTsv([
      { front: '什么是极限', back: '描述趋近过程', tags: ['数学'] },
      { front: '导数定义', back: '变化率', tags: [] },
    ])
    const back = parseAnkiText(tsv)
    expect(back.notes).toHaveLength(2)
    expect(back.notes[0]!.front).toBe('什么是极限')
    expect(back.notes[0]!.tags).toEqual(['数学'])
  })
})
