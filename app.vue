<script setup lang="ts">
/**
 * App 根组件。
 *
 * 全局只有一条规则:首屏必须是卡片本身,任何导航/加载态都不许占屏。
 *
 * 另外在这里启动视口监听 —— 移动端网页的软键盘避让、地址栏高度变化
 * 都需要全局生效,放在根组件最合适(见 composables/useViewport.ts)。
 *
 * 也在这里监听「用本 App 打开」意图(手机文件管理器点 .apkg →
 * ABDrop):应用已在运行时,系统会把文件 URI 通过 appUrlOpen 事件送进来,
 * 由根组件统一接收 → 读字节 → 导入 → 刷新合集状态。
 *
 * 还在这里处理 Android 返回键:首页按两次才退出(第一次提示),
 * 设置/管理员页按返回键回退上一页。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { startViewportTracking } from '~/composables/useViewport'
import { registerServiceWorker } from '~/composables/useServiceWorker'
import { isNativePlatform } from '~/composables/useNativeBridge'
import { useCardRepository } from '~/lib/db'
import { useCollections } from '~/composables/useAppState'
import { importApkgFromUri } from '~/composables/useApkgOpen'
import { decideBack } from '~/lib/back-exit'
import type { PluginListenerHandle } from '@capacitor/core'

let stopViewport: (() => void) | null = null
let unregisterSW: (() => void) | null = null
let openListener: PluginListenerHandle | null = null
let backListener: PluginListenerHandle | null = null
/** 首页上一次「提示退出」的时间戳(两次返回间隔判断)。 */
let lastBackAt = 0

const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2200)
}

/** 接收文件管理器的「打开 .apkg」意图并导入。 */
async function handleOpenUri(url: string) {
  const repo = useCardRepository()
  const report = await importApkgFromUri(url, repo)
  if (!report) return
  if (report.warnings.length && report.added === 0) {
    showToast(`导入失败:${report.warnings[0]}`)
    return
  }
  await useCollections().refresh()
  showToast(`已导入 ${report.added} 张卡片`)
  // 通知各页面数据变了(首页池子需要重拉)
  window.dispatchEvent(new Event('abdrop:imported'))
}

onMounted(() => {
  stopViewport = startViewportTracking()
  // 注册 SW:提供离线能力,同时满足 Chrome 的 PWA 安装条件
  void registerServiceWorker().then((fn) => {
    unregisterSW = fn
  })

  if (!isNativePlatform()) return
  // 运行中收到「打开文件」意图 → appUrlOpen(冷启动由首页用 getLaunchUrl 兜底)。
  // 能进到这里的意图已被 Manifest 的 intent-filter 过滤(仅 .apkg 类文件),
  // 所以直接尝试导入;不是合法牌组的会拿到友好报错。
  void import('@capacitor/app')
    .then(async ({ App }) => {
      openListener = await App.addListener('appUrlOpen', (e) => {
        void handleOpenUri(e.url)
      })

      // Android 返回键:首页两次退出(第一次提示);其他页面回退上一页。
      // 用 location.pathname 判断当前页(在根组件里 useRoute 可能取不到正确路由,
      // 会导致误判成"回退上一页"而首页无历史 → 完全没反应)。
      backListener = await App.addListener('backButton', (e) => {
        const path = window.location.pathname || '/'
        const action = decideBack(path, lastBackAt, Date.now())
        if (action === 'navigate-back') {
          // 有历史就走浏览器回退,否则显式回首页
          if (e.canGoBack) window.history.back()
          else void useRouter().push('/')
          return
        }
        if (action === 'exit-app') {
          void App.exitApp()
          return
        }
        lastBackAt = Date.now()
        showToast('再按一次退出')
      })
    })
    .catch(() => {
      /* 插件缺失不阻塞 */
    })
})

onBeforeUnmount(() => {
  stopViewport?.()
  stopViewport = null
  unregisterSW?.()
  unregisterSW = null
  if (toastTimer) clearTimeout(toastTimer)
  void openListener?.remove()
  openListener = null
  void backListener?.remove()
  backListener = null
})
</script>

<template>
  <div class="app-root">
    <NuxtPage />

    <Transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.app-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.toast {
  position: absolute;
  left: 50%;
  bottom: calc(28px + var(--safe-bottom));
  transform: translateX(-50%);
  z-index: var(--z-toast);
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 15px;
  color: var(--ink-1);
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12);
  max-width: calc(100vw - var(--safe-left) - var(--safe-right) - 48px);
  text-align: center;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 180ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>