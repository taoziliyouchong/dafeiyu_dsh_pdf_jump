/**
 * PDF 页面渲染：pdfjs-dist 取页 + @napi-rs/canvas 出 PNG。
 *
 * 不依赖 Python；首次渲染一个文件时载入文档并缓存，文档改动（mtime/size）后自动重载。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json')).replaceAll('\\', '/')
const CMAP_URL = `${PDFJS_ROOT}/cmaps/`
const STANDARD_FONTS_URL = `${PDFJS_ROOT}/standard_fonts/`

const CACHE_DIR = join(tmpdir(), 'dsh-pdf-jump-cache')
const MAX_DOCS = 2

const docs = new Map()

class CanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)))
    return { canvas, context: canvas.getContext('2d') }
  }

  reset({ canvas }, width, height) {
    canvas.width = Math.max(1, Math.floor(width))
    canvas.height = Math.max(1, Math.floor(height))
  }

  destroy() {}
}

/**
 * 打开（或复用）一个 PDF 文档。文档句柄连同它的 loading task 一起缓存，
 * 释放时走 task.destroy()（pdfjs 6 的 PDFDocumentProxy 不再直接提供 destroy）。
 * @param {string} file PDF 绝对路径
 */
async function getDocument(file) {
  const stat = statSync(file)
  const hit = docs.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    hit.usedAt = Date.now()
    return hit.doc
  }
  if (hit) {
    docs.delete(file)
    await hit.task.destroy().catch(() => {})
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(file)),
    isEvalSupported: false,
    verbosity: 0,
    useSystemFonts: true,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS_URL,
    canvasFactory: new CanvasFactory(),
  })
  const doc = await task.promise
  docs.set(file, { doc, task, mtimeMs: stat.mtimeMs, size: stat.size, usedAt: Date.now() })
  if (docs.size > MAX_DOCS) {
    const [oldestKey] = [...docs.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]
    const oldest = docs.get(oldestKey)
    docs.delete(oldestKey)
    await oldest.task.destroy().catch(() => {})
  }
  return doc
}

/**
 * 页数。页码一律按 PDF 页序，不从页脚推断印刷页码——很多手册混用全书页码和
 * 「章-页」编号，推断出来的差值会把正文页整体错位。
 * @param {string} file PDF 绝对路径
 * @returns {Promise<{pages: number}>}
 */
export async function documentInfo(file) {
  const doc = await getDocument(file)
  return { pages: doc.numPages }
}

/**
 * 清理 7 天前的渲染缓存（只在第一次渲染时执行一次）。
 */
let pruned = false
function pruneCache() {
  if (pruned) return
  pruned = true
  try {
    const cutoff = Date.now() - 7 * 24 * 3_600_000
    for (const name of readdirSync(CACHE_DIR)) {
      const target = join(CACHE_DIR, name)
      try {
        if (statSync(target).mtimeMs < cutoff) rmSync(target, { force: true })
      } catch { /* 单个文件清理失败不影响渲染 */ }
    }
  } catch { /* 缓存目录还不存在 */ }
}

function cachePathFor(file, pdfPage, scale, ext = 'png') {
  const stat = statSync(file)
  const key = createHash('md5')
    .update(`${file}|${stat.mtimeMs}|${stat.size}|${pdfPage}|${scale}`)
    .digest('hex')
  return join(CACHE_DIR, `${key}.${ext}`)
}

/** 整本浏览用的缩略图倍率：0.8 约等于 476px 宽，列表里放大到 760px 内可辨版式。 */
export const THUMB_SCALE = 0.8

/**
 * 某页是否已经有渲染缓存（预渲染循环用它跳过已完成的页）。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序
 * @param {number} scale 渲染倍率
 * @returns {boolean}
 */
export function isPageCached(file, pdfPage, scale = 2) {
  try {
    return existsSync(cachePathFor(file, pdfPage, scale))
  } catch {
    return false
  }
}

/**
 * 直接读已渲染的页图；没有缓存返回 null（不触发渲染）。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序
 * @param {number} scale 渲染倍率
 * @returns {Buffer|null}
 */
export function readCachedPage(file, pdfPage, scale = 2) {
  try {
    const cachePath = cachePathFor(file, pdfPage, scale)
    return existsSync(cachePath) ? readFileSync(cachePath) : null
  } catch {
    return null
  }
}

/**
 * 把一页渲染成 PNG（带磁盘缓存）。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序（从 1 起）
 * @param {number} scale 渲染倍率，2 约等于 144 dpi
 * @returns {Promise<Buffer>} PNG 字节
 */
export async function renderPage(file, pdfPage, scale = 2) {
  const cachePath = cachePathFor(file, pdfPage, scale)
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  pruneCache()
  if (existsSync(cachePath)) return readFileSync(cachePath)

  const doc = await getDocument(file)
  const page = await doc.getPage(Math.max(1, Math.min(doc.numPages, pdfPage)))
  const viewport = page.getViewport({ scale })
  const factory = new CanvasFactory()
  const { canvas, context } = factory.create(viewport.width, viewport.height)
  try {
    await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise
    const png = canvas.toBuffer('image/png')
    writeFileSync(cachePath, png)
    return png
  } finally {
    factory.destroy({ canvas, context })
  }
}

/** 缩略图是否已有缓存（整本浏览用，避免重复渲染）。 */
export function isThumbCached(file, pdfPage, scale = THUMB_SCALE) {
  try {
    return existsSync(cachePathFor(file, pdfPage, scale, 'jpg'))
  } catch {
    return false
  }
}

/** 直接读已渲染的缩略图；没有缓存返回 null。 */
export function readCachedThumb(file, pdfPage, scale = THUMB_SCALE) {
  try {
    const cachePath = cachePathFor(file, pdfPage, scale, 'jpg')
    return existsSync(cachePath) ? readFileSync(cachePath) : null
  } catch {
    return null
  }
}

/**
 * 把一页渲染成整本浏览用的缩略图（JPEG，白底）。
 * 缩略图只求版式可辨，编码比全尺寸 PNG 快一个数量级。
 * @param {string} file PDF 绝对路径
 * @param {number} pdfPage PDF 页序（从 1 起）
 * @param {number} scale 倍率，默认 0.8（约 476px 宽）
 * @param {number} quality JPEG 质量，默认 0.8
 * @returns {Promise<Buffer>} JPEG 字节
 */
export async function renderThumb(file, pdfPage, scale = THUMB_SCALE, quality = 0.8) {
  const cachePath = cachePathFor(file, pdfPage, scale, 'jpg')
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  pruneCache()
  if (existsSync(cachePath)) return readFileSync(cachePath)

  const doc = await getDocument(file)
  const page = await doc.getPage(Math.max(1, Math.min(doc.numPages, pdfPage)))
  const viewport = page.getViewport({ scale })
  const factory = new CanvasFactory()
  const { canvas, context } = factory.create(viewport.width, viewport.height)
  try {
    // JPEG 没有透明通道，先铺白底，和单页查看器的白纸效果一致。
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise
    const jpg = canvas.toBuffer('image/jpeg', { quality })
    writeFileSync(cachePath, jpg)
    return jpg
  } finally {
    factory.destroy({ canvas, context })
  }
}

/** 释放所有已载入的文档（插件卸载时调用）。 */
export async function closeDocuments() {
  const all = [...docs.values()]
  docs.clear()
  await Promise.all(all.map((entry) => entry.task.destroy().catch(() => {})))
}

/** 渲染缓存目录，供文档与诊断使用。 */
export const cacheDir = CACHE_DIR
