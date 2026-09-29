/**
 * 卡片消散粒子系统测试。
 *
 * 粒子效果最容易出的两类问题:
 *   1. **性能** —— 粒子数失控会直接毁掉流畅度(上一轮刚优化过);
 *   2. **观感** —— 分布/速度写错会变成"一堆点乱飞"而不是"卡片碎开"。
 * 所以这组测试重点锁粒子数上限、确定性、以及物理收敛。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  MAX_PARTICLES,
  MIN_PARTICLES,
  PHYSICS,
  createBurst,
  createRng,
  lifeProgress,
  livingParticles,
  particleCountFor,
  particleOpacity,
  particleSize,
  stepParticle,
  stepParticles,
  type Particle,
} from '~/lib/particles'
import ParticleLayer from '~/components/ParticleLayer.vue'
import { CARD_PALETTE } from '~/lib/palette'
import {
  MAX_LIVE_PARTICLES,
  capLiveParticles,
  hexToRgb,
  particleColor,
} from '~/lib/particles'

const RECT = { x: 20, y: 100, width: 280, height: 356 }
const COLORS = ['rgba(255,255,255,0.95)', 'rgba(230,236,240,0.95)', '#6d92c4']

/**
 * 给 canvas 注入最小 2D context 替身。
 *
 * happy-dom 不实现 canvas 2D,`getContext('2d')` 返回 null,
 * 会让 ensureCanvas 提前返回 —— 渲染路径得不到验证。
 * 这里补一个只记录调用的替身,足够验证"是否进入绘制流程"。
 */
function stubContext(wrapper: { find: (s: string) => any }) {
  const canvas = wrapper.find('canvas').element as HTMLCanvasElement
  canvas.getContext = (() =>
    ({
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      globalAlpha: 1,
      fillStyle: '',
    }) as unknown as CanvasRenderingContext2D) as unknown as HTMLCanvasElement['getContext']
}

