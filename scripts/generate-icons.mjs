/**
 * 生成 PWA / 移动端所需的 PNG 图标。
 *
 * 为什么需要:Chrome 的「添加到主屏幕 / 安装」硬性要求 **192px 与 512px 的 PNG**
 * 图标,maskable 图标还要求内容落在安全区内。只有 SVG 时 Chrome 不会给出安装提示。
 *
 * 为什么自己画:本机没有 sharp / imagemagick / cwebp,为一个图标引入重型
 * 依赖不划算。PNG 的最小实现只需要 zlib(内置)加一段 CRC32 —— 短小、
 * 确定、可测试,而且改配色不用重装工具链。
 *
 * 用法:node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public')

// ══════════════════════════════════════════════════════════════
// PNG 编码(最小实现)
// ══════════════════════════════════════════════════════════════

/** CRC32 查表 —— PNG 每个 chunk 都要求。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 把 RGBA 像素缓冲编码成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须是 width*height*4
 */
export function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`像素数据长度不符:期望 ${width * height * 4},实际 ${rgba.length}`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // 每条扫描线前加一个 filter 字节(0 = None)
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ══════════════════════════════════════════════════════════════
// 图形:与 favicon.svg 同一套卡片堆叠母题
// ══════════════════════════════════════════════════════════════

/** 设计稿坐标系(与 favicon.svg 一致的 64×64)。 */
const ART = 64

/** 颜色(与 App 配色一致)。 */
const COLOR = {
  // 背景比 App 内的浅灰略深一档:图标需要在任意壁纸上都能浮出来
  bg: [223, 229, 235],
  cardTop: [255, 255, 255],
  cardBottom: [233, 238, 242],
  // 后两层描边压深,保证三张卡的层次在小尺寸下仍可分辨
  strokeSoft: [157, 170, 184],
  strokeHard: [104, 118, 134],
  // 强调色直接用 App 的 pass 绿,并加粗
  accent: [47, 176, 111],
  // 正文线:原来太淡,小尺寸会消失
  line: [168, 179, 192],
}

/** 旋转矩形内部判定。 */
function insideRotRect(x, y, cx, cy, hw, hh, r, angleDeg) {
  const a = (-angleDeg * Math.PI) / 180
  const dx = x - cx
  const dy = y - cy
  const rx = dx * Math.cos(a) - dy * Math.sin(a)
  const ry = dx * Math.sin(a) + dy * Math.cos(a)
  const qx = Math.abs(rx) - (hw - r)
  const qy = Math.abs(ry) - (hh - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - r <= 0
}

/**
 * 判断某点落在哪一层,返回该层的填充色。
 *
 * **必须从顶层往后层判断**:先判后层会让后层"盖住"顶层的进度线与正文线
 * (早期版本正是如此,导致绿色进度条被后层吃掉、完全不可见)。
 */
function artColorAt(x, y) {
  // 顶层(最前):略小并下移,让后面两层露出来形成层次
  if (insideRotRect(x, y, 24, 40, 15.5, 19.5, 5.5, 0)) {
    // 边框
    if (onStroke(x, y, 24, 40, 15.5, 19.5, 5.5, 0, 3)) return COLOR.strokeHard
    // 记忆强度进度线
    if (insideRotRect(x, y, 24, 30.5, 9.5, 2.2, 2.2, 0)) return COLOR.accent
    // 三条正文线
    if (insideRotRect(x, y, 22.5, 39, 8, 1.9, 1.9, 0)) return COLOR.line
    if (insideRotRect(x, y, 23.5, 46.5, 9, 1.9, 1.9, 0)) return COLOR.line
    if (insideRotRect(x, y, 20, 54, 5.5, 1.9, 1.9, 0)) return COLOR.line
    return mix(COLOR.cardTop, COLOR.cardBottom, (y - 20) / 40)
  }
  // 中层
  if (insideRotRect(x, y, 31, 34, 16.5, 20.5, 6, -4)) {
    if (onStroke(x, y, 31, 34, 16.5, 20.5, 6, -4, 2.6)) return COLOR.strokeSoft
    return mix(COLOR.cardTop, COLOR.cardBottom, (y - 14) / 42)
  }
  // 后层(最后)
  if (insideRotRect(x, y, 39, 28, 16.5, 20.5, 6, 8)) {
    if (onStroke(x, y, 39, 28, 16.5, 20.5, 6, 8, 2.6)) return COLOR.strokeSoft
    return mix(COLOR.cardTop, COLOR.cardBottom, (y - 10) / 42)
  }
  return null
}

/** 是否落在矩形描边带上(通过在内外各判一次实现)。 */
function onStroke(x, y, cx, cy, hw, hh, r, angle, width) {
  const outer = insideRotRect(x, y, cx, cy, hw, hh, r, angle)
  if (!outer) return false
  const inner = insideRotRect(x, y, cx, cy, hw - width, hh - width, Math.max(r - width, 0), angle)
  return !inner
}

function mix(a, b, t) {
  const k = Math.min(Math.max(t, 0), 1)
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

/**
 * 渲染图标。
 *
 * @param {number} size 边长(px)
 * @param {number} contentScale 内容缩放。maskable 图标需留安全边距,
 *                              Chrome 会把图标裁成圆形/水滴形,内容必须
 *                             落在中心 80% 半径内。
 * @param {number} samples 每个像素的采样数(抗锯齿)
 */
export function renderIcon(size, contentScale = 1, samples = 4) {
  const rgba = Buffer.alloc(size * size * 4)
  const step = 1 / samples
  const offset = step / 2

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let covered = 0

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          // 归一化到 [0,1),再映射到设计稿坐标
          const ux = (px + offset + sx * step) / size
          const uy = (py + offset + sy * step) / size
          // 内容缩放:围绕中心收缩
          const ax = ((ux - 0.5) / contentScale + 0.5) * ART
          const ay = ((uy - 0.5) / contentScale + 0.5) * ART

          const color = artColorAt(ax, ay) ?? COLOR.bg
          r += color[0]
          g += color[1]
          b += color[2]
          covered++
        }
      }

      const i = (py * size + px) * 4
      rgba[i] = Math.round(r / covered)
      rgba[i + 1] = Math.round(g / covered)
      rgba[i + 2] = Math.round(b / covered)
      rgba[i + 3] = 255
    }
  }

  return rgba
}

// ══════════════════════════════════════════════════════════════
// 入口
// ══════════════════════════════════════════════════════════════

/** 需要产出的图标清单。 */
export const ICON_TARGETS = [
  // Chrome 安装提示要求 192 与 512
  { file: 'icon-192.png', size: 192, contentScale: 0.92 },
  { file: 'icon-512.png', size: 512, contentScale: 0.92 },
  // maskable:内容需落在安全区内,留更大边距
  { file: 'icon-maskable-192.png', size: 192, contentScale: 0.68 },
  { file: 'icon-maskable-512.png', size: 512, contentScale: 0.68 },
  // iOS 添加到主屏用
  { file: 'apple-touch-icon.png', size: 180, contentScale: 0.92 },
]

function main() {
  mkdirSync(outDir, { recursive: true })
  for (const target of ICON_TARGETS) {
    const rgba = renderIcon(target.size, target.contentScale)
    const png = encodePNG(target.size, target.size, rgba)
    writeFileSync(resolve(outDir, target.file), png)
    console.log(`[icons] ${target.file}  ${target.size}×${target.size}  ${png.length} B`)
  }
}

// 仅在直接执行时运行(被 import 时不触发)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
