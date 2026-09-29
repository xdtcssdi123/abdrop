/**
 * 通用哈希工具。
 *
 * 为什么单独成文件:它是纯粹的字符串工具,被卡片去重(`anki-map`)和
 * 卡片配色(`palette`)共用。放在业务模块里会造成无谓的依赖牵连。
 */

/** 32 位 FNV-1a 哈希 —— 只要确定性与均匀分布,不需要加密强度。 */
export function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
