/**
 * 类型：工具；解决：资料手册的「印刷页码」与 PDF 页序对不上、侧栏 iframe 又不能直接显示 PDF；
 * 作用：本地渲染指定印刷页并给出带翻页工具栏的网页地址（有 sidebar_open 就开在侧栏，没有就用浏览器）。
 *
 * 不 import 任何 DSH 包：工具定义按 ctx.tools.register 的形状直接写，换 DSH 版本不受影响。
 */

import { basename, resolve } from 'node:path'

import { resolvePdf } from './lib/resolve.mjs'
import { createViewer, registerFile } from './lib/server.mjs'

/** Cordis 插件名。 */
export const name = 'dsh-pdf-jump'
/** 需要的服务：工具注册表 + 系统提示（让模型知道什么时候该用它）。 */
export const inject = ['tools', 'systemPrompt']

/**
 * 每轮都在模型上下文里的使用说明。工具描述只在工具列表里出现一次，
 * 这段公告把「什么时候用 / 什么时候不用」说清楚，保证模型选得对。
 */
const GUIDANCE = [
  '本机装了 dsh-pdf-jump（在侧栏里看 PDF，两个独立入口）：',
  '- 用户只说「打开/看一眼某本 PDF」时，用 pdf-open：直接调侧栏的原生 PDF 预览，不生成图片，最快。',
  '- 用户要「打开某本 PDF／手册的第 N 页」「在侧栏一页页翻」「整本浏览」时，用 pdf-view。page 是 PDF 页序（从 1 开始），不看页脚印的印刷页码。',
  '- 用户要提取 PDF 文字、读元数据或比较字体时，用 dsh-pdf 的 pdf_info / pdf_extract_text，不要用这两个工具。',
  '- 不要绕过这两个工具自己用 sidebar_open 打开 PDF 文件：那样没有跳页、没有整本浏览；pdf-open 返回的路径再交给 sidebar_open 才是正确顺序。',
  '- 两个工具都返回本机路径或本地 url：有 sidebar_open 就先调它开在侧栏；不要把裸路径/裸 url 贴给用户，用「📄 文件名」做链接文字。',
  '- 只给了文件名片段、不知道路径时直接传进去：先按会话工作目录找，再按片段搜。',
  '- 用户说「点了链接没反应 / 打不开」时，说明是侧栏浏览器默认拦截本机地址：建议把「网页链接默认打开方式」改成默认浏览器，或把 127.0.0.1:<端口> 加进侧栏设置里的本机地址白名单。',
  '- 旧对话里的 url 在服务空闲退出后会失效，不要复用；每次重新调用取新地址。',
].join('\n')

const parameters = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'PDF 绝对/相对路径，或文件名片段（如 "VFD-EL-W 手册"）' },
    page: { type: 'number', description: 'PDF 页序（从 1 开始），不是页脚印的印刷页码' },
    cwd: { type: 'string', description: '搜索根目录；默认用当前会话的工作目录' },
  },
  required: ['file', 'page'],
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      url: { type: 'string' },
      file: { type: 'string' },
      page: { type: 'number' },
    },
    required: ['ok', 'url', 'file', 'page'],
  },
  render: (_args, value) => [{
    type: 'text',
    text: `[📄 ${basename(value.file)} · 第 ${value.page} 页](<${value.url}>)`,
  }],
}

/** 当前会话的工作目录；取不到时退回进程目录。 */
function sessionCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get?.('workingDirectory')
    const session = exec?.agent?.session
    if (workingDirectory && session) return workingDirectory.get(session)
  } catch { /* 老版本没有这个服务，用进程目录 */ }
  return process.cwd()
}

