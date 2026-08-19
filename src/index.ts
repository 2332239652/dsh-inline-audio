// src/index.ts
// dsh-inline-audio: 把 LLM 回复中的本地音频路径改写为同源回环 URL,
// 借 Markdown 渲染出 <img> 占位,由 client 端替换成 <audio controls> 播放器。
// 路由支持 HTTP Range(206 Partial Content),可拖动进度条。
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

export const name = 'dsh-inline-audio'
// fs 是早期服务,加入 inject 保证 apply 时可用;webServer 是可选且晚挂载的
// host 服务,不进 inject,经 ctx.inject(['webServer'], …) 延迟注册路由
// (照抄 dsh-chat-import: apply 时 ctx.get('webServer') 仍为空,硬依赖会让
// headless / 无 Web 的 profile 无法激活,且路由根本注册不上)。
export const inject = ['llm', 'fs']

const ROUTE_PATH = '/plugins/dsh-inline-audio/audio'

/** 支持的音频格式 → MIME。扩展名小写,不含点。 */
const AUDIO_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  wave: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  weba: 'audio/webm',
  mp4: 'audio/mp4',
  mid: 'audio/midi',
  midi: 'audio/midi',
}

const AUDIO_EXT_RE = /\.(wav|wave|mp3|ogg|oga|m4a|aac|flac|opus|webm|weba|mp4|mid|midi)$/i

const PLACEHOLDER_SEGMENT = /^(路径|示例|占位|本地路径|某某|xx|xxx)$/i

function mediaTypeFor(path: string): string | null {
  const lower = path.toLowerCase()
  for (const [ext, type] of Object.entries(AUDIO_TYPES)) {
    if (lower.endsWith('.' + ext)) return type
  }
  return null
}

function normalizeCandidate(raw: string): string {
  let value = raw.trim()
  value = value.replace(/^['"`\[(\s]+/, '')
  value = value.replace(/['"`]+$/, '')
  value = value.replace(/[\]}>]+$/, '')
  value = value.replace(/[;,，。、.]+$/, '')
  return value.trim()
}

function acceptable(path: string): boolean {
  if (path.length < 3) return false
  if (/^(https?:|data:|file:|mailto:)/i.test(path)) return false
  // URL 残留特征(如 s://example.com/a.mp3 从中间截断、//host/path):拒绝
  if (/:\/\/|^(\\\\|\/\/)[^\\/\s]+\.[A-Za-z]{2,}(\/|$)/.test(path)) return false
  if (!AUDIO_EXT_RE.test(path)) return false
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(path)) return false
  if (path.split(/[\\/]/).some((segment) => PLACEHOLDER_SEGMENT.test(segment))) return false
  return true
}

interface FoundRange {
  path: string
  rawStart: number
  rawEnd: number
}

function scanAudioPathRanges(text: string): FoundRange[] {
  const found: FoundRange[] = []
  const seen = new Set<string>()
  const push = (raw: string, start: number, end: number) => {
    const path = normalizeCandidate(raw)
    if (!acceptable(path)) return
    if (seen.has(path)) return
    seen.add(path)
    found.push({ path, rawStart: start, rawEnd: end })
  }
  // Markdown 图片/链接语法 ![...](path) 或 [...](path)
  const mdRe = /!?\[[^\]]*\]\(\s*([^)\s][^)]*?)\s*\)/g
  let match: RegExpExecArray | null
  while ((match = mdRe.exec(text)) !== null) {
    const inner = match[1].trim()
    const quote = inner[0]
    const path = quote === '"' || quote === "'"
      ? (inner.indexOf(quote, 1) !== -1 ? inner.slice(1, inner.indexOf(quote, 1)) : inner)
      : inner
    push(path, match.index, match.index + match[0].length)
  }
  // 裸路径:Windows 盘符 / UNC / POSIX。
  // 路径字符:非空白、非引号、非尖括号、非方括号、非全角标点、非反引号、非逗号分号。
  // 用 [^\s'"<>[\]、，。；;`]+ 表示(注意:字符类里 [ 和 ] 需转义,\s 是空白类)。
  const stopRe = /[^\s'"<>\[\]、，。；;`]+/g
  // 在文本上逐字符扫描:每处匹配 stopRe 的连续非停字符,判断它是否是路径开头
  let mm: RegExpExecArray | null
  while ((mm = stopRe.exec(text)) !== null) {
    const cand = mm[0]
    const at = mm.index
    let start = at
    let end = at + cand.length
    // 反引号包裹时把反引号纳入范围
    if (text[start - 1] === '`' && text[end] === '`') {
      start -= 1
      end += 1
    }
    const path = normalizeCandidate(text.slice(start, end))
    if (!acceptable(path)) continue
    if (seen.has(path)) continue
    seen.add(path)
    found.push({ path, rawStart: start, rawEnd: end })
  }
  return found
}

