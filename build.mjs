// 社区规范:源码仓库 + 构建脚本生成 lib/。esbuild 不检查类型。
import { build } from 'esbuild'
import { mkdirSync, copyFileSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@deepseek-ai/*', 'zod'],
  sourcemap: true,
})

// 客户端 bundle:手写的 CJS factory bundle(window.__ModuleLoader__.load),
// 直接复制为 lib/client.js —— 协议对齐 dsh-chat-import / dsh-genui。
copyFileSync('client-bundle.js', 'lib/client.js')

console.log('built dsh-inline-audio (lib/index.js + lib/client.js)')