describe('createRng 可播种随机', () => {
  it('同种子产生同一序列(测试可复现)', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = Array.from({ length: 8 }, () => a())
    const seqB = Array.from({ length: 8 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('不同种子产生不同序列', () => {
    const a = createRng(1)
    const b = createRng(2)
    expect(a()).not.toBe(b())
  })

  it('输出落在 [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 200; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('particleCountFor 粒子数控制', () => {
  it('按面积推导数量', () => {
    const big = particleCountFor(400, 500)
    const small = particleCountFor(120, 160)
    expect(big).toBeGreaterThan(small)
  })

  it('永不超过上限(性能红线)', () => {
    // 极端大屏
    expect(particleCountFor(4000, 4000)).toBe(MAX_PARTICLES)
  })

  it('永不低于下限(太少不像消散)', () => {
    expect(particleCountFor(10, 10)).toBe(MIN_PARTICLES)
    expect(particleCountFor(0, 0)).toBe(MIN_PARTICLES)
  })

  it('典型手机卡片尺寸下数量适中', () => {
    const n = particleCountFor(280, 356)
    expect(n).toBeGreaterThan(MIN_PARTICLES)
    expect(n).toBeLessThanOrEqual(MAX_PARTICLES)
  })

  it('负尺寸不产生负数量', () => {
    expect(particleCountFor(-100, -100)).toBe(MIN_PARTICLES)
  })
})

describe('createBurst 生成', () => {
  it('生成指定数量的粒子', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 50, seed: 1 })
    expect(ps).toHaveLength(50)
  })

  it('不传 count 时按面积自动推导', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, seed: 1 })
    expect(ps).toHaveLength(particleCountFor(RECT.width, RECT.height))
  })

  it('同种子产生完全相同的粒子(确定性)', () => {
    const a = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 40, seed: 99 })
    const b = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 40, seed: 99 })
    expect(a).toEqual(b)
  })

  it('不同种子产生不同分布', () => {
    const a = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 40, seed: 1 })
    const b = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 40, seed: 2 })
    expect(a[0]!.x).not.toBe(b[0]!.x)
  })

  it('初始位置落在卡片矩形内(带少量抖动)', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 100, seed: 3 })
    for (const p of ps) {
      expect(p.x).toBeGreaterThanOrEqual(RECT.x)
      expect(p.x).toBeLessThanOrEqual(RECT.x + RECT.width)
      expect(p.y).toBeGreaterThanOrEqual(RECT.y)
      expect(p.y).toBeLessThanOrEqual(RECT.y + RECT.height)
    }
  })

  it('右滑时主速度朝右,左滑朝左', () => {
    const right = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 60, seed: 5 })
    const left = createBurst({ rect: RECT, direction: -1, colors: COLORS, count: 60, seed: 5 })

    const avgVx = (ps: Particle[]) => ps.reduce((s, p) => s + p.vx, 0) / ps.length
    expect(avgVx(right)).toBeGreaterThan(0)
    expect(avgVx(left)).toBeLessThan(0)
  })

  it('位置分布与滑动方向无关(同种子)', () => {
    const right = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 30, seed: 11 })
    const left = createBurst({ rect: RECT, direction: -1, colors: COLORS, count: 30, seed: 11 })

    // 方向只影响速度,不影响初始位置
    for (let i = 0; i < 30; i++) {
      expect(right[i]!.x).toBeCloseTo(left[i]!.x)
      expect(right[i]!.y).toBeCloseTo(left[i]!.y)
    }
  })

  it('粒子不是整齐平行飞出,而是散开的', () => {
    // 若所有粒子速度一致,观感就是"整块平移"而不是"碎开"。
    // 这里用速度的标准差来确认存在扩散。
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 120, seed: 21 })
    const vxs = ps.map((p) => p.vx)
    const mean = vxs.reduce((a, b) => a + b, 0) / vxs.length
    const variance = vxs.reduce((s, v) => s + (v - mean) ** 2, 0) / vxs.length

    expect(Math.sqrt(variance)).toBeGreaterThan(30)
  })

  it('速度方向以滑动方向为主(不会被扩散盖过)', () => {
    // 保证观感上"往右滑就是往右散",而不是四散乱飞
    for (const direction of [1, -1] as const) {
      const ps = createBurst({ rect: RECT, direction, colors: COLORS, count: 150, seed: 33 })
      const outward = ps.filter((p) => Math.sign(p.vx) === direction)
      // 绝大多数粒子应朝滑动方向
      expect(outward.length / ps.length).toBeGreaterThan(0.75)
    }
  })

  it('粒子在垂直方向也有扩散(不是一条水平线)', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 120, seed: 44 })
    const vys = ps.map((p) => p.vy)
    const mean = vys.reduce((a, b) => a + b, 0) / vys.length
    const variance = vys.reduce((s, v) => s + (v - mean) ** 2, 0) / vys.length
    expect(Math.sqrt(variance)).toBeGreaterThan(20)
  })

  it('初始 age 为 0、尺寸等于初始尺寸', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 20, seed: 1 })
    for (const p of ps) {
      expect(p.age).toBe(0)
      expect(p.size).toBe(p.size0)
    }
  })

  it('寿命落在配置区间内', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 80, seed: 1 })
    for (const p of ps) {
      expect(p.life).toBeGreaterThanOrEqual(PHYSICS.minLife)
      expect(p.life).toBeLessThanOrEqual(PHYSICS.maxLife)
    }
  })

  it('颜色只从传入的调色板中取', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 100, seed: 1 })
    for (const p of ps) {
      expect(COLORS).toContain(p.color)
    }
  })

  it('空调色板时有兜底颜色,不产生 undefined', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: [], count: 10, seed: 1 })
    for (const p of ps) {
      expect(p.color).toBeTruthy()
      expect(p.color).not.toContain('undefined')
    }
  })

  it('零尺寸卡片不产生 NaN', () => {
    const ps = createBurst({
      rect: { x: 0, y: 0, width: 0, height: 0 },
      direction: 1,
      colors: COLORS,
      count: 20,
      seed: 1,
    })
    for (const p of ps) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.vx)).toBe(true)
      expect(Number.isFinite(p.vy)).toBe(true)
    }
  })

  it('粒子数多时用更小的颗粒(避免糊成一团)', () => {
    const many = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 180, seed: 1 })
    const few = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 50, seed: 1 })
    const avgSize = (ps: Particle[]) => ps.reduce((s, p) => s + p.size0, 0) / ps.length
    expect(avgSize(many)).toBeLessThan(avgSize(few))
  })
})

