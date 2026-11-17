#!/usr/bin/env node
/** cheerio 打包进 lib/vendor/：插件必须零运行时依赖（files 只发 lib+patch）。 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib/vendor'), { recursive: true })
buildSync({
  stdin: { contents: "export { load } from 'cheerio'", resolveDir: join(root, 'src') },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  outfile: join(root, 'lib/vendor/cheerio.js'),
  external: [
    'node:*',
    // CJS 链裸 require 的内置名（node:* 前缀规则盖不住）
    'assert', 'buffer', 'console', 'crypto', 'events', 'fs', 'http', 'https',
    'net', 'os', 'path', 'punycode', 'querystring', 'stream', 'string_decoder',
    'tls', 'url', 'util', 'zlib', 'diagnostics_channel', 'worker_threads',
  ],
})
console.log('bundled: cheerio -> lib/vendor/cheerio.js')
