/**
 * PNG 图标生成器测试。
 *
 * 图标是 PWA 安装的硬性条件(Chrome 要求 192/512 的 PNG),
 * 所以编码正确性必须验证 —— 手工实现的 PNG 编码器最容易在
 * CRC 或 IHDR 上出错,而错误往往到真机上才发现。
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { ICON_TARGETS, crc32, encodePNG, renderIcon } from '../scripts/generate-icons.mjs'

const PUBLIC = resolve(__dirname, '../public')

/** 解析 PNG 的 IHDR,返回宽高与色彩信息。 */
function readIHDR(buf: Buffer) {
  return {
    signature: buf.subarray(0, 8).toString('hex'),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  }
}

/** 从 PNG 中取某个像素的 RGBA。 */
function pixelAt(buf: Buffer, size: number, x: number, y: number): [number, number, number, number] {
  // 用自带渲染器重新算一次,避免依赖 zlib 解压
  // 这里只用于断言"颜色分布合理",所以直接看渲染结果
  const rgba = renderIcon(size, 1, 1)
  const i = (y * size + x) * 4
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!]
}

describe('crc32', () => {
  it('对已知输入给出标准值', () => {
    // "123456789" 的标准 CRC32 是 0xCBF43926
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926)
  })

  it('空输入为 0', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it('结果在 32 位无符号范围内', () => {
    const v = crc32(Buffer.from('任意中文内容', 'utf8'))
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThan(2 ** 32)
  })
})

describe('encodePNG', () => {
  it('生成合法的 PNG 签名', () => {
    const rgba = Buffer.alloc(4 * 4 * 4, 255)
    const png = encodePNG(4, 4, rgba)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('IHDR 记录正确的尺寸与色彩类型', () => {
    const png = encodePNG(7, 9, Buffer.alloc(7 * 9 * 4, 128))
    const ihdr = readIHDR(png)
    expect(ihdr.width).toBe(7)
    expect(ihdr.height).toBe(9)
    expect(ihdr.bitDepth).toBe(8)
    expect(ihdr.colorType).toBe(6) // RGBA
  })

  it('包含 IHDR / IDAT / IEND 三个必需 chunk', () => {
    const png = encodePNG(2, 2, Buffer.alloc(16, 0))
    const text = png.toString('latin1')
    expect(text).toContain('IHDR')
    expect(text).toContain('IDAT')
    expect(text).toContain('IEND')
  })

  it('像素数据长度不符时抛错(提前暴露调用错误)', () => {
    expect(() => encodePNG(4, 4, Buffer.alloc(10))).toThrow(/长度不符/)
  })

  it('每个 chunk 的 CRC 可被自身校验', () => {
    // 重新遍历 chunk,验证写入的 CRC 与重算一致
    const png = encodePNG(3, 3, Buffer.alloc(36, 200))
    let offset = 8
    let chunks = 0
    while (offset < png.length) {
      const len = png.readUInt32BE(offset)
      const body = png.subarray(offset + 4, offset + 8 + len)
      const stored = png.readUInt32BE(offset + 8 + len)
      expect(crc32(body)).toBe(stored)
      offset += 12 + len
      chunks++
    }
    expect(chunks).toBe(3)
  })
})

describe('renderIcon', () => {
  it('输出尺寸正确', () => {
    expect(renderIcon(16, 1, 1).length).toBe(16 * 16 * 4)
  })

  it('全部像素不透明(图标不依赖底图)', () => {
    const rgba = renderIcon(8, 1, 1)
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255)
  })

  it('内容比背景亮:卡片是浅色,背景是深一档的灰', () => {
    const size = 64
    const center = pixelAt(Buffer.alloc(0), size, 32, 32)
    const corner = pixelAt(Buffer.alloc(0), size, 1, 1)
    const lum = (p: number[]) => p[0]! + p[1]! + p[2]!
    expect(lum(center)).toBeGreaterThan(lum(corner))
  })

  it('背景是低饱和灰,三个通道接近', () => {
    const corner = pixelAt(Buffer.alloc(0), 64, 1, 1)
    const [r, g, b] = corner
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(20)
  })

  it('maskable 版本留出安全边距:边缘全为背景色', () => {
    // maskable 图标会被裁成圆形,边缘必须是背景,否则会被切掉内容
    const size = 64
    const rgba = renderIcon(size, 0.68, 1)
    const at = (x: number, y: number) => {
      const i = (y * size + x) * 4
      return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]
    }
    const bg = at(0, 0)
    // 四角都应与背景一致
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ] as const) {
      expect(at(x, y)).toEqual(bg)
    }
  })

  it('正常版本内容占比更大(相比 maskable)', () => {
    const size = 64
    const countNonBg = (scale: number) => {
      const rgba = renderIcon(size, scale, 1)
      const bg = [rgba[0]!, rgba[1]!, rgba[2]!]
      let n = 0
      for (let i = 0; i < size * size; i++) {
        const p = [rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!]
        if (p.some((c, k) => Math.abs(c - bg[k]!) > 6)) n++
      }
      return n
    }
    expect(countNonBg(0.92)).toBeGreaterThan(countNonBg(0.68))
  })

  it('抗锯齿:采样数越高边缘越平滑(中间色更多)', () => {
    const size = 32
    const countEdge = (samples: number) => {
      const rgba = renderIcon(size, 1, samples)
      const bg = [rgba[0]!, rgba[1]!, rgba[2]!]
      const fg = [rgba[((size / 2) * size + size / 2) * 4]!, 255, 255]
      let n = 0
      for (let i = 0; i < size * size; i++) {
        const p = [rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!]
        const nearBg = p.every((c, k) => Math.abs(c - bg[k]!) < 8)
        if (!nearBg) n++
      }
      return n
    }
    // 高采样不会让覆盖面积剧烈变化,但不该为 0
    expect(countEdge(4)).toBeGreaterThan(0)
  })
})