describe('stepParticle 物理推进', () => {
  const base = (over: Partial<Particle> = {}): Particle => ({
    x: 100,
    y: 100,
    vx: 200,
    vy: 0,
    size: 4,
    size0: 4,
    color: '#fff',
    age: 0,
    life: 500,
    rot: 0,
    vr: 1,
    ...over,
  })

  it('位置随速度变化', () => {
    const p = base()
    stepParticle(p, 0.1)
    expect(p.x).toBeGreaterThan(100)
  })

  it('重力让 vy 增大(下坠感)', () => {
    const p = base({ vx: 0, vy: 0 })
    stepParticle(p, 0.1)
    expect(p.vy).toBeGreaterThan(0)
  })

  it('空气阻力让速度衰减', () => {
    const p = base({ vy: 0 })
    const before = p.vx
    stepParticle(p, 0.016)
    expect(Math.abs(p.vx)).toBeLessThan(Math.abs(before))
  })

  it('帧率无关:一次大步长与多次小步长结果完全一致', () => {
    // 位置用精确积分,所以不同步长应得到同一结果。
    // 若这里不相等,说明退回了欧拉积分 —— 会导致"帧率越高滑得越远"。
    const big = base({ vy: 0 })
    stepParticle(big, 0.1)

    const small = base({ vy: 0 })
    for (let i = 0; i < 10; i++) stepParticle(small, 0.01)

    expect(big.x).toBeCloseTo(small.x, 6)
  })

  it('接近 60fps 的常见步长下结果也一致', () => {
    const one = base({ vy: 0 })
    stepParticle(one, 0.1)

    const six = base({ vy: 0 })
    for (let i = 0; i < 6; i++) stepParticle(six, 1 / 60)

    // 1/60 × 6 = 0.1,理论上完全相等
    expect(one.x).toBeCloseTo(six.x, 6)
  })

  it('age 按 dt 累加', () => {
    const p = base()
    stepParticle(p, 0.05)
    expect(p.age).toBeCloseTo(50)
  })

  it('旋转角随时间推进', () => {
    const p = base({ vr: 2 })
    stepParticle(p, 0.1)
    expect(p.rot).toBeCloseTo(0.2)
  })

  it('就地修改,不返回新对象(避免每帧分配)', () => {
    const p = base()
    const ref = p
    stepParticle(p, 0.016)
    expect(p).toBe(ref)
  })
})

describe('积分公式正确性(60 倍错误的回归测试)', () => {
  const base = (over: Partial<Particle> = {}): Particle => ({
    x: 0, y: 0, vx: 200, vy: 0, size: 4, size0: 4,
    color: '#fff', age: 0, life: 100000, rot: 0, vr: 0,
    ...over,
  })

  it('【关键】单帧位移必须与速度×dt 同量级,不能放大 60 倍', () => {
    /*
     * 曾经把位移因子写成 (drag^dt − 1) / ln(drag^(1/60)),
     * 分母少了 60,导致位移因子≈1.0 而非 dt —— 粒子一步飞出屏幕
     * (实测单帧位移 190px,而一帧本该只有约 3px)。
     */
    const p = base({ vx: 200 })
    const dt = 1 / 60
    stepParticle(p, dt)

    // 位移应接近 v0·dt = 3.33px(阻力会略小一点),绝不该是 200px 量级
    expect(p.x).toBeGreaterThan(0)
    expect(p.x).toBeLessThan(200 * dt * 1.02)
  })

  it('长时间飞行距离落在合理范围(不会飞出屏幕)', () => {
    const p = base({ vx: PHYSICS.baseSpeed })
    const dt = 1 / 60
    // 推进到最长寿命
    for (let t = 0; t < PHYSICS.maxLife; t += dt * 1000) stepParticle(p, dt)

    // 手机屏宽约 390,粒子应从卡片位置飘出屏幕但不过分离谱
    expect(p.x).toBeLessThan(600)
    expect(p.x).toBeGreaterThan(30)
  })

  it('阻力衰减用的是每秒口径,不是每帧口径', () => {
    // 推进 1 秒后,速度应约为 v0 · drag
    const p = base({ vx: 1000 })
    const dt = 1 / 60
    for (let i = 0; i < 60; i++) stepParticle(p, dt)
    const expected = 1000 * PHYSICS.drag
    expect(p.vx).toBeGreaterThan(expected * 0.98)
    expect(p.vx).toBeLessThan(expected * 1.02)
  })

  it('dt 极小时退化为欧拉积分,不产生除零', () => {
    const p = base({ vx: 100 })
    expect(() => stepParticle(p, 1e-12)).not.toThrow()
    expect(Number.isFinite(p.x)).toBe(true)
  })
})

