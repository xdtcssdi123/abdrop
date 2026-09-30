/**
 * 返回键决策 —— 纯逻辑测试。
 */
import { describe, expect, it } from 'vitest'
import { decideBack, HOME_PATH } from '~/lib/back-exit'

const NOW = 1_800_000_000_000

describe('返回键决策(首页两次退出)', () => {
  it('非首页 → 回退上一页', () => {
    expect(decideBack('/settings', 0, NOW)).toBe('navigate-back')
    expect(decideBack('/admin', NOW, NOW)).toBe('navigate-back')
  })

  it('首页第一次按返回 → 提示,不退出', () => {
    expect(decideBack(HOME_PATH, 0, NOW)).toBe('hint-exit')
  })

  it('首页 2 秒内第二次按返回 → 退出', () => {
    expect(decideBack(HOME_PATH, NOW, NOW + 500)).toBe('exit-app')
    expect(decideBack(HOME_PATH, NOW, NOW + 1999)).toBe('exit-app')
  })

  it('超过 2 秒再按 → 重新计为第一次(提示)', () => {
    expect(decideBack(HOME_PATH, NOW, NOW + 2000)).toBe('hint-exit')
    expect(decideBack(HOME_PATH, NOW, NOW + 5000)).toBe('hint-exit')
  })
})