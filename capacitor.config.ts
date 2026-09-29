import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 多端打包配置。
 * - webDir 指向 Nuxt `ssr:false` 静态产物
 * - 关闭背景色闪烁,和首页浅灰渐变无缝衔接
 */
const config: CapacitorConfig = {
  appId: 'com.abdrop.app',
  appName: 'ABDrop',
  webDir: '.output/public',

  // 全部资源走本地 file:// ,离线可用
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },

  android: {
    allowMixedContent: false,
    backgroundColor: '#eef1f4',
    // 卡片滑动依赖高频触摸事件,禁止 WebView 过度滚动
    webContentsDebuggingEnabled: false,
  },

  ios: {
    contentInset: 'never',
    backgroundColor: '#eef1f4',
    limitsNavigationsToAppBoundDomains: false,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#eef1f4',
      showSpinner: false,
    },
    Camera: {
      // 拍照后返回 base64,直接进 IndexedDB
      allowEditing: false,
      resultType: 'base64',
      source: 'PROMPT',
      quality: 70,
      width: 1280,
    },
  },
}

export default config
