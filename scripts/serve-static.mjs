/**
 * 极简静态服务器 —— 用于本地/局域网预览生产构建产物。
 *
 * 为什么不用 `npx serve`:
 *   1. 需要额外下载依赖,而本机预览应当开箱可用;
 *   2. `.wasm` 的 MIME 必须是 application/wasm,否则 sql.js 的
 *      WebAssembly.instantiateStreaming 会拒绝加载(Anki 导入直接失效);
 *   3. SPA 需要目录索引回退,保证 /settings 这类预渲染路由可直达。
 *
 * 用法:node scripts/serve-static.mjs [端口] [目录]
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../.output/public', import.meta.url)))
const port = Number(process.argv[2] ?? process.env.PORT ?? 4180)
const host = process.env.HOST ?? '0.0.0.0'

/** MIME 表 —— 遗漏 .wasm 会导致 wasm 加载失败,这是最容易踩的坑。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // PWA 清单必须是这个 MIME,否则浏览器不识别(会当成文件下载)
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

if (!existsSync(root)) {
  console.error(`[serve] 构建产物不存在:${root}\n请先执行 pnpm generate`)
  process.exit(1)
}

/** 把 URL 路径安全地映射到磁盘路径,挡掉 ../ 越权。 */
function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  const safe = normalize(clean).replace(/^(\.\.[/\\])+/, '')
  const target = join(root, safe)
  if (!target.startsWith(root)) return null
  return target
}

/**
 * 解析请求到磁盘文件。
 *
 * 关键:**只对"导航请求"做 SPA 回退**。
 * 若对缺失的 .js/.wasm 也回退成 index.html,浏览器会拿到 HTML 却按
 * script/wasm 解析,报出令人困惑的 MIME 错误 —— 真实原因(文件 404)
 * 被彻底掩盖。所以带扩展名的资源缺失时必须老实返回 404。
 */
function pickFile(urlPath) {
  const base = resolvePath(urlPath)
  if (!base) return null

  const isFile = (p) => existsSync(p) && statSync(p).isFile()

  // 1. 精确命中
  if (isFile(base)) return base

  const ext = extname(base)
  // 2. 带扩展名却没命中 → 是资源请求,不回退,老实 404
  if (ext) return null

  // 3. 无扩展名 → 可能是目录或前端路由,先试目录索引
  const indexPath = join(base, 'index.html')
  if (isFile(indexPath)) return indexPath

  // 4. 前端路由(如 /settings 已被预渲染成目录,其余走 SPA 宿主)
  return join(root, 'index.html')
}

const server = createServer((req, res) => {
  const file = pickFile(req.url ?? '/')

  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
    return
  }

  const ext = extname(file).toLowerCase()
  const isHtml = ext === '.html'
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // HTML 不缓存(便于改完立刻看到),带 hash 的静态资源长缓存
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    // wasm 需要正确的跨源策略才能被 instantiateStreaming 接受
    'Cross-Origin-Resource-Policy': 'cross-origin',
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }

  const stat = statSync(file)
  headers['Content-Length'] = stat.size
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
})

server.listen(port, host, () => {
  console.log(`[serve] 目录: ${root}`)
  console.log(`[serve] 监听: http://${host}:${port}`)
})
