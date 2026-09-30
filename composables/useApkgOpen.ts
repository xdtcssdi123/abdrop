/**
 * 打开 APKG → 导入 —— 原生能力桥接。
 *
 * 手机文件管理器「用 ABDrop 打开 .apkg」:
 *   - 冷启动:首页读取 App.getLaunchUrl() 拿到文件 URI
 *   - 应用已打开:根组件监听 App.addListener('appUrlOpen')
 * 拿到 URI 后用 Filesystem 读字节 → 构造 File → importAnkiFile 入库。
 * Web/测试环境优雅降级(返回 null)。
 */

import { isNativePlatform } from '~/composables/useNativeBridge'
import { importAnkiFile } from '~/lib/anki-io'
import { apkgNameFromUri, importFileNameFromUri } from '~/lib/open-apkg'
import type { CardRepository } from '~/lib/db'
import type { ImportReport } from '~/types'

/** 从打开意图 URI 读牌组并导入;非原生环境或读取失败返回 null。 */
export async function importApkgFromUri(
  uri: string,
  repo: CardRepository,
): Promise<ImportReport | null> {
  if (!isNativePlatform()) return null
  try {
    const { Filesystem } = await import('@capacitor/filesystem')
    const { data } = await Filesystem.readFile({ path: uri })
    // 原生实现返回 base64 字符串(类型声明里带了 Web 端 Blob,这里统一转字符串)
    const bytes = base64ToBytes(String(data))
    const file = new File([bytes], importFileNameFromUri(uri), {
      type: 'application/octet-stream',
    })
    return await importAnkiFile(file, repo)
  } catch {
    return null
  }
}

/** base64 → Uint8Array(apkg 是二进制,Filesystem 默认返回 base64)。 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof atob !== 'undefined') {
    const bin = atob(b64)
    const buf = new ArrayBuffer(bin.length)
    const out = new Uint8Array(buf)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  // Node 兜底
  const src = Buffer.from(b64, 'base64')
  const out = new Uint8Array(new ArrayBuffer(src.byteLength))
  out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength))
  return out
}

/** 是否是一次「打开牌组」的意图 URI(带扩展名的常规路径)。 */
export function isDeckOpenUri(uri: string | null | undefined): boolean {
  return apkgNameFromUri(uri) !== null
}