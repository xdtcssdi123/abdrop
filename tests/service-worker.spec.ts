/**
 * Service Worker 注册逻辑测试。
 *
 * 注册与否的判定条件很容易写错(开发环境注册会缓存住热更新,
 * Capacitor 里注册会报错),所以这些分支必须被测试钉死。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { registerServiceWorker, shouldRegisterServiceWorker } from '~/composables/useServiceWorker'

/** 造一个可控的 navigator.serviceWorker 替身。 */
function stubServiceWorker(behavior: 'ok' | 'reject' = 'ok') {
  const registered: { scriptURL: string; options?: RegistrationOptions }[] = []
  let unregistered = false

  const registration = {
    installing: null,
    addEventListener: () => {},
    unregister: async () => {
      unregistered = true
      return true
    },
  }

  const container = {
    register: async (url: string, options?: RegistrationOptions) => {
      if (behavior === 'reject') throw new Error('注册被拒绝')
      registered.push({ scriptURL: url, options })
      return registration
    },
    controller: null,
    addEventListener: () => {},
  }

  Object.defineProperty(navigator, 'serviceWorker', {
    value: container,
    configurable: true,
  })

  return {
    registered,
    wasUnregistered: () => unregistered,
  }
}

describe('shouldRegisterServiceWorker 判定', () => {
  const originalProtocol = window.location.protocol

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, protocol: originalProtocol },
      configurable: true,
      writable: true,
    })
    // 清掉替身
    delete (navigator as any).serviceWorker
  })

  it('支持 serviceWorker 的 http 环境返回 true', () => {
    stubServiceWorker()
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', origin: 'http://localhost' },
      configurable: true,
      writable: true,
    })
    expect(shouldRegisterServiceWorker()).toBe(true)
  })

  it('https 环境返回 true', () => {
    stubServiceWorker()
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', origin: 'https://example.com' },
      configurable: true,
      writable: true,
    })
    expect(shouldRegisterServiceWorker()).toBe(true)
  })

  it('Capacitor 的 capacitor:// 协议不注册', () => {
    stubServiceWorker()
    Object.defineProperty(window, 'location', {
      value: { protocol: 'capacitor:', origin: 'capacitor://localhost' },
      configurable: true,
      writable: true,
    })
    expect(shouldRegisterServiceWorker()).toBe(false)
  })

  it('file:// 协议不注册', () => {
    stubServiceWorker()
    Object.defineProperty(window, 'location', {
      value: { protocol: 'file:', origin: 'file://' },
      configurable: true,
      writable: true,
    })
    expect(shouldRegisterServiceWorker()).toBe(false)
  })

  it('浏览器不支持 serviceWorker 时返回 false', () => {
    delete (navigator as any).serviceWorker
    expect(shouldRegisterServiceWorker()).toBe(false)
  })
})

describe('registerServiceWorker', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', origin: 'https://example.com' },
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    delete (navigator as any).serviceWorker
  })

  it('注册 /sw.js 且作用域为根', async () => {
    const stub = stubServiceWorker()
    await registerServiceWorker()
    expect(stub.registered).toHaveLength(1)
    expect(stub.registered[0]!.scriptURL).toBe('/sw.js')
    expect(stub.registered[0]!.options?.scope).toBe('/')
  })

  it('返回的函数可注销 SW', async () => {
    const stub = stubServiceWorker()
    const cleanup = await registerServiceWorker()
    cleanup()
    expect(stub.wasUnregistered()).toBe(true)
  })

  it('注册失败时不抛异常,返回空清理函数', async () => {
    stubServiceWorker('reject')
    const cleanup = await registerServiceWorker()
    expect(typeof cleanup).toBe('function')
    expect(() => cleanup()).not.toThrow()
  })

  it('不支持的环境返回空操作,不尝试注册', async () => {
    delete (navigator as any).serviceWorker
    const cleanup = await registerServiceWorker()
    expect(typeof cleanup).toBe('function')
    expect(() => cleanup()).not.toThrow()
  })
})
