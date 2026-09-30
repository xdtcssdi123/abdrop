/**
 * 打开 APKG 文件的识别 —— 纯逻辑,可单测。
 *
 * 场景:手机文件管理器里点一个 .apkg,系统把文件以 content:// 或 file://
 * 的 URI 交给本 App。这里负责从 URI 判断它是否是可导入的牌组,并给出
 * 导入用的文件名(取不到文件名时兜底为 .apkg,保证走 apkg 解析路径)。
 */

/** 本 App 可导入的牌组扩展名。 */
export const DECK_EXTENSIONS = ['apkg', 'colpkg', 'anki']

/** 从打开意图的 URI 中提取文件名;不是牌组扩展名返回 null。 */
export function apkgNameFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null
  // 去掉 query / fragment(部分 content URI 带参数)
  const clean = uri.split(/[?#]/)[0] ?? uri
  const rawName = clean.split('/').pop() ?? ''
  const name = decodeURIComponent(rawName)
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (!DECK_EXTENSIONS.includes(ext)) return null
  return name
}

/** 导入用文件名:能识别就用原名,否则兜底 .apkg(保证走 apkg 解析)。 */
export function importFileNameFromUri(uri: string | null | undefined): string {
  return apkgNameFromUri(uri) ?? 'imported.apkg'
}