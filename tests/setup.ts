/**
 * Vitest 全局 setup。
 *
 * 关键三点:
 * 1. 注入 fake-indexeddb,让 lib/db.ts 走**真实的 IndexedDB 代码路径**,
 *    而不是永远落在内存降级分支上 —— 否则仓储层等于没测。
 * 2. 预初始化 sql.js 并注入,让 .apkg 解析测试跑在 Node 原生 wasm 上
 *    (浏览器端才需要 /sql-wasm.wasm 这条本地路径)。
 * 3. 用例之间彻底清库,否则 IndexedDB 数据会跨用例泄漏。
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeAll, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { DB_NAME, resetDBConnection, __setRepository } from '~/lib/db'
import { __setSql } from '~/lib/anki'

// happy-dom 未实现的能力补齐
if (!('vibrate' in navigator)) {
  Object.defineProperty(navigator, 'vibrate', { value: () => true, writable: true })
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// Element.animate 缺失时提供最小桩(动效降级路径会用到)
if (!Element.prototype.animate) {
  Element.prototype.animate = function () {
    return {
      finished: Promise.resolve(),
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      onfinish: null,
    } as unknown as Animation
  }
}

/**
 * Node 26 的内置 localStorage 需要 --localstorage-file,默认不可用。
 * 这里注入内存替身:让 `useAIConfigState` 等真实读写路径可被测试覆盖,
 * 而不是全部走进 catch 分支。
 */
function installLocalStorageStub(): void {
  const store = new Map<string, string>()
  const stub: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  }
  try {
    Object.defineProperty(window, 'localStorage', {
      value: stub,
      configurable: true,
      writable: true,
    })
  } catch {
    /* 已有可用实现则保留 */
  }
}

installLocalStorageStub()

/** 清空 localStorage,保证用例之间零残留。 */
function clearLocalStorage(): void {
  try {
    window.localStorage?.clear()
  } catch {
    /* 环境不提供 localStorage,忽略 */
  }
}

/** 彻底删掉测试库,保证用例之间零残留。 */
function deleteTestDatabase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

beforeAll(async () => {
  // sql.js 默认从自身 __dirname 读 wasm,Node 环境下开箱可用
  const SQL = await initSqlJs()
  __setSql(SQL)
})

afterEach(async () => {
  vi.restoreAllMocks()
  // 先把挂起的微任务放干净:组件 onMounted 里的异步链可能还在跑,
  // 若此时就关库,会抛 InvalidStateError 并污染后续用例。
  await new Promise((resolve) => setTimeout(resolve, 0))
  __setRepository(null)
  await resetDBConnection()
  await deleteTestDatabase()
  clearLocalStorage()
})