/** 解析 Range 头,返回 [start, end](含端点),无/非法 Range 时返回 null。 */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  let start: number, end: number
  if (m[1] === '') {
    // suffix: bytes=-N → 最后 N 字节
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Number(m[2])
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  end = Math.min(end, size - 1)
  return { start, end }
}

export function apply(ctx: Context) {
  const fs = ctx.get('fs') as FileSystem | undefined
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

  // 路由:webServer 晚挂载,apply 时不可用——用 ctx.inject 延迟注册
  // (照抄 dsh-chat-import: apply 时 ctx.get('webServer') 为空,路由注册不上;
  //  注册直接调 webServer.register,不包 ctx.effect)
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = (webCtx as unknown as { webServer: WebServer }).webServer
    const port = (webServer as unknown as { port?: number }).port ?? 0
    webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      async handler(req, res) {
        try {
          const raw = String(req.url ?? '')
          const at = raw.indexOf('?')
          const query: Record<string, string> = {}
          if (at !== -1) {
            for (const pair of raw.slice(at + 1).split('&')) {
              const eq = pair.indexOf('=')
              if (eq === -1) continue
              try {
                query[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
              } catch { /* ignore */ }
            }
          }
          if (query.t !== token || !query.p) {
            res.writeHead(400)
            res.end('bad request')
            return
          }
          const mediaType = mediaTypeFor(query.p)
          if (mediaType === null) {
            res.writeHead(400)
            res.end('not an audio path')
            return
          }
          const maxBytes = 200 * 1024 * 1024 // 音频上限 200MB
          const target = await fs?.resolve(query.p)
          if (target === undefined) throw new Error('fs unavailable')
          const bytes = await fs!.readBytes(target, undefined, maxBytes)
          const size = bytes.byteLength
          const range = parseRange(req.headers.range, size)
          if (range !== null) {
            const slice = bytes.subarray(range.start, range.end + 1)
            res.writeHead(206, {
              'Content-Type': mediaType,
              'Content-Length': slice.byteLength,
              'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, max-age=60',
            })
            res.end(slice)
          } else {
            res.writeHead(200, {
              'Content-Type': mediaType,
              'Content-Length': size,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, max-age=60',
            })
            res.end(bytes)
          }
        } catch {
          try {
            res.writeHead(404)
            res.end('not found')
          } catch { /* ignore */ }
        }
      },
    })
    // 在 webServer 就绪后挂 llm/stream 钩子(需要 port 生成回环 URL)
    ctx.on('llm/stream', (options: { purpose?: 'compaction' | 'session-title' } | undefined, next: () => AsyncIterable<any>) => {
      if (options?.purpose) return next()
      return rewriteStream(next, port, token, fs)
    }, { global: true, prepend: true } as never)
  })
}

async function* rewriteStream(
  next: () => AsyncIterable<any>,
  port: number,
  token: string,
  fs: FileSystem | undefined,
): AsyncIterable<any> {
  const seenPaths = new Set<string>()
  for await (const chunk of next() as any) {
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      try {
        const text = chunk.block.text
        const ranges = scanAudioPathRanges(text)
        if (ranges.length > 0 && fs !== undefined) {
          let rewritten = text
          let changed = false
          const todo: { range: FoundRange; url: string }[] = []
          for (const range of ranges) {
            if (seenPaths.has(range.path)) continue
            seenPaths.add(range.path)
            try {
              const target = await fs.resolve(range.path)
              const info = await fs.stat(target)
              if (info === undefined || info.type !== 'file') continue
            } catch {
              continue
            }
            todo.push({ range, url: 'http://127.0.0.1:' + port + ROUTE_PATH + '?t=' + token + '&p=' + encodeURIComponent(range.path) })
          }
          todo.sort((a, b) => b.range.rawStart - a.range.rawStart)
          for (const { range, url } of todo) {
            const before = rewritten
            rewritten = rewritten.slice(0, range.rawStart) + '![audio](' + url + ')' + rewritten.slice(range.rawEnd)
            if (rewritten !== before) changed = true
          }
          if (changed) {
            yield { ...chunk, block: { ...chunk.block, text: rewritten } }
            continue
          }
        }
      } catch (error) {
        console.error('[dsh-inline-audio] 音频路径改写失败:', error)
      }
    }
    yield chunk
  }
}

export default { name, inject, apply }