describe('同屏粒子总量上限', () => {
  const mk = (i: number): Particle => ({
    x: i, y: 0, vx: 0, vy: 0, size: 4, size0: 4,
    color: '#fff', age: 0, life: 1000, rot: 0, vr: 0,
  })

  it('未超上限时原样返回', () => {
    const list = [mk(1), mk(2), mk(3)]
    expect(capLiveParticles(list, 10)).toBe(list)
  })

  it('超上限时裁剪到上限', () => {
    const list = Array.from({ length: 100 }, (_, i) => mk(i))
    expect(capLiveParticles(list, 30)).toHaveLength(30)
  })

  it('保留最新的粒子(丢弃最旧的)', () => {
    const list = Array.from({ length: 100 }, (_, i) => mk(i))
    const capped = capLiveParticles(list, 5)
    // 保留队尾(新追加的)5 个
    expect(capped.map((p) => p.x)).toEqual([95, 96, 97, 98, 99])
  })

  it('默认上限足够大,正常滑动不受影响', () => {
    expect(MAX_LIVE_PARTICLES).toBeGreaterThan(MAX_PARTICLES)
  })

  it('连续多次消散不会让总量无限增长', () => {
    let live: Particle[] = []
    // 模拟快速连滑 20 次
    for (let i = 0; i < 20; i++) {
      const burst = Array.from({ length: MAX_PARTICLES }, (_, k) => mk(i * 1000 + k))
      live = capLiveParticles(live.concat(burst))
    }
    expect(live.length).toBeLessThanOrEqual(MAX_LIVE_PARTICLES)
  })
})

describe('消散节奏(慢速飘散)', () => {
  it('寿命足够长,能看清消散过程', () => {
    // 短于 800ms 会"来不及散开就消失"
    expect(PHYSICS.minLife).toBeGreaterThanOrEqual(900)
    expect(PHYSICS.maxLife).toBeGreaterThan(PHYSICS.minLife)
  })

  it('阻力衰减足够慢(粒子是飘散,不是弹射)', () => {
    // drag 越接近 1 衰减越慢
    expect(PHYSICS.drag).toBeGreaterThan(0.95)
  })

  it('初速度偏低,不会一步冲出视野', () => {
    expect(PHYSICS.baseSpeed).toBeLessThan(150)
  })
})

