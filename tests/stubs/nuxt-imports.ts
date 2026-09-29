/**
 * Nuxt 自动导入的最小替身。
 *
 * 组件与 composable 里会用到 `useState` / `useRouter` 等 Nuxt 内置,
 * 单测环境没有 Nuxt 运行时,这里给出语义等价的最小实现 ——
 * 目的是让测试覆盖的是**真实代码路径**,而不是给组件打补丁。
 */
import { ref, type Ref } from 'vue'

/** Nuxt `useState` 的最小实现:同一 key 返回同一 ref。 */
const stateStore = new Map<string, Ref<any>>()

export function useState<T>(key: string, init: () => T): Ref<T> {
  if (!stateStore.has(key)) stateStore.set(key, ref(init()) as Ref<T>)
  return stateStore.get(key) as Ref<T>
}

/** 测试辅助:重置所有共享状态,避免用例间串味。 */
export function __resetNuxtState(): void {
  stateStore.clear()
}

/** Nuxt `useRouter` 的最小实现。 */
export function useRouter() {
  return {
    push: async () => {},
    replace: async () => {},
    back: () => {},
    currentRoute: ref({ path: '/' }),
  }
}

/** Nuxt `useRoute` 的最小实现。 */
export function useRoute() {
  return { path: '/', query: {}, params: {} }
}

/** Nuxt `useRuntimeConfig` 的最小实现。 */
export function useRuntimeConfig() {
  return { public: {} }
}