export function apply(ctx, config = {}) {
  const viewer = createViewer({
    port: config.port,
    scale: config.scale,
    idleMinutes: config.idleMinutes,
    prefetch: config.prefetch,
    prefetchWindow: config.prefetchWindow,
  })
  const extraRoots = Array.isArray(config.roots) ? config.roots.map(String) : []

  let starting = null
  const ensureViewer = () => {
    // start() 自己会复用已在跑的服务；服务因空闲退出后再次调用会重新拉起。
    if (!starting) starting = viewer.start().finally(() => { starting = null })
    return starting
  }

  ctx.effect(() => () => { viewer.stop().catch(() => {}) })

  // 插件加载就把服务起起来。DSH 重启后还是同一个默认端口、同一份路径注册表，
  // 旧对话里的 /v、/d 链接可以直接重新打开；端口被占用时工具调用会再试。
  viewer.start().catch(() => {})

  const hasTool = (name) => {
    try {
      return typeof ctx.tools.get === 'function' && ctx.tools.get(name) !== undefined
    } catch {
      return false
    }
  }

  if (!hasTool('pdf-view')) {
    try {
      ctx.tools.register({
        name: 'pdf-view',
        description:
          '在侧栏里翻看本地 PDF——跳页阅读、翻手册、整本浏览时用它；'
          + '只想打开看一眼请用 pdf-open（原生预览，更快）；要提取文字或元数据用 dsh-pdf 的 pdf_info / pdf_extract_text。'
          + '本地服务把该页渲染成图，返回带「上一页/下一页/跳页码/整本浏览」的侧栏网页地址。'
          + 'file 给 PDF 路径或文件名片段（相对路径按会话工作目录解析），page 给 PDF 页序（从 1 开始，不从页脚推断印刷页码）。'
          + '返回 url：有 sidebar_open 就交给它打开；不要把裸 url 贴给用户。首次调用自动拉起本地服务（只绑 127.0.0.1）。',
        parameters,
        output,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = args.cwd ? resolve(String(args.cwd)) : sessionCwd(ctx, exec)
          const pdf = resolvePdf(args.file, cwd, extraRoots)
          const port = await ensureViewer()
          const page = Math.max(1, Math.round(Number(args.page) || 1))
          const id = registerFile(pdf)
          // 工具一返回就在后台把这一页和附近几页渲进缓存，用户点开时直接取图。
          if (config.prefetch !== false) viewer.prefetch(pdf, page)
          const url = `http://127.0.0.1:${port}/v/${id}/${page}`
          return { ok: true, url, file: pdf, page }
        },
      })
    } catch (err) {
      console.warn(`[dsh-pdf-jump] 未注册 pdf-view：${err.message}`)
    }
  }

  // 常驻说明：描述两个工具的分工；没有 systemPrompt 服务时静默跳过。
  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(
      () => systemPrompt.section({ name: 'plugin:dsh-pdf-jump', order: 161, text: GUIDANCE }),
      'dsh-pdf-jump: guidance',
    )
  }

  // 命令层：完全不经过模型判断，用户输入 /pdf 就一定走这两个工具。
  try {
    const commands = ctx.commands ?? ctx.get?.('commands')
    if (commands && typeof commands.register === 'function') {
      commands.register({
        name: 'pdf',
        description: '在侧栏打开 PDF（参数：<路径或文件名片段> [页码]）；带页码走 pdf-view 可跳页/整本，不带页码走原生预览',
        input: { hint: '<PDF 路径或文件名片段> [页码]' },
        handler: async ({ rawInput }) => {
          try {
            const raw = String(rawInput ?? '').trim()
            if (!raw) return { kind: 'error', text: '用法：/pdf <PDF 路径或文件名片段> [页码]' }
            const matched = raw.match(/^(.*?)\s+(\d+)$/)
            const target = matched ? matched[1].trim() : raw
            const page = matched ? Math.max(1, Math.round(Number(matched[2]))) : 0
            const pdf = resolvePdf(target, process.cwd(), extraRoots)
            if (!page) return { kind: 'success', text: `[📄 ${basename(pdf)}](<${pdf}>)` }
            const port = await ensureViewer()
            const id = registerFile(pdf)
            if (config.prefetch !== false) viewer.prefetch(pdf, page)
            return { kind: 'success', text: `[📄 ${basename(pdf)} · 第 ${page} 页](<http://127.0.0.1:${port}/v/${id}/${page}>)` }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      })
    }
  } catch (err) {
    console.warn(`[dsh-pdf-jump] 未注册 /pdf 命令：${err.message}`)
  }
}
