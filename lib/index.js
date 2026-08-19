// src/index.ts
var name = "dsh-inline-audio";
var inject = ["llm", "fs"];
var ROUTE_PATH = "/plugins/dsh-inline-audio/audio";
var AUDIO_TYPES = {
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  webm: "audio/webm",
  weba: "audio/webm",
  mp4: "audio/mp4",
  mid: "audio/midi",
  midi: "audio/midi"
};
var AUDIO_EXT_RE = /\.(wav|wave|mp3|ogg|oga|m4a|aac|flac|opus|webm|weba|mp4|mid|midi)$/i;
var PLACEHOLDER_SEGMENT = /^(路径|示例|占位|本地路径|某某|xx|xxx)$/i;
function mediaTypeFor(path) {
  const lower = path.toLowerCase();
  for (const [ext, type] of Object.entries(AUDIO_TYPES)) {
    if (lower.endsWith("." + ext)) return type;
  }
  return null;
}
function normalizeCandidate(raw) {
  let value = raw.trim();
  value = value.replace(/^['"`\[(\s]+/, "");
  value = value.replace(/['"`]+$/, "");
  value = value.replace(/[\]}>]+$/, "");
  value = value.replace(/[;,，。、.]+$/, "");
  return value.trim();
}
function acceptable(path) {
  if (path.length < 3) return false;
  if (/^(https?:|data:|file:|mailto:)/i.test(path)) return false;
  if (/:\/\/|^(\\\\|\/\/)[^\\/\s]+\.[A-Za-z]{2,}(\/|$)/.test(path)) return false;
  if (!AUDIO_EXT_RE.test(path)) return false;
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(path)) return false;
  if (path.split(/[\\/]/).some((segment) => PLACEHOLDER_SEGMENT.test(segment))) return false;
  return true;
}
function scanAudioPathRanges(text) {
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (raw, start, end) => {
    const path = normalizeCandidate(raw);
    if (!acceptable(path)) return;
    if (seen.has(path)) return;
    seen.add(path);
    found.push({ path, rawStart: start, rawEnd: end });
  };
  const mdRe = /!?\[[^\]]*\]\(\s*([^)\s][^)]*?)\s*\)/g;
  let match;
  while ((match = mdRe.exec(text)) !== null) {
    const inner = match[1].trim();
    const quote = inner[0];
    const path = quote === '"' || quote === "'" ? inner.indexOf(quote, 1) !== -1 ? inner.slice(1, inner.indexOf(quote, 1)) : inner : inner;
    push(path, match.index, match.index + match[0].length);
  }
  const stopRe = /[^\s'"<>\[\]、，。；;`]+/g;
  let mm;
  while ((mm = stopRe.exec(text)) !== null) {
    const cand = mm[0];
    const at = mm.index;
    let start = at;
    let end = at + cand.length;
    if (text[start - 1] === "`" && text[end] === "`") {
      start -= 1;
      end += 1;
    }
    const path = normalizeCandidate(text.slice(start, end));
    if (!acceptable(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    found.push({ path, rawStart: start, rawEnd: end });
  }
  return found;
}
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start, end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}
function apply(ctx) {
  const fs = ctx.get("fs");
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    const port = webServer.port ?? 0;
    webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      async handler(req, res) {
        try {
          const raw = String(req.url ?? "");
          const at = raw.indexOf("?");
          const query = {};
          if (at !== -1) {
            for (const pair of raw.slice(at + 1).split("&")) {
              const eq = pair.indexOf("=");
              if (eq === -1) continue;
              try {
                query[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
              } catch {
              }
            }
          }
          if (query.t !== token || !query.p) {
            res.writeHead(400);
            res.end("bad request");
            return;
          }
          const mediaType = mediaTypeFor(query.p);
          if (mediaType === null) {
            res.writeHead(400);
            res.end("not an audio path");
            return;
          }
          const maxBytes = 200 * 1024 * 1024;
          const target = await fs?.resolve(query.p);
          if (target === void 0) throw new Error("fs unavailable");
          const bytes = await fs.readBytes(target, void 0, maxBytes);
          const size = bytes.byteLength;
          const range = parseRange(req.headers.range, size);
          if (range !== null) {
            const slice = bytes.subarray(range.start, range.end + 1);
            res.writeHead(206, {
              "Content-Type": mediaType,
              "Content-Length": slice.byteLength,
              "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
              "Accept-Ranges": "bytes",
              "Cache-Control": "private, max-age=60"
            });
            res.end(slice);
          } else {
            res.writeHead(200, {
              "Content-Type": mediaType,
              "Content-Length": size,
              "Accept-Ranges": "bytes",
              "Cache-Control": "private, max-age=60"
            });
            res.end(bytes);
          }
        } catch {
          try {
            res.writeHead(404);
            res.end("not found");
          } catch {
          }
        }
      }
    });
    ctx.on("llm/stream", (options, next) => {
      if (options?.purpose) return next();
      return rewriteStream(next, port, token, fs);
    }, { global: true, prepend: true });
  });
}
async function* rewriteStream(next, port, token, fs) {
  const seenPaths = /* @__PURE__ */ new Set();
  for await (const chunk of next()) {
    if (chunk?.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") {
      try {
        const text = chunk.block.text;
        const ranges = scanAudioPathRanges(text);
        if (ranges.length > 0 && fs !== void 0) {
          let rewritten = text;
          let changed = false;
          const todo = [];
          for (const range of ranges) {
            if (seenPaths.has(range.path)) continue;
            seenPaths.add(range.path);
            try {
              const target = await fs.resolve(range.path);
              const info = await fs.stat(target);
              if (info === void 0 || info.type !== "file") continue;
            } catch {
              continue;
            }
            todo.push({ range, url: "http://127.0.0.1:" + port + ROUTE_PATH + "?t=" + token + "&p=" + encodeURIComponent(range.path) });
          }
          todo.sort((a, b) => b.range.rawStart - a.range.rawStart);
          for (const { range, url } of todo) {
            const before = rewritten;
            rewritten = rewritten.slice(0, range.rawStart) + "![audio](" + url + ")" + rewritten.slice(range.rawEnd);
            if (rewritten !== before) changed = true;
          }
          if (changed) {
            yield { ...chunk, block: { ...chunk.block, text: rewritten } };
            continue;
          }
        }
      } catch (error) {
        console.error("[dsh-inline-audio] \u97F3\u9891\u8DEF\u5F84\u6539\u5199\u5931\u8D25:", error);
      }
    }
    yield chunk;
  }
}
var index_default = { name, inject, apply };
export {
  apply,
  index_default as default,
  inject,
  name
};
//# sourceMappingURL=index.js.map
