/**
 * Vitest 配置。
 *
 * 设计决策:组件与 composable 一律**显式导入** Vue / Nuxt API,
 * 不依赖 Nuxt 的自动导入魔法。
 *
 * 理由:自动导入在单测环境下需要额外复刻一套构建期注入,一旦不一致,
 * 测试跑的就是"另一个版本"的代码。显式导入在 Nuxt 里同样是一等公民,
 * 且让 `#imports` 可以被测试替身接管(见 tests/stubs/nuxt-imports.ts)。
 */
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('./', import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '~': root,
      '@': root,
      // Nuxt 运行时的最小替身
      '#imports': resolve(root, 'tests/stubs/nuxt-imports.ts'),
      '#app': resolve(root, 'tests/stubs/nuxt-imports.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['lib/**/*.ts', 'composables/**/*.ts'],
      exclude: ['tests/**'],
    },
  },
})
