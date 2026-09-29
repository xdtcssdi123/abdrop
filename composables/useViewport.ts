/**
 * 视口适配 —— 移动端网页的核心难点。
 *
 * 三个真实问题:
 *
 * 1. **软键盘遮挡输入框**
 *    iOS Safari 弹出键盘时**不会**缩小布局视口(layout viewport),
 *    只改变 visualViewport。所以固定在底部的录入框会被键盘完全盖住,
 *    用户看不到自己在输入什么。解法:监听 visualViewport.resize,
 *    把「布局视口高度 - 可视视口高度」写成 CSS 变量 --kb-inset,
 *    由样式表据此上推底部面板。
 *
 * 2. **地址栏导致的高度跳变**
 *    iOS 地址栏收起时 vh 变大,导致底部被裁。样式层用 `100dvh`
 *    配合 `height:100%` 兜底解决(见 assets/css/main.css)。
 *
 * 3. **横屏刘海遮挡**
 *    安全区 inset 变量在横屏时左右非零,需在布局中消费。
 *
 * 全部逻辑都可安全在无 visualViewport 的环境降级(桌面浏览器/单测)。
 */

import { onMounted, onBeforeUnmount, ref } from 'vue'

/** 软键盘是否处于展开状态(供 UI 决定是否收起次要元素)。 */
const keyboardOpen = ref(false)

export interface ViewportInfo {
  /** 当前可视高度(px) */
  height: number
  /** 当前可视宽度(px) */
  width: number
  /** 软键盘占用的高度(px),无键盘时为 0 */
  keyboardInset: number
  /** 是否检测到软键盘 */
  keyboardOpen: boolean
}

/**
 * 计算当前视口信息(纯函数,不碰 DOM 之外的任何状态)。
 *
 * @param layoutHeight window.innerHeight(布局视口)
 * @param visualHeight visualViewport.height(可视视口,受键盘影响)
 */
export function computeViewport(
  layoutHeight: number,
  visualHeight: number,
): { keyboardInset: number; keyboardOpen: boolean } {
  const inset = Math.max(0, Math.round(layoutHeight - visualHeight))
  // 阈值 100px:地址栏收起的那点差异(约 60px)不该被误判成键盘
  const open = inset > 100
  return { keyboardInset: open ? inset : 0, keyboardOpen: open }
}

/** 把视口信息写入 CSS 变量。 */
function applyToCSS(info: ViewportInfo): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--kb-inset', `${info.keyboardInset}px`)
  // 键盘展开时给根节点打个标记,便于样式分支
  root.classList.toggle('kb-open', info.keyboardOpen)
}

/**
 * 启动视口监听。在根组件挂载时调用一次即可。
 * 返回清理函数,便于测试与手动停止。
 */
export function startViewportTracking(): () => void {
  if (typeof window === 'undefined') return () => {}

  const vv = window.visualViewport
  let raf = 0

  const measure = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const layoutHeight = window.innerHeight
      const visualHeight = vv?.height ?? layoutHeight
      const { keyboardInset, keyboardOpen: open } = computeViewport(layoutHeight, visualHeight)

      keyboardOpen.value = open
      applyToCSS({
        height: layoutHeight,
        width: window.innerWidth,
        keyboardInset,
        keyboardOpen: open,
      })
    })
  }

  measure()

  window.addEventListener('resize', measure)
  window.addEventListener('orientationchange', measure)
  vv?.addEventListener('resize', measure)
  // 键盘弹出时页面会被顶动,scroll 也需跟随
  vv?.addEventListener('scroll', measure)

  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', measure)
    window.removeEventListener('orientationchange', measure)
    vv?.removeEventListener('resize', measure)
    vv?.removeEventListener('scroll', measure)
    if (typeof document !== 'undefined') {
      document.documentElement.classList.remove('kb-open')
      document.documentElement.style.removeProperty('--kb-inset')
    }
  }
}

/** 组合式封装:在组件生命周期内自动启停。 */
export function useViewport() {
  onMounted(() => {
    stop = startViewportTracking()
  })
  onBeforeUnmount(() => {
    stop?.()
    stop = null
  })

  return { keyboardOpen }
}

let stop: (() => void) | null = null

/**
 * 滚动输入元素到可视区域。
 * 键盘弹出后聚焦的元素可能仍在键盘之下,需要手动滚进视野。
 */
export function scrollIntoViewOnKeyboard(el: HTMLElement | null): void {
  if (!el || typeof window === 'undefined') return
  // 等一帧,让 CSS 变量生效、布局稳定后再滚
  requestAnimationFrame(() => {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch {
      el.scrollIntoView()
    }
  })
}