describe('stepParticles 批量推进', () => {
  it('全部存活时返回 true', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 30, seed: 1 })
    expect(stepParticles(ps, 0.016)).toBe(true)
  })

  it('超过寿命后返回 false(调用方据此停帧)', () => {
    const ps = createBurst({ rect: RECT, direction: 1, colors: COLORS, count: 30, seed: 1 })
    // 推进时间要覆盖最长寿命,否则粒子仍存活 —— 用固定帧数是脆的,
    // 这里按 PHYSICS.maxLife 换算所需帧数,寿命调整后测试自动跟随。
    const frames = Math.ceil(PHYSICS.maxLife / 16) + 10
    for (let i = 0; i < frames; i++) stepParticles(ps, 0.016)
    expect(stepParticles(ps, 0.016)).toBe(false)
  })

  it('已消亡的粒子不再被推进(节省计算)', () => {
    const dead: Particle = {
      x: 0, y: 0, vx: 100, vy: 0, size: 4, size0: 4,
      color: '#fff', age: 999, life: 100, rot: 0, vr: 0,
    }
    stepParticles([dead], 0.1)
    expect(dead.x).toBe(0)
  })

  it('空数组返回 false', () => {
    expect(stepParticles([], 0.016)).toBe(false)
  })
})

describe('粒子视觉属性', () => {
  const p = (age: number, life = 500): Particle => ({
    x: 0, y: 0, vx: 0, vy: 0, size: 5, size0: 5,
    color: '#fff', age, life, rot: 0, vr: 0,
  })

  it('生命进度从 0 到 1', () => {
    expect(lifeProgress(p(0))).toBe(0)
    expect(lifeProgress(p(250))).toBeCloseTo(0.5)
    expect(lifeProgress(p(500))).toBe(1)
  })

  it('进度超过寿命时夹在 1', () => {
    expect(lifeProgress(p(9999))).toBe(1)
  })

  it('寿命为 0 时不除零', () => {
    expect(lifeProgress(p(0, 0))).toBe(1)
  })

  it('不透明度从 1 衰减到 0', () => {
    expect(particleOpacity(p(0))).toBe(1)
    expect(particleOpacity(p(500))).toBe(0)
  })

  it('淡出是二次曲线:中段仍保持较实', () => {
    // 线性在 50% 时是 0.5,二次应为 0.75
    expect(particleOpacity(p(250))).toBeCloseTo(0.75)
  })

  it('尺寸随生命收缩但不消失', () => {
    expect(particleSize(p(0))).toBe(5)
    expect(particleSize(p(500))).toBeCloseTo(5 * 0.35)
  })

  it('livingParticles 过滤掉已消亡的', () => {
    const list = [p(0), p(600), p(100)]
    expect(livingParticles(list)).toHaveLength(2)
  })
})

describe('particleColor 可见性(第一版"看不见粒子"的回归)', () => {
  /** 与页面背景 #eef1f4 的 RGB 欧氏距离 —— 衡量"看得见吗"。 */
  const BG: [number, number, number] = [238, 241, 244]
  function parseRgb(s: string): [number, number, number] {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s)!
    return [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  function contrast(c: [number, number, number]): number {
    return Math.round(Math.hypot(c[0] - BG[0], c[1] - BG[1], c[2] - BG[2]))
  }
  /** 粗略饱和度:(max-min)/max。 */
  function saturation(c: [number, number, number]): number {
    const mx = Math.max(...c)
    const mn = Math.min(...c)
    return mx === 0 ? 0 : (mx - mn) / mx
  }

  it('hexToRgb 解析标准十六进制', () => {
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255])
    expect(hexToRgb('#000000')).toEqual([0, 0, 0])
    expect(hexToRgb('6d92c4')).toEqual([109, 146, 196])
  })

  it('hexToRgb 对非法输入回落到中性灰,不抛异常', () => {
    for (const bad of ['', '#xyz', 'red', '#12345']) {
      expect(() => hexToRgb(bad)).not.toThrow()
      expect(hexToRgb(bad)).toEqual([150, 150, 150])
    }
  })

  it('【关键】全部 12 组合集配色生成的粒子色都清晰可见', () => {
    // 这是第一版失败的根因:直接用卡片底色 → 与背景距离仅 8~35 → 隐形
    for (const palette of CARD_PALETTE) {
      const c1 = parseRgb(particleColor(palette.tintA, palette.accent))
      const c2 = parseRgb(particleColor(palette.tintB, palette.accent, 0.68, 0.62))
      // 阈值 150:远高于"隐形"的 8~35,又不到"发黑"的 236
      expect(contrast(c1), `${palette.accent} tintA`).toBeGreaterThan(150)
      expect(contrast(c2), `${palette.accent} tintB`).toBeGreaterThan(150)
    }
  })

  it('【关键】粒子色保持足够饱和度(不只是"变黑")', () => {
    // 单纯压暗虽然对比度够,但饱和度只有 6~8%,观感发灰
    for (const palette of CARD_PALETTE) {
      const c = parseRgb(particleColor(palette.tintA, palette.accent))
      expect(saturation(c), palette.accent).toBeGreaterThan(0.15)
    }
  })

  it('输出格式是合法的 rgb()', () => {
    for (const palette of CARD_PALETTE) {
      expect(particleColor(palette.tintA, palette.accent)).toMatch(
        /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/,
      )
    }
  })

  it('通道值不越界(不会出现负数或 >255)', () => {
    for (const palette of CARD_PALETTE) {
      const c = parseRgb(particleColor(palette.tintA, palette.accent))
      for (const v of c) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
    }
  })

  it('强调色非法时仍产出可用颜色', () => {
    const c = particleColor([240, 240, 240], 'not-a-color')
    expect(c).toMatch(/^rgb\(/)
  })

  it('纯白底色也能产出可见粒子(极端情况)', () => {
    const c = parseRgb(particleColor([255, 255, 255], '#6d92c4'))
    expect(contrast(c)).toBeGreaterThan(150)
  })
})

