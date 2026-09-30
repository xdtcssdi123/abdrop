/**
 * 测试时钟 —— 偏移量持久化与 testNow 计算。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { getClockOffsetMs, setClockOffsetMs, testNow, testNowMs } from '~/lib/clock'

describe('测试时钟偏移', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('默认偏移为 0,testNow 与真实时钟一致', () => {
    expect(getClockOffsetMs()).toBe(0)
    const before = Date.now()
    const t = testNow().getTime()
    const after = Date.now()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after)
    expect(testNowMs()).toBeCloseTo(Date.now(), -2)
  })

  it('设置正偏移后 testNow 前进', () => {
    setClockOffsetMs(3_600_000)
    expect(getClockOffsetMs()).toBe(3_600_000)
    const diff = testNow().getTime() - Date.now()
    expect(Math.abs(diff - 3_600_000)).toBeLessThan(2000)
  })

  it('支持负偏移(回到过去)', () => {
    setClockOffsetMs(-86_400_000)
    expect(getClockOffsetMs()).toBe(-86_400_000)
    const diff = testNow().getTime() - Date.now()
    expect(Math.abs(diff + 86_400_000)).toBeLessThan(2000)
  })

  it('偏移持久化在 localStorage', () => {
    setClockOffsetMs(12345)
    expect(window.localStorage.getItem('abdrop.test.clockOffsetMs')).toBe('12345')
  })

  it('存储被写坏时回退为 0', () => {
    window.localStorage.setItem('abdrop.test.clockOffsetMs', 'not-a-number')
    expect(getClockOffsetMs()).toBe(0)
  })
})