/**
 * 局域网配置读取测试 —— 从持久化存储读软件真实配置。
 *
 * 背景:Web 服务请求可能发生在 App 从未打开设置页的状态,
 * 内存 useState 只有默认值;必须读 localStorage 才算"同步软件里的配置"。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  ACTIVE_COLLECTION_KEY,
  AI_CONFIG_KEY,
  CHECKIN_CONFIG_KEY,
  readAIConfigFromStorage,
  readActiveCollectionFromStorage,
  readCheckinConfigFromStorage,
  readStored,
} from '~/lib/lan-config'

beforeEach(() => {
  window.localStorage.clear()
})

describe('readStored', () => {
  it('有值时返回原值,无值时返回 null', () => {
    expect(readStored('nope')).toBeNull()
    window.localStorage.setItem('k', 'v')
    expect(readStored('k')).toBe('v')
  })
})

describe('readAIConfigFromStorage', () => {
  it('无记录时回退默认配置', () => {
    const cfg = readAIConfigFromStorage()
    expect(cfg.enabled).toBe(false)
    expect(cfg.apiKey).toBe('')
  })

  it('读取软件里保存的真实配置', () => {
    window.localStorage.setItem(
      AI_CONFIG_KEY,
      JSON.stringify({
        enabled: true,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-real-key',
        model: 'deepseek-chat',
      }),
    )
    const cfg = readAIConfigFromStorage()
    expect(cfg.enabled).toBe(true)
    expect(cfg.provider).toBe('deepseek')
    expect(cfg.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(cfg.apiKey).toBe('sk-real-key')
    expect(cfg.model).toBe('deepseek-chat')
  })

  it('损坏 JSON 回退默认,不抛异常', () => {
    window.localStorage.setItem(AI_CONFIG_KEY, '{broken')
    const cfg = readAIConfigFromStorage()
    expect(cfg.enabled).toBe(false)
  })
})

describe('readActiveCollectionFromStorage', () => {
  it('无记录时回退「全部」', () => {
    expect(readActiveCollectionFromStorage()).toBe('__all__')
  })

  it('读取软件里选的复习范围', () => {
    window.localStorage.setItem(ACTIVE_COLLECTION_KEY, 'col-123')
    expect(readActiveCollectionFromStorage()).toBe('col-123')
  })
})

describe('readCheckinConfigFromStorage', () => {
  it('无记录时回退默认配置', () => {
    const cfg = readCheckinConfigFromStorage()
    expect(cfg.enabled).toBe(false)
    expect(cfg.startMinute).toBe(540)
  })

  it('读取软件里保存的打卡配置', () => {
    window.localStorage.setItem(
      CHECKIN_CONFIG_KEY,
      JSON.stringify({ enabled: true, startMinute: 480, endMinute: 1380 }),
    )
    const cfg = readCheckinConfigFromStorage()
    expect(cfg.enabled).toBe(true)
    expect(cfg.startMinute).toBe(480)
    expect(cfg.endMinute).toBe(1380)
  })

  it('损坏 JSON 回退默认', () => {
    window.localStorage.setItem(CHECKIN_CONFIG_KEY, 'xxx')
    const cfg = readCheckinConfigFromStorage()
    expect(cfg.enabled).toBe(false)
  })
})