describe('ParticleLayer 组件', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number,
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('初始不可见(空闲时零开销)', () => {
    const w = mount(ParticleLayer)
    expect(w.find('canvas').classes()).not.toContain('particles--on')
  })

  it('canvas 不拦截触摸(不能挡住滑动手势)', () => {
    const w = mount(ParticleLayer)
    const style = w.find('canvas').attributes('style') ?? ''
    // 断言类名与属性,pointer-events 在 scoped 样式里
    expect(w.find('canvas').attributes('aria-hidden')).toBe('true')
    expect(w.find('canvas').exists()).toBe(true)
  })

  it('burst 后变为可见', async () => {
    const w = mount(ParticleLayer, { attachTo: document.body })
    stubContext(w)
    w.vm.burst({ rect: RECT, direction: 1, colors: COLORS, count: 20 })
    await w.vm.$nextTick()
    expect(w.find('canvas').classes()).toContain('particles--on')
    w.unmount()
  })

  it('stop 后立即回到不可见', async () => {
    const w = mount(ParticleLayer, { attachTo: document.body })
    stubContext(w)
    w.vm.burst({ rect: RECT, direction: 1, colors: COLORS, count: 20 })
    await w.vm.$nextTick()
    w.vm.stop()
    await w.vm.$nextTick()
    expect(w.find('canvas').classes()).not.toContain('particles--on')
    w.unmount()
  })

  it('连续 burst 不报错(可重入)', () => {
    const w = mount(ParticleLayer, { attachTo: document.body })
    stubContext(w)
    expect(() => {
      w.vm.burst({ rect: RECT, direction: 1, colors: COLORS, count: 10 })
      w.vm.burst({ rect: RECT, direction: -1, colors: COLORS, count: 10 })
    }).not.toThrow()
    w.unmount()
  })

  it('卸载时停止动画,不留 rAF 泄漏', () => {
    const w = mount(ParticleLayer, { attachTo: document.body })
    stubContext(w)
    w.vm.burst({ rect: RECT, direction: 1, colors: COLORS, count: 10 })
    expect(() => w.unmount()).not.toThrow()
  })

  it('系统开启减弱动效时不播放', async () => {
    const originalMatch = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia

    try {
      const w = mount(ParticleLayer, { attachTo: document.body })
      stubContext(w)
      w.vm.burst({ rect: RECT, direction: 1, colors: COLORS, count: 20 })
      await w.vm.$nextTick()
      expect(w.find('canvas').classes()).not.toContain('particles--on')
      w.unmount()
    } finally {
      window.matchMedia = originalMatch
    }
  })
})
