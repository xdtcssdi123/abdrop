/**
 * 卡片消散粒子系统。
 *
 * 为什么用 canvas 而不是 DOM 元素:
 *   一次消散要上百个粒子,用 DOM 就是上百个节点参与合成 ——
 *   刚把卡片的 backdrop-filter 去掉换来 60fps,不能在这里又还回去。
 *   canvas 只占一个合成层,绘制成本与粒子数近似线性,可控得多。
 *
 * 本文件只做**物理与数据**,不碰 canvas API:
 * 因此可完整单测,也便于将来换 WebGL 后端。
 *
 * 随机数用可播种的 PRNG(mulberry32)而非 Math.random:
 * 测试需要确定性的粒子分布。
 */

/** 单个粒子。字段刻意用短名 —— 每帧要遍历上百个,减少属性查找开销。 */
export interface Particle {
  /** 位置(px,相对 canvas 左上角) */
  x: number
  y: number
  /** 速度(px/秒) */
  vx: number
  vy: number
  /** 边长(px),随时间收缩 */
  size: number
  /** 初始尺寸,用于计算收缩比例 */
  size0: number
  /** 填充色(已含 alpha 的 rgb 串) */
  color: string
  /** 已存活时长(ms) */
  age: number
  /** 总寿命(ms) */
  life: number
  /** 旋转角(rad)与角速度 */
  rot: number
  vr: number
}

/** 消散参数。 */
export interface BurstOptions {
  /** 卡片在 canvas 坐标系中的矩形 */
  rect: { x: number; y: number; width: number; height: number }
  /** 滑出方向:1 = 右, -1 = 左 */
  direction: 1 | -1
  /** 可用颜色(通常来自卡片合集配色) */
  colors: readonly string[]
  /** 粒子数;不传则按卡片面积自动推导 */
  count?: number
  /** 随机种子,便于测试复现 */
  seed?: number
}

/** 可播种的伪随机数生成器(mulberry32)。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 每 1000px² 卡片面积大约生成多少粒子 —— 让大小屏观感一致。 */
export const PARTICLES_PER_1000_PX2 = 1.35

/** 单次消散的粒子数上限。超过这个数,中低端机开始掉帧。 */
export const MAX_PARTICLES = 190

/**
 * 同屏粒子总数上限。
 *
 * 单次有上限还不够:寿命拉长后,快速连续滑动会让上一次的粒子
 * 还没消亡、下一次的又叠上来,总量迅速膨胀并拖垮帧率。
 * 超出时丢弃**最旧**的粒子(它们本来就快消亡了,视觉损失最小)。
 */
export const MAX_LIVE_PARTICLES = 460

/**
 * 把粒子总数裁剪到上限内(就地修改语义,返回新数组)。
 * 优先保留较新的粒子。
 */
export function capLiveParticles(
  particles: Particle[],
  max: number = MAX_LIVE_PARTICLES,
): Particle[] {
  if (particles.length <= max) return particles
  return particles.slice(particles.length - max)
}

/** 粒子数下限:太少就不像"消散"而像"掉了几个点"。 */
export const MIN_PARTICLES = 48

/** 按卡片面积推导合适的粒子数。 */
export function particleCountFor(width: number, height: number): number {
  const area = Math.max(0, width) * Math.max(0, height)
  const raw = Math.round((area / 1000) * PARTICLES_PER_1000_PX2)
  return Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, raw))
}

/** 物理常量。 */
export const PHYSICS = {
  /** 重力(px/秒²),让碎屑缓缓下坠,增加"实体感" */
  gravity: 150,
  /**
   * 初速度基准(px/秒):与滑动方向一致。
   *
   * 刻意偏低 —— 粒子应当"飘散"而不是"弹射"。配合较大的 drag
   * 与较长的寿命,整体是慢速、舒展的消散感。
   */
  baseSpeed: 95,
  /** 初速度随机区间(px/秒) */
  speedJitter: 110,
  /** 从卡片中心向外的扩散速度(px/秒) */
  spread: 80,
  /**
   * **每秒**的速度保留比例(注意是每秒,不是每帧)。
   *
   * 越接近 1 → 衰减越慢 → 粒子飘得越远越久。
   * 调参历程:0.86(一闪而过)→ 0.94(仍偏快)→ 0.965(采用)。
   */
  drag: 0.965,
  /**
   * 寿命区间(ms)。
   *
   * 拉长到 1.1~2.0 秒:短寿命会让粒子"来不及散开就消失",
   * 慢速飘散需要足够时间才看得出过程。
   */
  minLife: 1100,
  maxLife: 2000,
  /** 最大角速度(rad/秒) */
  maxSpin: 3.4,
} as const

