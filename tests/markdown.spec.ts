/**
 * Markdown 渲染器测试 —— 基于 markdown-it + DOMPurify。
 * 重点:安全(答案来自用户/AI,不允许原始 HTML 直通)与输出结构。
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '~/lib/markdown'

describe('renderMarkdown —— 块级语法', () => {
  it('标题 # 到 ######', () => {
    expect(renderMarkdown('# 大标题')).toBe('<h1>大标题</h1>')
    expect(renderMarkdown('## 二级')).toBe('<h2>二级</h2>')
    expect(renderMarkdown('###### 六级')).toBe('<h6>六级</h6>')
  })

  it('无序列表', () => {
    expect(renderMarkdown('- 甲\n- 乙')).toBe('<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>')
    expect(renderMarkdown('* 甲\n* 乙')).toBe('<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>')
  })

  it('有序列表', () => {
    expect(renderMarkdown('1. 第一\n2. 第二')).toBe(
      '<ol>\n<li>第一</li>\n<li>第二</li>\n</ol>',
    )
  })

  it('引用块,多行用 <br> 连接', () => {
    expect(renderMarkdown('> 记住这条')).toContain('<blockquote>')
    expect(renderMarkdown('> 记住这条')).toContain('记住这条')
    expect(renderMarkdown('> 第一行\n> 第二行')).toContain('第一行<br>')
    expect(renderMarkdown('> 第一行\n> 第二行')).toContain('第二行')
  })

  it('分隔线', () => {
    expect(renderMarkdown('---')).toBe('<hr>')
  })

  it('代码块保留换行并可带语言标注', () => {
    expect(renderMarkdown('```\nlet a = 1\nlet b = 2\n```')).toBe(
      '<pre><code>let a = 1\nlet b = 2\n</code></pre>',
    )
    expect(renderMarkdown('```js\nconst x = 1\n```')).toBe(
      '<pre><code class="language-js">const x = 1\n</code></pre>',
    )
  })

  it('表格(框架自带能力)', () => {
    const out = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(out).toContain('<table>')
    expect(out).toContain('<th>a</th>')
    expect(out).toContain('<td>1</td>')
  })

  it('普通段落按空行分隔,单行内换行用 <br>', () => {
    expect(renderMarkdown('第一行\n第二行')).toBe('<p>第一行<br>\n第二行</p>')
    expect(renderMarkdown('段落一\n\n段落二')).toContain('<p>段落二</p>')
  })
})

describe('renderMarkdown —— 行内语法', () => {
  it('粗体与斜体', () => {
    expect(renderMarkdown('**重点**')).toBe('<p><strong>重点</strong></p>')
    expect(renderMarkdown('*斜体*')).toBe('<p><em>斜体</em></p>')
  })

  it('行内代码', () => {
    expect(renderMarkdown('用 `npm` 安装')).toBe('<p>用 <code>npm</code> 安装</p>')
  })

  it('链接带 target=_blank(系统浏览器打开)', () => {
    expect(renderMarkdown('[文档](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">文档</a></p>',
    )
  })

  it('图片白名单:http(s) 渲染,其余仅替代文字', () => {
    expect(renderMarkdown('![图](https://example.com/a.png)')).toBe(
      '<p><img src="https://example.com/a.png" alt="图"></p>',
    )
    const bad = renderMarkdown('![图](javascript:alert(1))')
    expect(bad).not.toContain('<img')
    expect(bad).toContain('图')
  })
})

describe('renderMarkdown —— 安全性', () => {
  it('原始 HTML 被转义,不直通', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('可执行属性被转义', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('&lt;img')
  })

  it('粗体标签内的内容也先转义再套标签', () => {
    const out = renderMarkdown('**<b>x</b>**')
    expect(out).toContain('&lt;b&gt;')
    expect(out).not.toContain('<b>x</b>')
  })

  it('javascript: 伪协议链接不渲染成链接', () => {
    const out = renderMarkdown('[危险](javascript:alert(1))')
    expect(out).not.toContain('<a')
    expect(out).toContain('[危险]')
  })

  it('空文本与 null 安全', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null as unknown as string)).toBe('')
  })
})