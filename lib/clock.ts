/**
 * 测试时钟 —— 为「到点验证」提供可偏移的当前时间。
 *
 * 偏移量持久化在 localStorage(仅本机),所有时间决策点用 `testNow()`
 * 代替 `Date.now()`:复习到期池、打卡状态、提醒窗口判定。
 * 偏移为 0 时与真实时钟完全一致,不影响正常使用;
 * 验证完记得在管理员页「回到现在」。
 */

const CLOCK_OFFSET_KEY = 'abdrop.test.clockOffsetMs'

/** 当前偏移量(ms),默认 0。 */
export function getClockOffsetMs(): number {
  if (typeof window === 'undefined') return 0
  try {
    const raw = window.localStorage.getItem(CLOCK_OFFSET_KEY)
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** 设置偏移量(ms,可负)。 */
export function setClockOffsetMs(ms: number): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(CLOCK_OFFSET_KEY, String(ms))
  } catch {
    /* 存储不可用则忽略 */
  }
}

/** 测试用「当前时间」。 */
export function testNow(): Date {
  return new Date(Date.now() + getClockOffsetMs())
}

/** 测试用「当前时间戳」。 */
export function testNowMs(): number {
  return Date.now() + getClockOffsetMs()
}