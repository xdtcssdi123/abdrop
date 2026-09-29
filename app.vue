<script setup lang="ts">
/**
 * App 根组件。
 *
 * 全局只有一条规则:首屏必须是卡片本身,任何导航/加载态都不许占屏。
 *
 * 另外在这里启动视口监听 —— 移动端网页的软键盘避让、地址栏高度变化
 * 都需要全局生效,放在根组件最合适(见 composables/useViewport.ts)。
 */
import { onMounted, onBeforeUnmount } from 'vue'
import { startViewportTracking } from '~/composables/useViewport'
import { registerServiceWorker } from '~/composables/useServiceWorker'

let stopViewport: (() => void) | null = null
let unregisterSW: (() => void) | null = null

onMounted(() => {
  stopViewport = startViewportTracking()
  // 注册 SW:提供离线能力,同时满足 Chrome 的 PWA 安装条件
  void registerServiceWorker().then((fn) => {
    unregisterSW = fn
  })
})

onBeforeUnmount(() => {
  stopViewport?.()
  stopViewport = null
  unregisterSW?.()
  unregisterSW = null
})
</script>

<template>
  <div class="app-root">
    <NuxtPage />
  </div>
</template>

<style scoped>
.app-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
}
</style>
