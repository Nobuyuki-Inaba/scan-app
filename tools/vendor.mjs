/**
 * 外部ライブラリを node_modules から public/vendor/ へコピーする。
 *
 *   npm run vendor
 *
 * CDN を使わず自己ホストすることで、オフライン起動（Service Worker のプリキャッシュ）と
 * CDN 障害・改ざんへの耐性を得る。ライブラリを更新したら npm install 後にこれを流してコミットする。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'public', 'vendor');

const FILES = [
  ['node_modules/papaparse/papaparse.min.js',               'papaparse.min.js'],
  ['node_modules/zxing-wasm/dist/iife/reader/index.js',     'zxing-reader.js'],
  ['node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', 'zxing_reader.wasm'],
];

fs.rmSync(VENDOR, { recursive: true, force: true });
fs.mkdirSync(VENDOR, { recursive: true });
for (const [src, dest] of FILES) {
  fs.copyFileSync(path.join(ROOT, src), path.join(VENDOR, dest));
  const kb = fs.statSync(path.join(VENDOR, dest)).size / 1024;
  console.log(`public/vendor/${dest}  ${kb.toFixed(0)}KB`);
}