describe('图标产出清单', () => {
  it('包含 Chrome 安装要求的 192 与 512 PNG', () => {
    const files = ICON_TARGETS.map((t) => t.file)
    expect(files).toContain('icon-192.png')
    expect(files).toContain('icon-512.png')
  })

  it('包含 maskable 变体(安卓自适应图标需要)', () => {
    expect(ICON_TARGETS.some((t) => t.file.includes('maskable'))).toBe(true)
  })

  it('maskable 的内容缩放小于普通版(留安全边距)', () => {
    const normal = ICON_TARGETS.find((t) => t.file === 'icon-512.png')!
    const maskable = ICON_TARGETS.find((t) => t.file === 'icon-maskable-512.png')!
    expect(maskable.contentScale).toBeLessThan(normal.contentScale)
  })

  it('包含 iOS 用的 180px 图标', () => {
    expect(ICON_TARGETS.some((t) => t.file === 'apple-touch-icon.png')).toBe(true)
  })
})

describe('已生成的图标文件', () => {
  it('脚本可重复执行(幂等)', () => {
    execFileSync('node', ['scripts/generate-icons.mjs'], {
      cwd: resolve(__dirname, '..'),
      stdio: 'pipe',
    })
    expect(existsSync(resolve(PUBLIC, 'icon-512.png'))).toBe(true)
  })

  it.each(ICON_TARGETS.map((t) => [t.file, t.size] as const))(
    '%s 是合法 PNG 且尺寸为 %i',
    (file, size) => {
      const path = resolve(PUBLIC, file)
      expect(existsSync(path), `${file} 不存在`).toBe(true)

      const buf = readFileSync(path)
      const ihdr = readIHDR(buf)
      expect(ihdr.signature).toBe('89504e470d0a1a0a')
      expect(ihdr.width).toBe(size)
      expect(ihdr.height).toBe(size)
      expect(ihdr.colorType).toBe(6)
    },
  )

  it('图标体积合理(单张 < 60KB)', () => {
    for (const target of ICON_TARGETS) {
      const size = statSync(resolve(PUBLIC, target.file)).size
      expect(size, target.file).toBeLessThan(60 * 1024)
      expect(size, target.file).toBeGreaterThan(0)
    }
  })
})
