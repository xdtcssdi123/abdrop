/**
 * 每日打卡 + 每小时提醒 —— 纯逻辑测试。
 *
 * 覆盖:日期键、是否已打卡、窗口整点切片、去重键、
 * 前台是否提醒(开关/打卡/窗口/每小时去重)、下一次提醒、今日提醒时间点列表。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHECKIN_CONFIG,
  dateKey,
  isCheckedInToday,
  latestBoundaryHour,
  nextReminderAt,
  remindKey,
  reminderTimesForDay,
  shouldCheckinRemind,
  windowHours,
  type CheckinConfig,
} from '~/lib/checkin'

/** 构造指定时刻(本地时区)。 */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 8, 30, hour, minute, 0, 0) // 2026-09-30
}

/** 默认配置但已开启 —— 提醒判定测试用。 */
const DEFAULT: CheckinConfig = { ...DEFAULT_CHECKIN_CONFIG, enabled: true }

describe('日期与打卡状态', () => {
  it('dateKey 输出 YYYY-MM-DD', () => {
    expect(dateKey(new Date(2026, 8, 5))).toBe('2026-09-05')
  })

  it('同一天视为已打卡,跨天/空值视为未打卡', () => {
    expect(isCheckedInToday('2026-09-30', at(10))).toBe(true)
    expect(isCheckedInToday(null, at(10))).toBe(false)
    expect(isCheckedInToday('2026-09-29', at(10))).toBe(false)
  })
})

describe('窗口整点切片', () => {
  it('默认 09:00–22:00 → 9..22 共 14 个小时', () => {
    expect(windowHours(DEFAULT)).toHaveLength(14)
    expect(windowHours(DEFAULT)[0]).toBe(9)
    expect(windowHours(DEFAULT).at(-1)).toBe(22)
  })

  it('开始/结束时间按所在整点取整', () => {
    // 09:30 → 整点 9 起;21:50 → 整点 21 止
    const cfg: CheckinConfig = { enabled: true, startMinute: 9 * 60 + 30, endMinute: 22 * 60 - 10 }
    expect(windowHours(cfg)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ])
  })

  it('越界小时被夹到 0–23', () => {
    const cfg: CheckinConfig = { enabled: true, startMinute: -60, endMinute: 25 * 60 }
    expect(windowHours(cfg)).toHaveLength(24)
  })
})

describe('已到达的整点边界', () => {
  it('窗口内取最近整点', () => {
    expect(latestBoundaryHour(at(10, 30), DEFAULT)).toBe(10)
    expect(latestBoundaryHour(at(9, 0), DEFAULT)).toBe(9)
  })

  it('窗口开始前 / 结束后返回 null', () => {
    expect(latestBoundaryHour(at(8, 59), DEFAULT)).toBeNull()
    expect(latestBoundaryHour(at(23, 0), DEFAULT)).toBeNull()
  })
})

describe('shouldCheckinRemind(前台轮询判定)', () => {
  it('未开启 → 永不提醒', () => {
    expect(shouldCheckinRemind(at(10), '2026-09-29', null, { ...DEFAULT, enabled: false })).toEqual({
      remind: false,
      key: null,
    })
  })

  it('今天已打卡 → 不再提醒', () => {
    expect(shouldCheckinRemind(at(10), '2026-09-30', null, DEFAULT)).toEqual({
      remind: false,
      key: null,
    })
  })

  it('窗口开始前 → 不提醒', () => {
    expect(shouldCheckinRemind(at(8), '2026-09-29', null, DEFAULT)).toEqual({
      remind: false,
      key: null,
    })
  })

  it('窗口结束后 → 不提醒(今天不再催)', () => {
    expect(shouldCheckinRemind(at(23), '2026-09-29', null, DEFAULT)).toEqual({
      remind: false,
      key: null,
    })
  })

  it('窗口内已过整点且未提醒过 → 提醒,并给出去重键', () => {
    const res = shouldCheckinRemind(at(10, 5), '2026-09-29', null, DEFAULT)
    expect(res).toEqual({ remind: true, key: '2026-09-30-10' })
  })

  it('同一小时已提醒过 → 不再提醒(每小时一次)', () => {
    expect(shouldCheckinRemind(at(10, 40), '2026-09-29', '2026-09-30-10', DEFAULT).remind).toBe(false)
    // 跨整点后恢复提醒
    expect(shouldCheckinRemind(at(11, 1), '2026-09-29', '2026-09-30-10', DEFAULT).remind).toBe(true)
  })

  it('去重键格式:日期-小时', () => {
    expect(remindKey(at(14, 30), 14)).toBe('2026-09-30-14')
  })
})

describe('下一次提醒与今日时间点', () => {
  it('nextReminderAt:窗口内返回下一个整点', () => {
    expect(nextReminderAt(at(10, 30), DEFAULT)?.getHours()).toBe(11)
    expect(nextReminderAt(at(9, 0), DEFAULT)?.getHours()).toBe(10)
  })

  it('nextReminderAt:窗口开始前返回开始整点,结束后返回 null', () => {
    expect(nextReminderAt(at(8, 0), DEFAULT)?.getHours()).toBe(9)
    expect(nextReminderAt(at(23, 0), DEFAULT)).toBeNull()
  })

  it('reminderTimesForDay:默认窗口给出 14 个整点,可只留未来', () => {
    const past = reminderTimesForDay(at(20, 0), DEFAULT, true)
    expect(past).toHaveLength(14)
    expect(past[0].getHours()).toBe(9)

    const future = reminderTimesForDay(at(20, 30), DEFAULT)
    expect(future.every((t) => t.getTime() > at(20, 30).getTime())).toBe(true)
    expect(future[0].getHours()).toBe(21)
  })
})