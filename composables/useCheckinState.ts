/**
 * 打卡提醒状态:持久化 + 系统后台通知调度。
 *
 * 存储(localStorage,跨端兼容):
 *   - 最近打卡日期(YYYY-MM-DD,按天重置)
 *   - 提醒配置(开关 + 开始/结束时间)
 *
 * 提醒 = 系统通知(Capacitor LocalNotifications):应用打开时排好今天剩余整点,
 * 后台/关闭时由系统按时发出;Web/测试环境优雅降级(不调度)。
 */

import { computed } from 'vue'
// 与 useAppState 同样的约定:显式从 '#imports' 导入,单测能跑到同一份代码
import { useState } from '#imports'
import { getStoredValue, setStoredValue } from '~/composables/useAppState'
import { isNativePlatform, hapticTap } from '~/composables/useNativeBridge'
import {
  DEFAULT_CHECKIN_CONFIG,
  dateKey,
  reminderTimesForDay,
  type CheckinConfig,
} from '~/lib/checkin'
import { getClockOffsetMs, testNow } from '~/lib/clock'

const CHECKIN_DATE_KEY = 'abdrop.checkin.date'
const CHECKIN_CONFIG_KEY = 'abdrop.checkin.config'

/** 已排入系统通知的 id 集合(模块级,全应用共享)。 */
const scheduledIds = new Set<number>()

async function getLocalNotifications() {
  if (!isNativePlatform()) return null
  try {
    return await import('@capacitor/local-notifications')
  } catch {
    return null
  }
}

export function useCheckinState() {
  const lastCheckinDate = useState<string | null>('abdrop.checkinDate', () => null)
  const config = useState<CheckinConfig>('abdrop.checkinConfig', () => ({
    ...DEFAULT_CHECKIN_CONFIG,
  }))

  /** 今天是否已打卡(按测试时钟判定,供界面即时响应)。 */
  const checkedInToday = computed(() => dateKey(testNow()) === lastCheckinDate.value)

  async function load(): Promise<void> {
    const d = await getStoredValue(CHECKIN_DATE_KEY)
    lastCheckinDate.value = d || null
    const raw = await getStoredValue(CHECKIN_CONFIG_KEY)
    if (raw) {
      try {
        config.value = { ...DEFAULT_CHECKIN_CONFIG, ...JSON.parse(raw) }
      } catch {
        /* 配置损坏用默认值 */
      }
    }
  }

  /** 打卡:记下「今天(测试时钟)」的日期,取消剩余的系统提醒。 */
  async function checkIn(): Promise<void> {
    lastCheckinDate.value = dateKey(testNow())
    await setStoredValue(CHECKIN_DATE_KEY, lastCheckinDate.value)
    await cancelScheduledNotifications()
    void hapticTap('medium')
  }

  /** 更新提醒配置:立即持久化,并按新窗口重排系统通知。 */
  async function updateConfig(next: Partial<CheckinConfig>): Promise<void> {
    config.value = { ...config.value, ...next }
    await setStoredValue(CHECKIN_CONFIG_KEY, JSON.stringify(config.value))
    await scheduleNotificationsIfNeeded()
  }

  // ── 系统通知 ──────────────────────────────────────────────
  async function ensureNotificationPermission(ln: any): Promise<boolean> {
    try {
      const perm = await ln.LocalNotifications.checkPermissions()
      if (perm.display === 'granted') return true
      const req = await ln.LocalNotifications.requestPermissions()
      return req.display === 'granted'
    } catch {
      return false
    }
  }

  /** 按当前配置排今天剩余整点的提醒;未开启/已打卡则清空。测试时钟偏移时不排(时间不真实)。 */
  async function scheduleNotificationsIfNeeded(): Promise<void> {
    const ln = await getLocalNotifications()
    if (!ln) return
    if (!config.value.enabled || checkedInToday.value) {
      await cancelScheduledNotifications()
      return
    }
    // 时间调试期间不排真实系统通知,避免按假时间弹出
    if (getClockOffsetMs() !== 0) return
    const granted = await ensureNotificationPermission(ln)
    if (!granted) return
    try {
      await cancelScheduledNotifications()
      const times = reminderTimesForDay(testNow(), config.value)
      const notifications = times.map((at, i) => ({
        id: 5000 + i,
        title: 'ABDrop · 打卡提醒',
        body: '今天还没打卡,记得来打卡哦',
        schedule: { at },
      }))
      await ln.LocalNotifications.schedule({ notifications })
      for (const n of notifications) scheduledIds.add(n.id)
    } catch {
      /* 调度失败不阻塞主流程 */
    }
  }

  async function cancelScheduledNotifications(): Promise<void> {
    const ln = await getLocalNotifications()
    if (!ln || !scheduledIds.size) return
    try {
      await ln.LocalNotifications.cancel({
        notifications: [...scheduledIds].map((id) => ({ id })),
      })
      scheduledIds.clear()
    } catch {
      /* 取消失败不阻塞 */
    }
  }

  return {
    config,
    lastCheckinDate,
    checkedInToday,
    load,
    checkIn,
    updateConfig,
    scheduleNotificationsIfNeeded,
  }
}