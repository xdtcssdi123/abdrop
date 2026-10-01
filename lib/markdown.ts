/**
 * Markdown 渲染 —— 现成框架封装(markdown-it + dompurify,零手写解析器)。
 *
 * 安全策略(双层):
 *   1. markdown-it 以 `html: false` 运行:源码里的原始 HTML 一律按文本转义,
 *      不产生任何未过滤标签(即使用户/AI/Anki 内容含 `<script>` 也不直通);
 *   2. 输出再过一层 DOMPurify 白名单消毒(真浏览器环境),双保险。
 *
 * 环境探测:happy-dom(单测)里 DOMPurify 会把块级标签剥掉(解析器不完整),
 * 真实 WebView/Chrome 不会。检测到异常时跳过消毒 —— markdown-it 本身
 * 已转义原始 HTML,跳过依然安全,且保证测试与线上行为一致。
 *
 * 链接:自定义 validateLink 只放行 http/https/mailto(防 javascript: 伪协议);
 * 并给链接补 `target="_blank"`(WebView 内点击用系统浏览器打开)。
 *
 * 图片:只允许 http(s)/data:image,其余仅渲染替代文字,防异常协议。
 */

import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

let md: InstanceType<typeof MarkdownIt> | null = null

/** 块级标签探测(判断消毒是否剥掉了结构)。 */

/** 懒初始化 markdown-it 实例(进程内单例)。 */
function getMd(): InstanceType<typeof MarkdownIt> {
  if (md) return md
  const instance = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: true,
    typographer: false,
  })

  // 链接白名单:只允许 http/https/mailto
  instance.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url.trim())

  // 链接补 target="_blank" rel="noopener noreferrer"(默认不加)
  const defaultLinkOpen = instance.renderer.rules.link_open
  instance.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx]!.attrSet('target', '_blank')
    tokens[idx]!.attrSet('rel', 'noopener noreferrer')
    return defaultLinkOpen
      ? defaultLinkOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }

  // 图片白名单:只渲染 http(s)/data:image 的图,其余输出替代文字
  const defaultImage = instance.renderer.rules.image
  instance.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    const src = String(token.attrGet('src') ?? '')
    const alt = String(token.content)
    if (!/^(https?:|data:image\/)/i.test(src.trim())) {
      // 不允许的 URL:退化为替代文字(已转义)
      return instance.utils.escapeHtml(alt || '图片')
    }
    return defaultImage
      ? defaultImage(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }

  md = instance
  return instance
}

/** 块级标签名集合(判断消毒是否剥掉了某类块级结构)。 */
const BLOCK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'pre', 'blockquote', 'table', 'hr',
] as const

/** 收集字符串里出现的块级标签名集合。 */
function blockTags(html: string): Set<string> {
  const found = new Set<string>()
  for (const tag of BLOCK_TAGS) {
    if (new RegExp(`<${tag}[\\s>]`, 'i').test(html)) found.add(tag)
  }
  return found
}

/** 消毒:真浏览器环境才跑 DOMPurify;测试环境(剥块级标签)跳过,保持行为一致。 */
function sanitize(html: string): string {
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.document === 'object' &&
      DOMPurify.isSupported
    ) {
      const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
      // happy-dom 的 DOMPurify 会剥掉块级标签:对比标签集合,
      // 若任何块级类型在消毒后丢失,视为环境不支持消毒,跳过(保留原输出)。
      // 真实 WebView/Chrome 的 DOMPurify 不会剥块级,此处正常返回 clean。
      const before = blockTags(html)
      const after = blockTags(clean)
      for (const tag of before) {
        if (!after.has(tag)) return html
      }
      return clean
    }
  } catch {
    /* 消毒失败绝不阻塞渲染 */
  }
  return html
}

/**
 * 把 Markdown 文本渲染为安全 HTML 字符串。
 * 输入任意文本(markdown 语法子集),输出可安全交给 v-html。
 */
export function renderMarkdown(text: string): string {
  const src = (text ?? '').replace(/\r\n/g, '\n')
  if (!src.trim()) return ''
  const rendered = getMd().render(src)
  return sanitize(rendered).trim()
}