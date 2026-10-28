/**
 * 把工具参数 file 落成一个真实存在的 PDF 路径。
 *
 * 优先按路径解析（相对路径按调用方给的工作目录）；找不到时把 file 当文件名片段，
 * 在搜索根里广度优先找（浅层优先，带数量与时间上限）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, basename, join, resolve } from 'node:path'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.pnpm', '_backup', '$RECYCLE.BIN',
  'System Volume Information', '.cache', '__pycache__',
])

/**
 * @param {string} root 搜索根
 * @param {number} limit 最多收多少个 PDF
 * @param {number} budgetMs 时间上限
 * @returns {string[]} PDF 绝对路径
 */
export function collectPdfs(root, limit = 20000, budgetMs = 8000) {
  const out = []
  const queue = [root]
  const deadline = Date.now() + budgetMs
  for (let i = 0; i < queue.length && out.length < limit; i += 1) {
    if (Date.now() > deadline) break
    let entries
    try {
      entries = readdirSync(queue[i], { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(queue[i], entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        queue.push(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        out.push(full)
        if (out.length >= limit) break
      }
    }
  }
  return out
}

/**
 * @param {string} input file 参数
 * @param {string} cwd 搜索根
 * @param {string[]} [extraRoots] 额外的搜索根
 * @returns {string} PDF 绝对路径
 */
export function resolvePdf(input, cwd, extraRoots = []) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('file 不能为空')
  const direct = resolve(cwd, raw)
  if (existsSync(direct) && statSync(direct).isFile()) return direct

  const needle = basename(raw).toLowerCase()
  const roots = [...extraRoots.filter(Boolean)]
  const envRoots = process.env.PDF_JUMP_ROOTS
  if (envRoots) roots.push(...envRoots.split(delimiter).filter(Boolean))
  roots.push(cwd)
  const seen = new Set()
  for (const root of roots) {
    const abs = resolve(root)
    if (seen.has(abs) || !existsSync(abs)) continue
    seen.add(abs)
    const hits = collectPdfs(abs)
      .filter((file) => basename(file).toLowerCase().includes(needle))
      .sort((a, b) => a.length - b.length)
    if (hits.length > 0) return hits[0]
  }
  throw new Error(`没找到 PDF：${raw}（找过：${[...seen].join(' ; ')}）`)
}