/**
 * 生成一次消散的粒子(`now` 无关,纯数据)。
 *
 * 分布策略:
 *   1. 在卡片矩形内均匀撒点(带抖动,避免看出网格);
 *   2. 初速度 = 「滑动方向的主速度」+「相对卡片中心的径向扩散」;
 *   3. 越靠边缘的粒子获得更大的径向速度 —— 观感上像从中间散开。
 */
export function createBurst(options: BurstOptions): Particle[] {
  const { rect, direction, colors } = options
  const count = options.count ?? particleCountFor(rect.width, rect.height)
  const rng = createRng(options.seed ?? 1)

  // 颜色策略:主体用卡片底色,少量用强调色,层次更丰富
  const palette = colors.length ? colors : ['rgba(200, 208, 216, 0.9)']

  const cx = rect.width / 2
  const cy = rect.height / 2
  const particles: Particle[] = []

  for (let i = 0; i < count; i++) {
    // 位置:均匀撒点 + 抖动
    const x = rect.x + rng() * rect.width
    const y = rect.y + rng() * rect.height

    // 相对中心的归一化方向(用于径向扩散)
    const nx = (x - rect.x - cx) / (rect.width / 2 || 1)
    const ny = (y - rect.y - cy) / (rect.height / 2 || 1)
    const radial = Math.hypot(nx, ny) || 1

    const speed = PHYSICS.baseSpeed + rng() * PHYSICS.speedJitter
    // 主方向 + 径向扩散
    const vx = direction * speed + (nx / radial) * PHYSICS.spread * (0.5 + rng())
    const vy = (ny / radial) * PHYSICS.spread * (0.5 + rng()) - 40 * rng()

    const life = PHYSICS.minLife + rng() * (PHYSICS.maxLife - PHYSICS.minLife)
    /*
     * 尺寸与粒子数反相关:粒子多时用小颗粒,避免糊成一团。
     * 但整体较原先放大 —— 3~5px 在手机上几乎不可见。
     */
    const baseSize = count > 140 ? 5 : count > 90 ? 6.2 : 7.5
    const size = baseSize * (0.6 + rng() * 0.85)

    /*
     * 颜色选取。
     *
     * 注意:调色板前几项是卡片的**极浅底色**,与页面背景色的 RGB 距离
     * 只有 8~35 —— 直接用会导致粒子"隐形"。所以这里把底色交给
     * ParticleLayer 预先加深后再传入(见该组件 emitParticles 的注释),
     * 且强调色占比提高到约 35%,保证任何合集下都看得见。
     */
    const colorIndex = rng() < 0.35 ? palette.length - 1 : Math.floor(rng() * palette.length)

    particles.push({
      x,
      y,
      vx,
      vy,
      size,
      size0: size,
      color: palette[Math.min(colorIndex, palette.length - 1)]!,
      age: 0,
      life,
      rot: rng() * Math.PI * 2,
      vr: (rng() - 0.5) * 2 * PHYSICS.maxSpin,
    })
  }

  return particles
}

/**
 * 推进单个粒子一帧(**就地修改**,避免每帧分配上百个对象)。
 *
 * @param p  粒子
 * @param dt 时间步长(秒)
 */
