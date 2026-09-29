// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',

  // ── 关键:Capacitor 是纯静态壳,必须关闭 SSR 走 SPA ──────────────────────
  ssr: false,

  devtools: { enabled: false },

  // 产物输出到 .output/public,由 capacitor.config.ts 的 webDir 指向
  nitro: {
    preset: 'static',
  },

  app: {
    head: {
      title: 'ABDrop · 卡片记忆',
      htmlAttrs: { lang: 'zh-CN' },
      meta: [
        { charset: 'utf-8' },
        {
          name: 'viewport',
          content:
            'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
        },
        // 移动端网页:让浏览器 UI 与页面底色一致,消除地址栏色差
        { name: 'theme-color', content: '#eef1f4' },
        { name: 'color-scheme', content: 'light' },
        // 添加到主屏后以全屏 App 形态运行(不显示 Safari 地址栏)
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
        { name: 'apple-mobile-web-app-title', content: 'ABDrop' },
        { name: 'format-detection', content: 'telephone=no' },
        // 明确声明这是为移动端设计的页面
        { name: 'apple-touch-fullscreen', content: 'yes' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        // PWA:可"添加到主屏幕"并以独立窗口运行
        { rel: 'manifest', href: '/manifest.webmanifest' },
        // iOS 用 PNG 图标(SVG 不被支持)
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icon-192.png' },
        { rel: 'icon', type: 'image/png', sizes: '512x512', href: '/icon-512.png' },
      ],
    },
    // 全局过渡关闭 —— 页面切换必须瞬时,不加任何冗余动效
    pageTransition: false,
    layoutTransition: false,
  },

  css: ['~/assets/css/main.css'],

  modules: [],

  imports: {
    dirs: ['composables', 'stores'],
  },

  vite: {
    // Motion One 需要保持 ESM 形态
    optimizeDeps: {
      include: ['motion', 'idb'],
    },
    build: {
      target: 'es2020',
    },
  },

  typescript: {
    strict: true,
    shim: false,
  },
})
