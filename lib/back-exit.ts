/**
 * 返回键决策 —— 纯逻辑,可单测。
 *
 * Android 惯例:主界面(首页)按返回键**两次**才退出(第一次提示,防误退);
 * 其他页面按返回键 → 回退到上一页。
 */

export const HOME_PATH = '/'

/** 返回键处理结果。 */
export type BackAction = 'navigate-back' | 'hint-exit' | 'exit-app'

/**
 * 决策一次返回键该怎么处理。
 * @param path          当前路由路径
 * @param lastBackAtMs  上一次「提示退出」的时间戳(非首页时为 0 或任意值)
 * @param now           当前时间戳
 * @param exitWindowMs  两次按返回的最大间隔(默认 2000ms)
 */
export function decideBack(
  path: string,
  lastBackAtMs: number,
  now: number,
  exitWindowMs = 2000,
): BackAction {
  // 非首页:回退到上一页
  if (path !== HOME_PATH) return 'navigate-back'
  // 首页:两秒内第二次按返回 → 退出;第一次 → 提示
  if (now - lastBackAtMs < exitWindowMs) return 'exit-app'
  return 'hint-exit'
}