export function stepParticle(p: Particle, dt: number): void {
  p.age += dt * 1000
  p.vy += PHYSICS.gravity * dt

  /*
   * 空气阻力:速度按 v(t) = v0 · drag^t 指数衰减(drag 是「每秒」保留比例)。
   *
   * 位置用**精确积分**而非显式欧拉:
   *   位移 = ∫₀^dt v0 · drag^t dt = v0 · (drag^dt − 1) / ln(drag)
   *
   * 注意分母是 ln(drag) 而不是 ln(k)(k = drag^(1/60)):
   * 二者相差 60 倍。写成 ln(k) 会让位移因子变成约 1.0 而不是 dt,
   * 表现为粒子一步就飞出屏幕 —— 曾经真的踩过这个坑(飞行距离 7080px,
   * 而屏幕只有 390px 宽),观感上就是"粒子刚出现就没了"。
   *
   * 用精确积分的目的是让**不同步长得到同一结果**,避免帧率影响观感。
   */
  const decay = Math.pow(PHYSICS.drag, dt)
  const lnDrag = Math.log(PHYSICS.drag)

  // dt 极小时 ln(drag)→0,退化为欧拉积分(此时两者等价)
  const displacementFactor =
    Math.abs(lnDrag) < 1e-9 ? dt : (decay - 1) / lnDrag

  p.x += p.vx * displacementFactor
  p.y += p.vy * displacementFactor

  p.vx *= decay
  p.vy *= decay
  p.rot += p.vr * dt
}

/**
 * 批量推进(就地修改)。
 * @returns 是否有粒子仍然存活 —— 调用方据此决定是否继续 rAF。
 */
export function stepParticles(particles: Particle[], dt: number): boolean {
  let alive = false
  for (const p of particles) {
    if (p.age >= p.life) continue
    stepParticle(p, dt)
    if (p.age < p.life) alive = true
  }
  return alive
}

/** 十六进制色转 RGB 三元组。非法输入回落到中性灰(不抛异常)。 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim())
  if (!m) return [150, 150, 150]
  const n = Number.parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * 把极浅的卡片底色转成"看得见的粒子色"。
 *
 * 两个必须同时满足的条件(实测调出来的):
 *   1. **与背景有足够对比** —— 卡片底色与页面背景的 RGB 距离仅 8~35,
 *      直接拿来画粒子等于隐形(第一版就是这样,完全看不到效果);
 *   2. **保持饱和度** —— 单纯压暗虽然对比度够(距离约 180),但饱和度
 *      只有 6~8%,粒子发灰,失去"这张卡碎开了"的辨识度。
 *
 * 做法:先向合集的强调色混合(补回色相与饱和度),再整体压暗。
 * 实测参数组合(对比度 / 饱和度):
 *   mix 0.45 / darken 0.82 → 140 / 20%  (偏淡,真机上不够醒目)
 *   mix 0.62 / darken 0.70 → 198 / 24%  ← 采用
 *   mix 0.75 / darken 0.62 → 236 / 29%  (接近发黑,失去观感)
 *
 * 同时把强调色占比提到约 35%,保证任何合集下粒子都看得见。
 *
 * @param rgb     卡片底色
 * @param accent  该合集的强调色(十六进制)
 * @param mix     向强调色混合的比例
 * @param darken  最终的压暗系数
 */
export function particleColor(
  rgb: readonly [number, number, number],
  accent: string,
  mix = 0.62,
  darken = 0.7,
): string {
  const a = hexToRgb(accent)
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  const ch = [0, 1, 2].map((i) => clamp((rgb[i]! + (a[i]! - rgb[i]!) * mix) * darken))
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`
}

/** 粒子当前的生命进度 0(刚生成)→1(消亡)。 */
export function lifeProgress(p: Particle): number {
  if (p.life <= 0) return 1
  return Math.min(p.age / p.life, 1)
}

/**
 * 当前不透明度。
 *
 * 用二次曲线而非线性:前段保持较实,尾段快速淡出 ——
 * 线性淡出会让粒子在中段就显得"灰蒙蒙"。
 */
export function particleOpacity(p: Particle): number {
  const t = lifeProgress(p)
  const fade = 1 - t * t
  return Math.max(0, fade)
}

/** 当前尺寸(随生命收缩到初值的 35%)。 */
export function particleSize(p: Particle): number {
  const t = lifeProgress(p)
  return p.size0 * (1 - t * 0.65)
}

/** 过滤出仍然存活的粒子(渲染前调用,避免画已消亡的)。 */
export function livingParticles(particles: Particle[]): Particle[] {
  return particles.filter((p) => p.age < p.life)
}
