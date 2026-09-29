/**
 * 把 sql.js 的 wasm 从 node_modules 同步到 public/。
 *
 * 为什么需要:ABDrop 要求全程离线可用,不能依赖 CDN 拉 wasm。
 * 由 package.json 的 postinstall 钩子自动执行,保证产物始终一致。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules/sql.js/dist/sql-wasm.wasm')
const dest = resolve(root, 'public/sql-wasm.wasm')

if (!existsSync(src)) {
  console.warn('[copy-sql-wasm] 未找到 sql.js wasm,跳过(请先安装依赖)')
  process.exit(0)
}

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`[copy-sql-wasm] 已同步 → public/sql-wasm.wasm`)
