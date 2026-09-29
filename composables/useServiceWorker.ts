/**
 * Service Worker 注册。
 *
 * 只在生产环境注册:
 *   - 开发时 SW 会缓存住热更新产物,导致改了代码却看不到变化;
 *   - Capacitor 原生壳里资源走 file://,注册 SW 无意义且可能报错。
 */

/** 当前是否应当注册 SW。 */
export function shouldRegisterServiceWorker(): boolean {
  if (typeof window === 'undefined') return false
  if (!('serviceWorker' in navigator)) return false
  // 非 http(s)(如 Capacitor 的 capacitor:// 或 file://)不支持 SW
  if (!/^https?:$/.test(window.location.protocol)) return false
  // 开发环境不注册
  if (import.meta.dev) return false
  return true
}

/**
 * 注册 Service Worker。
 * 返回注销/清理函数;失败时静默 —— 离线能力缺失不该影响主流程。
 */
export async function registerServiceWorker(): Promise<() => void> {
  if (!shouldRegisterServiceWorker()) return () => {}

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })

    // 有新版本就绪时,通知等待中的 SW 立即接管
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          installing.postMessage('SKIP_WAITING')
        }
      })
    })

    return () => {
      void registration.unregister()
    }
  } catch {
    // 注册失败(隐私模式、权限限制等)不影响 App 使用
    return () => {}
  }
}
