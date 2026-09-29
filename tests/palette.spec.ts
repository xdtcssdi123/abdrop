/**
 * 配色测试。
 *
 * 配色是"看得见的"功能,必须锁住两条性质:
 *   1. 确定性 —— 同一合集每次都是同一颜色(用户会形成位置记忆);
 *   2. 分散性 —— 不同合集尽量落到不同颜色(否则颜色失去区分意义)。
 */
import { describe, expect, it } from 'vitest'
import { CARD_PALETTE, paletteFor, paletteVars } from '~/lib/palette'
import { hash32 } from '~/lib/hash'
import { SEED_COLLECTIONS } from '~/lib/seed'

describe('hash32', () => {
  it('确定性', () => {
    expect(hash32('abc')).toBe(hash32('abc'))
  })

  it('区分相近输入', () => {
    expect(hash32('abc')).not.toBe(hash32('abd'))
  })

  it('落在 32 位无符号范围内', () => {
    for (const s of ['', 'a', '数学', 'x'.repeat(500)]) {
      const h = hash32(s)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(2 ** 32)
    }
  })

  it('空串也能得到稳定值', () => {
    expect(hash32('')).toBe(hash32(''))
  })
})

describe('调色板健康度', () => {
  it('至少 6 组颜色,足够区分常见合集数', () => {
    expect(CARD_PALETTE.length).toBeGreaterThanOrEqual(6)
  })

  it('每组的强调色是合法 hex', () => {
    for (const p of CARD_PALETTE) {
      expect(p.accent, p.accent).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('底色保持低饱和:每个通道都在浅色区间', () => {
    for (const p of CARD_PALETTE) {
      for (const channel of [...p.tintA, ...p.tintB]) {
        // 大于 200 保证是"浅色",深色文字才有足够对比度
        expect(channel, `${p.accent} 通道 ${channel}`).toBeGreaterThan(200)
        expect(channel).toBeLessThanOrEqual(255)
      }
    }
  })

  it('渐变两端有可见差异,不是纯色', () => {
    for (const p of CARD_PALETTE) {
      const diff =
        Math.abs(p.tintA[0] - p.tintB[0]) +
        Math.abs(p.tintA[1] - p.tintB[1]) +
        Math.abs(p.tintA[2] - p.tintB[2])
      expect(diff, p.accent).toBeGreaterThan(8)
    }
  })

  it('强调色之间互不重复', () => {
    const accents = CARD_PALETTE.map((p) => p.accent)
    expect(new Set(accents).size).toBe(accents.length)
  })
})

describe('paletteFor 确定性', () => {
  it('同一 key 永远同一配色', () => {
    expect(paletteFor('数学')).toEqual(paletteFor('数学'))
    expect(paletteFor('col-1')).toEqual(paletteFor('col-1'))
  })

  it('返回值一定来自调色板', () => {
    for (const key of ['a', 'b', '数学', '计算机', 'inbox']) {
      expect(CARD_PALETTE).toContainEqual(paletteFor(key))
    }
  })

  it('空 key 也能稳定取色(不崩、不随机)', () => {
    expect(paletteFor('')).toEqual(paletteFor(''))
    expect(paletteFor('')).toEqual(paletteFor('inbox'))
  })

  it('任意输入都不抛异常', () => {
    for (const key of ['', '😀', 'x'.repeat(1000), '\n\t']) {
      expect(() => paletteFor(key)).not.toThrow()
    }
  })
})

describe('paletteFor 按序号分配(主路径)', () => {
  it('按序号分配时,前 N 个合集颜色两两不同', () => {
    // 这是颜色的核心契约:同一屏内不能撞色
    const n = Math.min(SEED_COLLECTIONS.length, CARD_PALETTE.length)
    const colors = Array.from({ length: n }, (_, i) => paletteFor(`c${i}`, i).accent)
    expect(new Set(colors).size).toBe(n)
  })

  it('序号相同则颜色相同(稳定)', () => {
    expect(paletteFor('数学', 0)).toEqual(paletteFor('计算机', 0))
  })

  it('序号决定颜色,与 key 无关', () => {
    expect(paletteFor('任意', 3).accent).toBe(CARD_PALETTE[3]!.accent)
  })

  it('序号超出调色板长度时循环取色,不越界', () => {
    expect(paletteFor('x', CARD_PALETTE.length).accent).toBe(CARD_PALETTE[0]!.accent)
    expect(paletteFor('x', CARD_PALETTE.length * 3 + 2).accent).toBe(CARD_PALETTE[2]!.accent)
  })

  it('非法序号回落到哈希取色,不抛异常', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => paletteFor('数学', bad)).not.toThrow()
      expect(CARD_PALETTE).toContainEqual(paletteFor('数学', bad))
    }
  })

  it('小数序号向下取整', () => {
    expect(paletteFor('x', 2.9).accent).toBe(CARD_PALETTE[2]!.accent)
  })
})

describe('paletteFor 哈希兜底', () => {
  it('拿不到序号时也能给出稳定颜色', () => {
    expect(paletteFor('数学')).toEqual(paletteFor('数学'))
    expect(CARD_PALETTE).toContainEqual(paletteFor('数学'))
  })

  it('兜底路径分布均匀,不会集中到某一色', () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 300; i++) {
      const accent = paletteFor(`collection-${i}`).accent
      counts.set(accent, (counts.get(accent) ?? 0) + 1)
    }
    // 12 组色分 300 个 key,理论每组 25 个;任何一组超过 40% 即视为聚集
    expect(counts.size).toBe(CARD_PALETTE.length)
    for (const n of counts.values()) expect(n).toBeLessThan(300 * 0.4)
  })
})

describe('paletteVars', () => {
  it('产出三个 CSS 变量', () => {
    const vars = paletteVars(paletteFor('数学'))
    expect(Object.keys(vars).sort()).toEqual(['--card-accent', '--card-tint-a', '--card-tint-b'])
  })

  it('底色带 alpha,保证磨砂透光感', () => {
    const vars = paletteVars(paletteFor('数学'), 0.85)
    expect(vars['--card-tint-a']).toMatch(/^rgba\(.+,\s*0\.85\)$/)
    expect(vars['--card-tint-b']).toMatch(/^rgba\(.+,\s*0\.85\)$/)
  })

  it('强调色不带 alpha(用于描边,需要实色)', () => {
    const vars = paletteVars(paletteFor('数学'))
    expect(vars['--card-accent']).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('默认 alpha 在合理区间', () => {
    const vars = paletteVars(paletteFor('x'))
    const m = vars['--card-tint-a']!.match(/,\s*([\d.]+)\)$/)
    const alpha = Number(m![1])
    expect(alpha).toBeGreaterThan(0.5)
    expect(alpha).toBeLessThanOrEqual(1)
  })
})
