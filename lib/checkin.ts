/**
 * 每日打卡 + 每小时提醒 —— 纯逻辑层,零存储/通知依赖,可单测。
 *
 * 语义:开关开启后,当天若还没打卡,从设置窗口内的第一个整点起,
 * 每个整点提醒一次(每小时一次),直到打卡或窗口结束;次日自动重置。
 * 窗口按整点小时切片(开始/结束时刻向上/向下取整点)。
 */

/** 打卡提醒配置。 */
export interface CheckinConfig {
  enabled: boolean
  /** 窗口开始,一天内的分钟数(9*60 = 09:00);取它所在整点小时起 */
  startMinute: number
  /** 窗口结束,一天内的分钟数(22*60 = 22:00);取它所在整点小时止 */
  endMinute: number
}

export const DEFAULT_CHECKIN_CONFIG: CheckinConfig = {
  enabled: false,
  startMinute: 9 * 60,
  endMinute: 22 * 60,
}

/** 每小时提醒一次(用户要求,固定 60 分钟)。 */
export const CHECKIN_INTERVAL_MINUTES = 60

/** 日期键:YYYY-MM-DD(打卡按天记账)。 */
export function dateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 今天是否已打卡。 */
export function isCheckedInToday(lastCheckinDate: string | null, now: Date): boolean {
  return lastCheckinDate === dateKey(now)
}

/** 把一天内的分钟数夹成 0–23 的整点小时。 */
function clampHour(minuteOfDay: number): number {
  return Math.max(0, Math.min(23, Math.floor(minuteOfDay / 60)))
}

/** 窗口内的整点小时列表([startHour, endHour] 闭区间,升序)。 */
export function windowHours(config: CheckinConfig): number[] {
  const s = clampHour(config.startMinute)
  const e = clampHour(config.endMinute)
  const hours: number[] = []
  for (let h = s; h <= e; h++) hours.push(h)
  return hours
}

/**
 * 最近一个「已到达」的整点边界小时(窗口内)。
 * 窗口还没开始(now 早于 start 所在整点)或已结束(now 晚于 end 所在整点)返回 null。
 */
export function latestBoundaryHour(now: Date, config: CheckinConfig): number | null {
  const hours = windowHours(config)
  if (!hours.length) return null
  const endHour = hours[hours.length - 1]!
  const h = now.getHours()
  // 窗口已结束(过了最后一个整点边界所在小时):今天不再提醒
  if (h > endHour) return null
  let latest: number | null = null
  for (const bh of hours) {
    if (bh <= h) latest = bh
  }
  return latest
}

/** 提醒去重键:日期-小时。每小时只提醒一次。 */
export function remindKey(now: Date, hour: number): string {
  return `${dateKey(now)}-${hour}`
}

/**
 * 前台是否应在当前时刻提醒。
 * 条件:开启 && 今天未打卡 && 窗口内有已到达整点 && 该小时还没提醒过。
 */
export function shouldCheckinRemind(
  now: Date,
  lastCheckinDate: string | null,
  lastRemindKey: string | null,
  config: CheckinConfig,
): { remind: boolean; key: string | null } {
  if (!config.enabled) return { remind: false, key: null }
  if (isCheckedInToday(lastCheckinDate, now)) return { remind: false, key: null }
  const hour = latestBoundaryHour(now, config)
  if (hour === null) return { remind: false, key: null }
  const key = remindKey(now, hour)
  return { remind: lastRemindKey !== key, key }
}

/** 下一次提醒时间(今天窗口内最近的未到达整点);已过窗口返回 null。 */
export function nextReminderAt(now: Date, config: CheckinConfig): Date | null {
  if (!config.enabled) return null
  for (const bh of windowHours(config)) {
    const t = new Date(now)
    t.setHours(bh, 0, 0, 0)
    if (t.getTime() > now.getTime()) return t
  }
  return null
}

/**
 * 今天窗口内的全部提醒时间点(系统通知调度用)。
 * includePast=false 时去掉已过的时间点(只排未来)。
 */
export function reminderTimesForDay(
  now: Date,
  config: CheckinConfig,
  includePast = false,
): Date[] {
  const times: Date[] = []
  for (const bh of windowHours(config)) {
    const t = new Date(now)
    t.setHours(bh, 0, 0, 0)
    if (includePast || t.getTime() > now.getTime()) times.push(t)
  }
  return times
}