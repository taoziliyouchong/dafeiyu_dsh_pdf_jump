/**
 * 本机冒烟测试：起服务，跑一遍四条路由——单页 HTML、页图、缩略图、整本页。
 *
 * 用法：node scripts/smoke.mjs <pdf 路径> [PDF 页序]
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { createViewer, registerFile } from '../lib/server.mjs'

const file = resolve(process.argv[2] ?? '')
const page = Number(process.argv[3] ?? 1) || 1

if (!existsSync(file) || statSync(file).isDirectory()) {
  console.error('用法：node scripts/smoke.mjs <pdf 路径> [PDF 页序]')
  process.exit(2)
}

const viewer = createViewer({ port: 8781, idleMinutes: 1, prefetch: false })
try {
  const port = await viewer.start()
  const base = `http://127.0.0.1:${port}`
  const id = registerFile(file)

  const t0 = performance.now()
  const view = await fetch(`${base}/v/${id}/${page}`)
  const html = await view.text()
  const viewMs = Math.round(performance.now() - t0)
  if (!view.ok) throw new Error(`/v 返回 ${view.status}`)
  const total = /共 (\d+) 页/.exec(html)?.[1] ?? '?'

  const t1 = performance.now()
  const png = await fetch(`${base}/p/${id}/${page}.png`)
  const pngBytes = new Uint8Array(await png.arrayBuffer())
  const pngMs = Math.round(performance.now() - t1)
  if (!png.ok || pngBytes.length < 1000) throw new Error(`/p 返回 ${png.status}，${pngBytes.length} 字节`)

  const t2 = performance.now()
  const thumb = await fetch(`${base}/t/${id}/${page}.jpg`)
  const thumbBytes = new Uint8Array(await thumb.arrayBuffer())
  const thumbMs = Math.round(performance.now() - t2)
  const isJpeg = thumbBytes[0] === 0xff && thumbBytes[1] === 0xd8
  if (!thumb.ok || !isJpeg) throw new Error(`/t 返回 ${thumb.status}，不是 JPEG`)

  const t3 = performance.now()
  const doc = await fetch(`${base}/d/${id}`)
  const docHtml = await doc.text()
  const docMs = Math.round(performance.now() - t3)
  const anchors = (docHtml.match(/id="p\d+"/g) || []).length
  if (!doc.ok || anchors === 0) throw new Error('/d 没有页锚点')

  console.log(`viewer ok   http://127.0.0.1:${port}`)
  console.log(`pages       ${total}；整本页锚点 ${anchors}`)
  console.log(`page html   ${viewMs} ms`)
  console.log(`page png    ${pngMs} ms，${pngBytes.length} 字节`)
  console.log(`thumbnail   ${thumbMs} ms，${thumbBytes.length} 字节（JPEG）`)
  console.log(`document    ${docMs} ms，${docHtml.length} 字节`)
} finally {
  await viewer.stop()
}
