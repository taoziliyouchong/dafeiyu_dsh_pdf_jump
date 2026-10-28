/**
 * 类型：工具；解决：只想「打开看一眼」PDF 时不应走图片渲染；作用：返回本地 PDF 路径，
 * 交给 sidebar_open 用 DSH 原生 PDF 预览打开（客户端渲染，最快）。
 */

import { basename, resolve } from 'node:path'

import { resolvePdf } from './lib/resolve.mjs'

/** Cordis 插件名。 */
export const name = 'dsh-pdf-jump-native'
/** 需要的服务：工具注册表。 */
export const inject = ['tools']

const parameters = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'PDF 绝对/相对路径，或文件名片段（如 "VFD-EL-W 手册"）' },
    cwd: { type: 'string', description: '搜索根目录；默认用当前会话的工作目录' },
  },
  required: ['file'],
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      file: { type: 'string' },
    },
    required: ['ok', 'file'],
  },
  render: (_args, value) => [{
    type: 'text',
    text: `[📄 ${basename(value.file)}](<${value.file}>)`,
  }],
}

function sessionCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get?.('workingDirectory')
    const session = exec?.agent?.session
    if (workingDirectory && session) return workingDirectory.get(session)
  } catch { /* 老版本没有这个服务，用进程目录 */ }
  return process.cwd()
}

export function apply(ctx, config = {}) {
  const extraRoots = Array.isArray(config.roots) ? config.roots.map(String) : []
  try {
    if (typeof ctx.tools.get === 'function' && ctx.tools.get('pdf-open')) return
  } catch { /* 老版本没有 get()，交给 register 的重名错误兜底 */ }

  try {
    ctx.tools.register({
      name: 'pdf-open',
      description:
        '在侧栏用 DSH 原生的 PDF 预览打开本地 PDF——客户端直接渲染，不生成图片、不起本地服务，是最快的打开方式；'
        + '要按页码跳页、整本图片浏览时用 pdf-view。'
        + '打开 PDF 文件先过这个工具（或 pdf-view），不要自己拼 sidebar_open 路径——这里还要解析文件名片段和会话工作目录。'
        + 'file 给 PDF 路径或文件名片段（相对路径按会话工作目录解析）。返回文件路径，交给 sidebar_open 打开。',
      parameters,
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = args.cwd ? resolve(String(args.cwd)) : sessionCwd(ctx, exec)
        const pdf = resolvePdf(args.file, cwd, extraRoots)
        return { ok: true, file: pdf }
      },
    })
  } catch (err) {
    console.warn(`[dsh-pdf-jump-native] 未注册 pdf-open：${err.message}`)
  }
}
