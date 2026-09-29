/**
 * ABDrop Service Worker —— 离线优先缓存。
 *
 * 为什么需要:
 *   1. **离线可用** —— 记忆卡 App 的整个卖点就是随时能刷,不该依赖网络;
 *   2. **Chrome 安装提示** —— Chrome 要求可安装的 PWA 必须注册
 *      带 fetch 处理的 Service Worker,否则不弹「添加到主屏幕」。
 *
 * 缓存策略(按资源性质区分,不搞一刀切):
 *   - 导航请求(HTML)  → 网络优先,失败回落缓存 → 保证能拿到最新版本
 *   - 带 hash 的静态资源 → 缓存优先(内容不可变,可永久命中)
 *   - sql-wasm.wasm     → 缓存优先(体积大,极少变动)
 *   - 其他同源 GET      → 缓存优先 + 后台更新
 *
 * 版本升级:改 CACHE_VERSION 即可让旧缓存整体失效。
 */

const CACHE_VERSION = 'abdrop-v1'
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`
const PRECACHE = `${CACHE_VERSION}-precache`

/**
 * 预缓存清单。
 *
 * 只放"必然用到且体积可控"的资源。
 * 刻意不预缓存 sql-wasm.wasm(658KB):首次打开不该为只用一次的
 * Anki 导入功能付出下载代价,它在首次实际请求时再进运行时缓存。
 */
const PRECACHE_URLS = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg']

// ── 安装:预缓存骨架 ────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE)
      // 逐个添加:单个资源失败不应让整个安装失败
      await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' }))))
      // 跳过等待,新 SW 立即接管
      await self.skipWaiting()
    })(),
  )
})

// ── 激活:清理旧版本缓存 ────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)),
      )
      // 立即接管所有页面
      await self.clients.claim()
    })(),
  )
})

/** 是否为本应用自己的同源请求。 */
function isSameOrigin(url) {
  return url.origin === self.location.origin
}

/**
 * 判断是否为"内容不可变"的资源。
 * Nuxt 产物在 _nuxt/ 下且文件名带 hash,内容变了文件名就变。
 */
function isImmutableAsset(url) {
  return url.pathname.startsWith('/_nuxt/') || /\.[0-9a-f]{8,}\.(js|css|woff2?)$/i.test(url.pathname)
}

/** 网络优先:保证 HTML 永远是最新的,离线时回落缓存。 */
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE)
  try {
    const response = await fetch(request)
    if (response && response.ok) {
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached
    // 离线且无缓存:给一个最小可用的兜底页
    const fallback = await caches.match('/index.html')
    if (fallback) return fallback
    return new Response('离线,且该页面尚未缓存', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

/** 缓存优先:命中即返回,未命中则取网络并写入缓存。 */
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const cache = await caches.open(RUNTIME_CACHE)
  const response = await fetch(request)
  // 只缓存成功的同源响应;opaque 响应(跨域)不缓存,避免污染
  if (response && response.ok && response.type !== 'opaque') {
    cache.put(request, response.clone())
  }
  return response
}

// ── 请求拦截 ────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event

  // 只处理 GET;POST/PUT 等一律放行(如 AI 接口调用)
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // 跨域请求一律放行:AI 接口、第三方 CDN 都不该被 SW 插手
  if (!isSameOrigin(url)) return

  // 导航请求(地址栏访问 / 刷新 / 添加到主屏后启动)
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  // 带 hash 的构建产物:内容不可变,缓存优先
  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request))
    return
  }

  // wasm 体积大且少变,缓存优先
  if (url.pathname.endsWith('.wasm')) {
    event.respondWith(cacheFirst(request))
    return
  }

  // 其余同源 GET:缓存优先 + 后台更新
  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      const network = fetch(request)
        .then(async (response) => {
          if (response && response.ok) {
            const cache = await caches.open(RUNTIME_CACHE)
            cache.put(request, response.clone())
          }
          return response
        })
        .catch(() => null)

      // 有缓存立刻返回,同时让网络请求在后台完成更新
      if (cached) return cached
      const fresh = await network
      if (fresh) return fresh
      return new Response('离线', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    })(),
  )
})

// ── 消息通道:允许页面主动触发更新 ──────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
