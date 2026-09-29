/**
 * 卡片配色。
 *
 * 设计原则:
 *   1. **低饱和** —— 与整体浅灰基调一致,颜色只用于"区分",不用于"抢眼"。
 *   2. **确定性** —— 同一合集永远得到同一颜色(按 id 哈希取模),
 *      用户会自然形成"蓝色是数学"的位置记忆。
 *   3. **可读性优先** —— 底色足够浅,保证深色正文有足够对比度。
 *
 * 输出 CSS 变量,由组件挂到元素上,样式表只消费变量。
 */

/** 一套配色:双色渐变底 + 强调色。 */
export interface Palette {
  /** 渐变起始(浅) */
  tintA: [number, number, number]
  /** 渐变结束(略深) */
  tintB: [number, number, number]
  /** 强调色:进度条、标签边框等 */
  accent: string
}

/**
 * 低饱和粉彩调色板(12 组)。
 *
 * 取 12 组而非 8 组,是为了让"常见的 5–8 个合集"几乎不会撞色 ——
 * 颜色一旦重复就失去区分意义。色相覆盖蓝/青/绿/黄/橙/红/紫,
 * 但饱和度都压得很低,与整体浅灰基调一致。
 */
export const CARD_PALETTE: readonly Palette[] = [
  { tintA: [233, 241, 250], tintB: [219, 231, 245], accent: '#6d92c4' }, // 蓝
  { tintA: [230, 244, 238], tintB: [216, 236, 227], accent: '#5fa98c' }, // 青绿
  { tintA: [247, 241, 227], tintB: [240, 231, 211], accent: '#c2a05f' }, // 沙黄
  { tintA: [250, 234, 239], tintB: [245, 222, 229], accent: '#c47a92' }, // 玫红
  { tintA: [239, 235, 250], tintB: [229, 222, 245], accent: '#8f7cc0' }, // 淡紫
  { tintA: [238, 243, 227], tintB: [228, 236, 213], accent: '#93a765' }, // 橄榄
  { tintA: [228, 242, 246], tintB: [214, 234, 240], accent: '#5fa3b5' }, // 天蓝
  { tintA: [248, 236, 230], tintB: [240, 222, 212], accent: '#c08a6f' }, // 陶土
  { tintA: [235, 238, 248], tintB: [223, 228, 243], accent: '#7b86bf' }, // 靛蓝
  { tintA: [244, 238, 232], tintB: [236, 227, 218], accent: '#a98f76' }, // 卡其
  { tintA: [231, 243, 243], tintB: [217, 235, 236], accent: '#5f9fa3' }, // 青灰
  { tintA: [249, 238, 236], tintB: [242, 226, 222], accent: '#c58279' }, // 珊瑚
]

/**
 * 专用于配色的哈希(cyrb53 风格)。
 *
 * 为什么不复用 `lib/hash.ts` 的 `hash32`:
 *   1. `hash32` 是 FNV-1a,其**低位分布很差** —— 用取模选颜色时,
 *      五个中文合集名只落到 3 种颜色,颜色就失去了区分意义;
 *   2. 更重要的是,`hash32` 已被 Anki 卡片 id 使用,改动它会破坏
 *      已有用户的导入去重(同一份 apkg 会被判成新卡)。所以这里
 *      单独实现一个雪崩性更好的哈希,互不影响。
 *
 * 取色用「归一化到 [0,1) 再乘组数」,而非直接取模 —— 充分利用
 * 全部 32 位熵。
 */
export function mixHash(input: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return h1 >>> 0
}

/**
 * 按 key 取配色(确定性)。
 *
 * @param key   合集 id
 * @param index 合集在列表中的**序号**(可选)
 *
 * 为什么优先用序号而不是哈希:
 *   哈希取模在多组 key 下**必然发生碰撞** —— 实测 5 个中文合集名
 *   无论用 FNV-1a 还是 cyrb53,都会有两组撞成同一颜色,颜色就失去了
 *   区分意义。传入序号则天然无碰撞,且顺序稳定(合集顺序不变,
 *   颜色就不变)。哈希仅作为"拿不到序号"时的兜底。
 */
export function paletteFor(key: string, index?: number): Palette {
  if (typeof index === 'number' && Number.isFinite(index) && index >= 0) {
    return CARD_PALETTE[Math.floor(index) % CARD_PALETTE.length]!
  }
  // 兜底:按哈希取色。分布均匀但可能与其他 key 撞色,仅在无序号时使用。
  const seed = mixHash(key || 'inbox')
  const hashed = Math.floor((seed / 4294967296) * CARD_PALETTE.length)
  return CARD_PALETTE[Math.min(hashed, CARD_PALETTE.length - 1)]!
}

/** 把配色转成 CSS 变量对象,直接绑定到 style。 */
export function paletteVars(palette: Palette, alpha = 0.9): Record<string, string> {
  const toRgba = ([r, g, b]: [number, number, number]) => `rgba(${r}, ${g}, ${b}, ${alpha})`
  return {
    '--card-tint-a': toRgba(palette.tintA),
    '--card-tint-b': toRgba(palette.tintB),
    '--card-accent': palette.accent,
  }
}
