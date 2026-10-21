'use strict';

// ── 設定 ──────────────────────────────────────────────────
const DB_NAME    = 'scan_app_db';
const DB_VERSION = 2;
const STORE_NAME = 'products';

const VERSION = { date: '2026-10-21', count: 9 };

// ── 状態 ──────────────────────────────────────────────────
let db  = null;
let cam = null; // カメラ実行中の状態 { stream, video, ... }。停止中は null

const scanSession  = new Map(); // jan → { jan, name, category, description }
const closedGroups = new Set(); // ユーザーが明示的に閉じたグループ名
const inFlightJANs = new Set(); // DB検索中のJAN（二重登録防止）
const checkedItems = new Set(); // チェック済みJAN
let toastTimer = null;

const CATEGORIES = ['分類A', '分類B', '分類C'];
let categoryIndex = 0;
function randomCategory() {
  return CATEGORIES[categoryIndex++ % CATEGORIES.length];
}

// ── バーコードフォーマット ────────────────────────────────
// zxing は zxing-wasm の形式名。CDN グローバルを参照しないので、ライブラリ未読込でも app.js は動く。
// UPC-A は EAN-13 の先頭0付きとして読めるので、JAN 用途では EAN-13 だけで足りる。
// フォーマットを増やすほど EAN-13 の一部を EAN-8 / UPC-E と誤認する率が上がるため、デフォルトは絞る。
const FORMATS_KEY = 'scan_formats_v2';
const FORMAT_DEFS = [
  { key: 'EAN_13',  label: 'EAN-13 / UPC-A（JANコード 13桁）', zxing: 'EAN13',  defaultOn: true  },
  { key: 'EAN_8',   label: 'EAN-8（JANコード 8桁）',          zxing: 'EAN8',   defaultOn: true  },
  { key: 'UPC_E',   label: 'UPC-E（国際商品短縮形）',          zxing: 'UPCE',   defaultOn: false },
  { key: 'QR_CODE', label: 'QRコード',                         zxing: 'QRCode', defaultOn: false },
];

function defaultFormatKeys() {
  return FORMAT_DEFS.filter(f => f.defaultOn).map(f => f.key);
}

function loadEnabledFormatKeys() {
  try {
    const saved = JSON.parse(localStorage.getItem(FORMATS_KEY));
    if (Array.isArray(saved)) {
      const keys = saved.filter(k => FORMAT_DEFS.some(f => f.key === k));
      if (keys.length > 0) return keys;
    }
  } catch { /* 壊れた値はデフォルトに戻す */ }
  return defaultFormatKeys();
}

function buildReaderOptions() {
  const enabled = loadEnabledFormatKeys();
  return {
    formats: FORMAT_DEFS.filter(f => enabled.includes(f.key)).map(f => f.zxing),
    tryHarder: true,
    tryRotate: false, // 横長のスキャン枠に収まるのは横向きのバーコードだけなので不要
    tryInvert: false,
    maxNumberOfSymbols: 1,
  };
}

// ── JAN 正規化 ────────────────────────────────────────────
// CSV取り込み・カメラ・手入力のすべてでこれを通し、IndexedDB のキーを揃える。

function normalizeCode(raw) {
  const s = String(raw ?? '').replace(/^﻿/, '').trim();
  if (/^\d{12}$/.test(s)) return '0' + s; // UPC-A / Excel で先頭0が落ちた JAN
  return s;
}

// Excel が数値として保存した JAN（4.90123E+12）。桁が失われているので復元できない
function isExcelExponent(s) {
  return /^\d(\.\d+)?E\+\d+$/i.test(s);
}

// EAN-8 / UPC-A / EAN-13 / GTIN-14 のチェックディジット検証
function hasValidCheckDigit(code) {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check  = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

// UPC-E（8桁）→ UPC-A（12桁）
function expandUPCE(upce) {
  if (!/^[01]\d{7}$/.test(upce)) return upce;
  const ns = upce[0], d = upce.slice(1, 7), check = upce[7];
  const last = d[5];
  let body;
  if (last <= '2')       body = d[0] + d[1] + last + '0000' + d[2] + d[3] + d[4];
  else if (last === '3') body = d[0] + d[1] + d[2] + '00000' + d[3] + d[4];
  else if (last === '4') body = d[0] + d[1] + d[2] + d[3] + '00000' + d[4];
  else                   body = d[0] + d[1] + d[2] + d[3] + d[4] + '0000' + last;
  return ns + body + check;
}

function normalizeScanned(text, format) {
  return normalizeCode(format === 'UPCE' ? expandUPCE(text) : text);
}

// ── 手動入力モード ────────────────────────────────────────
const MANUAL_INPUT_KEY = 'manual_input';

function isManualInputEnabled() {
  return localStorage.getItem(MANUAL_INPUT_KEY) === 'true'; // デフォルト: OFF
}

function applyInputMode() {
  const input = document.getElementById('jan-input');
  if (input) input.inputMode = isManualInputEnabled() ? 'numeric' : 'none';
}

// ── デモモード ────────────────────────────────────────────
const DEMO_MODE_KEY = 'demo_mode';
let demoMode = localStorage.getItem(DEMO_MODE_KEY) === 'true'; // デフォルト: OFF

function toggleDemoMode() {
  demoMode = !demoMode;
  localStorage.setItem(DEMO_MODE_KEY, demoMode ? 'true' : 'false');
  updateDemoModeUI();
  showToast(demoMode ? 'デモモード ON（ラウンドロビン分類）' : 'デモモード OFF（CSV分類を使用）', 'info', 2000);
}

function updateDemoModeUI() {
  const btn = document.getElementById('btn-demo');
  if (!btn) return;
  if (demoMode) {
    btn.textContent = 'DEMO: ON';
    btn.classList.add('demo-on');
    btn.classList.remove('demo-off');
  } else {
    btn.textContent = 'DEMO: OFF';
    btn.classList.add('demo-off');
    btn.classList.remove('demo-on');
  }
}

function openSettingsDialog() {
  const overlay = document.getElementById('settings-overlay');
  overlay.querySelector('.settings-version').textContent =
    'バージョン: ' + VERSION.date + ' #' + VERSION.count;
  const enabled = loadEnabledFormatKeys();
  document.getElementById('format-checkboxes').innerHTML = FORMAT_DEFS.map(f => `
    <label class="format-item">
      <input type="checkbox" value="${f.key}" ${enabled.includes(f.key) ? 'checked' : ''}>
      <span>${f.label}</span>
    </label>
  `).join('');
  document.getElementById('manual-input-toggle').checked = isManualInputEnabled();
  overlay.classList.remove('hidden');
}

// ── IndexedDB ─────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'jan' });
      } else if (e.oldVersion < 2) {
        // v1→v2: 旧フォーマット（rack/shelf/remarks）を破棄
        e.target.transaction.objectStore(STORE_NAME).clear();
        localStorage.removeItem('db_count');
        localStorage.removeItem('db_date');
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// 一括挿入: 単一トランザクション内で全put()を同期発火（await挟まない）
function bulkInsert(database, records) {
  return new Promise((resolve, reject) => {
    const tx    = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const rec of records) {
      store.put(rec);
    }
    // JAN 重複時は put が上書きするので、件数は実際に入った数を数える
    const countReq = store.count();
    tx.oncomplete = () => resolve(countReq.result);
    tx.onerror    = (e) => reject(e.target.error);
    tx.onabort    = (e) => reject(e.target.error);
  });
}

// JAN検索: keyPath直引きでO(1)
function lookupJAN(database, jan) {
  return new Promise((resolve, reject) => {
    const tx  = database.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(jan);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function countRecords(database) {
  return new Promise((resolve, reject) => {
    const req = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function clearIndexedDB() {
  if (!db) { showToast('DBが準備できていません', 'error'); return; }
  if (!confirm('インデックスDBのデータをすべて削除しますか？')) return;
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  tx.oncomplete = () => {
    localStorage.removeItem('db_count');
    localStorage.removeItem('db_date');
    updateHeaderMeta();
    showToast('DBをクリアしました', 'success');
  };
  tx.onerror = (e) => showToast('DBクリアエラー: ' + e.target.error.message, 'error');
}

function saveMetadata(count) {
  localStorage.setItem('db_count', count);
  const now = new Date();
  const d = String(now.getMonth() + 1).padStart(2, '0') + '/'
           + String(now.getDate()).padStart(2, '0') + ' '
           + String(now.getHours()).padStart(2, '0') + ':'
           + String(now.getMinutes()).padStart(2, '0');
  localStorage.setItem('db_date', d);
}

function loadMetadata() {
  return {
    count: localStorage.getItem('db_count') || null,
    date:  localStorage.getItem('db_date')  || '未同期'
  };
}

function updateHeaderMeta() {
  const m = loadMetadata();
  document.getElementById('db-count').textContent =
    m.count ? Number(m.count).toLocaleString() + '件' : '--件';
  document.getElementById('db-date').textContent = m.date;
}

// 起動時: localStorage の件数と IndexedDB の実件数を突き合わせる。
// iOS Safari はタブ利用だと 7日操作がないとストレージを消すことがあり、気づかずにスキャンすると全件「不明」になる。
function reconcileMetadata(database) {
  return countRecords(database).then((actual) => {
    const m = loadMetadata();
    if (actual === 0) {
      localStorage.removeItem('db_count');
      localStorage.removeItem('db_date');
      updateHeaderMeta();
      showToast(m.count
        ? '商品データが消えています。CSVを読み込み直してください'
        : 'まずCSVを読み込んでください',
        m.count ? 'error' : 'info', m.count ? 6000 : 4000);
      return;
    }
    if (String(actual) !== m.count) localStorage.setItem('db_count', actual);
    updateHeaderMeta();
  });
}

// ── CSV 取り込み ──────────────────────────────────────────

const CSV_URL_KEY = 'csv_url';

function openCsvUrlModal() {
  const overlay = document.getElementById('csv-url-overlay');
  const input   = document.getElementById('csv-url-input');
  input.value = localStorage.getItem(CSV_URL_KEY) || '';
  overlay.classList.remove('hidden');
  setTimeout(() => input.focus(), 100);
}

function closeCsvUrlModal() {
  document.getElementById('csv-url-overlay').classList.add('hidden');
}

// ヘッダー名 → フィールド。比較は headerKey() で正規化した形（sku-name / sku_name / SKU Name はすべて "skuname"）
const HEADER_ALIASES = {
  jan:         ['jan', 'jancode', 'janコード'],
  name:        ['skuname', 'name', '商品名', '品名'],
  category:    ['category', 'カテゴリ', 'カテゴリー', '分類'],
  description: ['description', '説明', '備考'],
};

function headerKey(s) {
  return s.toLowerCase().replace(/[\s_\-]/g, '');
}

// 1行目を見て列の位置を決める。先頭セルが数字ならヘッダーなし（列順 0:JAN, 1:name, 2:category, 3:description）
function buildColumnMap(firstRow) {
  const cells = firstRow.map(c => String(c ?? '').replace(/^﻿/, '').trim());
  if (/^\d+$/.test(cells[0]) || isExcelExponent(cells[0])) {
    return { hasHeader: false, index: { jan: 0, name: 1, category: 2, description: 3 } };
  }
  const keys = cells.map(headerKey);
  const index = {};
  for (const [field, names] of Object.entries(HEADER_ALIASES)) {
    index[field] = keys.findIndex(k => names.includes(k));
  }
  return { hasHeader: true, index };
}

function rowToRecord(row, index) {
  const cell = (i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');
  return {
    jan:         normalizeCode(cell(index.jan)),
    name:        cell(index.name),
    category:    cell(index.category),
    description: cell(index.description),
  };
}

// 文字コード判定: UTF-8 として正しく読めなければ Shift_JIS（日本語版 Excel の「CSV」保存）とみなす。
// UTF-8 の BOM は TextDecoder が取り除く。
function decodeCsvBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

// CSV テキスト → JAN で重複排除したレコード（同じ JAN は後の行が勝つ）
function parseCsvRecords(text) {
  const rows = Papa.parse(text, { header: false, skipEmptyLines: 'greedy' }).data;
  if (rows.length === 0) throw new Error('CSVにデータがありません');

  const columns = buildColumnMap(rows[0]);
  if (columns.hasHeader && columns.index.jan < 0) {
    throw new Error('JAN列が見つかりません（列名: JAN / sku_name / category / description）');
  }

  const byJan = new Map();
  let skippedExp = 0;
  for (let i = columns.hasHeader ? 1 : 0; i < rows.length; i++) {
    const rec = rowToRecord(rows[i], columns.index);
    if (!rec.jan) continue;
    if (isExcelExponent(rec.jan)) { skippedExp++; continue; }
    byJan.set(rec.jan, rec);
  }
  if (byJan.size === 0) throw new Error('CSVにデータがありません');

  const records = [...byJan.values()];
  return { records, skippedExp, noDetails: records.every(r => !r.name && !r.category) };
}

// Blob（ファイル選択・URL取得の両方）を読み込んで IndexedDB に一括置換保存する。
// Papa にファイルを分割読みさせると、チャンク境界にかかった日本語の1文字が化けるので、
// 全体をバイト列で読んで一度にデコードしてからパースする。
function importCsv(blob) {
  return blob.arrayBuffer()
    // トーストを描画させてから重い処理に入る
    .then((buf) => new Promise((resolve) => setTimeout(() => resolve(buf), 0)))
    .then((buf) => parseCsvRecords(decodeCsvBytes(new Uint8Array(buf))))
    .then(({ records, skippedExp, noDetails }) =>
      bulkInsert(db, records)
        .catch((e) => { throw new Error('DB書き込みエラー: ' + e.message); })
        .then((count) => {
          saveMetadata(count);
          updateHeaderMeta();
          return { count, skippedExp, noDetails };
        }));
}

function reportImport(result) {
  if (result.skippedExp > 0) {
    showToast(result.count.toLocaleString() + '件読み込み。' + result.skippedExp
      + '件はJANが指数表記（4.9E+12 等）のためスキップ。Excelで列を文字列にして保存し直してください', 'error', 8000);
  } else if (result.noDetails) {
    showToast(result.count.toLocaleString() + '件読み込み。商品名・カテゴリの列が見つかりません'
      + '（列名: sku_name / category）', 'error', 6000);
  } else {
    showToast(result.count.toLocaleString() + '件の読み込み完了', 'success');
  }
}

function fetchCsvFromUrl(url) {
  url = url.trim();
  if (!url) { showToast('URLを入力してください', 'error'); return; }
  if (!db)  { showToast('DBが準備できていません', 'error'); return; }
  if (typeof Papa === 'undefined') { showToast('CSVライブラリを読み込めませんでした。再読み込みしてください', 'error'); return; }

  localStorage.setItem(CSV_URL_KEY, url);
  closeCsvUrlModal();

  const btnFetch = document.getElementById('btn-csv-fetch');
  btnFetch.disabled = true;
  showToast('CSVを取得中...', 'info', 99999);

  fetch(url, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      // Google ドライブの共有リンク（…/view）などは CSV ではなく HTML のページが返る
      if ((response.headers.get('Content-Type') || '').includes('text/html')) {
        throw new Error('CSVではなくWebページが返されました。Googleスプレッドシートは「ファイル → 共有 → ウェブに公開」でCSV形式のURLを使ってください');
      }
      return response.blob();
    })
    .then((blob) => importCsv(blob))
    .then(reportImport)
    .catch((e) => showToast('読み込みエラー: ' + e.message, 'error'))
    .finally(() => { btnFetch.disabled = false; });
}

function loadCsvFromFile(file) {
  if (!file) return;
  if (!db) { showToast('DBが準備できていません', 'error'); return; }
  if (typeof Papa === 'undefined') { showToast('CSVライブラリを読み込めませんでした。再読み込みしてください', 'error'); return; }

  closeCsvUrlModal();
  const btnFile = document.getElementById('btn-csv-file');
  btnFile.disabled = true;
  showToast('CSVを読み込み中...', 'info', 99999);

  importCsv(file)
    .then(reportImport)
    .catch((err) => showToast(err.message, 'error'))
    .finally(() => { btnFile.disabled = false; });
}

// ── カメラスキャン（zxing-wasm）──────────────────────────
// 映像を画面サイズに縮小せず、スキャン枠の範囲を映像の元解像度で切り出してデコードする。

const CONFIRM_HITS     = 2;    // 1次元バーコードは同じ値が連続でこの回数読めたら確定（誤読対策）
const CONFIRM_WINDOW   = 800;  // ms: 連続とみなす間隔
const REPEAT_COOLDOWN  = 1500; // ms: 確定した値をかざしたままのとき、再通知しない時間
const SCAN_INTERVAL    = 66;   // ms: デコードの最短間隔（約15回/秒）。上限なしだと毎秒60回以上回り電池を消耗する

let readerOptions = null;
let zxingReady    = null;

function zxingLocateFile(path, prefix) {
  return path.endsWith('.wasm') ? new URL('vendor/' + path, document.baseURI).href : prefix + path;
}

function loadZXing() {
  if (!zxingReady) {
    zxingReady = Promise.resolve()
      .then(() => ZXingWASM.prepareZXingModule({
        overrides: { locateFile: zxingLocateFile },
        fireImmediately: true,
      }))
      .catch((e) => { zxingReady = null; throw e; });
  }
  return zxingReady;
}

function isSquareGuide() {
  return loadEnabledFormatKeys().includes('QR_CODE');
}

// スキャン枠（#reader 内の CSS ピクセル座標）
function guideRect(width, height, square) {
  if (square) {
    const s = Math.min(width, height) * 0.85;
    return { x: (width - s) / 2, y: (height - s) / 2, w: s, h: s };
  }
  const w = width * 0.88, h = height * 0.7;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

// 表示座標 → 映像のピクセル座標（video は object-fit: cover で表示している）
function toSourceRect(rect, viewW, viewH, videoW, videoH) {
  const scale = Math.max(viewW / videoW, viewH / videoH);
  const offX  = (videoW * scale - viewW) / 2;
  const offY  = (videoH * scale - viewH) / 2;
  return {
    x: (rect.x + offX) / scale,
    y: (rect.y + offY) / scale,
    w: rect.w / scale,
    h: rect.h / scale,
  };
}

function layoutGuide() {
  const reader = document.getElementById('reader');
  const guide  = document.getElementById('scan-guide');
  const r = guideRect(reader.clientWidth, reader.clientHeight, isSquareGuide());
  guide.style.left   = r.x + 'px';
  guide.style.top    = r.y + 'px';
  guide.style.width  = r.w + 'px';
  guide.style.height = r.h + 'px';
}

function setCameraButtons(running) {
  document.getElementById('btn-start').disabled = running;
  document.getElementById('btn-stop').disabled  = !running;
  document.getElementById('reader').classList.toggle('running', running);
}

function handleCameraError(err) {
  stopScanner();
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    document.getElementById('permission-overlay').classList.remove('hidden');
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    showToast('カメラが見つかりません', 'error');
  } else if (name === 'NotReadableError') {
    showToast('カメラを使用できません（他のアプリが使用中の可能性があります）', 'error');
  } else {
    showToast('カメラエラー: ' + (err && err.message ? err.message : err), 'error');
  }
}

// 開始ボタンのクリックから同期的に呼ぶこと（iOS の getUserMedia 要件）
function startScanner() {
  if (cam) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('この環境ではカメラを使えません（HTTPSで開いてください）', 'error');
    return;
  }
  if (typeof ZXingWASM === 'undefined') {
    showToast('スキャナーを読み込めませんでした。再読み込みしてください', 'error');
    return;
  }

  const c = { stream: null, video: document.getElementById('camera-video'),
              canvas: document.createElement('canvas'), ctx: null,
              lastText: '', lastTime: 0, hits: 0, confirmedText: '', confirmedTime: 0 };
  c.ctx = c.canvas.getContext('2d', { willReadFrequently: true });
  cam = c;
  setCameraButtons(true);
  readerOptions = buildReaderOptions();
  layoutGuide();

  const media = navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width:  { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });

  Promise.all([media, loadZXing()])
    .then(([stream]) => {
      if (cam !== c) { stream.getTracks().forEach(t => t.stop()); return; }
      c.stream = stream;
      const track = stream.getVideoTracks()[0];
      const caps  = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
      c.video.srcObject = stream;
      return c.video.play().then(() => requestAnimationFrame(() => scanFrame(c)));
    })
    .catch((err) => {
      // 開始中に停止された場合の play() 中断などは無視する
      if (cam === c) handleCameraError(err);
    });
}

function stopScanner() {
  const c = cam;
  cam = null;
  setCameraButtons(false);
  if (!c) return;
  if (c.stream) c.stream.getTracks().forEach(t => t.stop());
  c.video.srcObject = null;
}

function scanFrame(c) {
  if (cam !== c) return;
  const started = performance.now();
  // 前回の開始から SCAN_INTERVAL 空けて、次の描画フレームで読む
  const next = () => {
    if (cam !== c) return;
    const wait = Math.max(0, SCAN_INTERVAL - (performance.now() - started));
    setTimeout(() => requestAnimationFrame(() => scanFrame(c)), wait);
  };
  const v = c.video;
  if (v.readyState < 2 || !v.videoWidth) { next(); return; }

  const reader = document.getElementById('reader');
  const viewW = reader.clientWidth, viewH = reader.clientHeight;
  const src = toSourceRect(guideRect(viewW, viewH, isSquareGuideCached(c)), viewW, viewH, v.videoWidth, v.videoHeight);
  const sx = Math.max(0, Math.round(src.x)), sy = Math.max(0, Math.round(src.y));
  const sw = Math.min(v.videoWidth - sx, Math.round(src.w));
  const sh = Math.min(v.videoHeight - sy, Math.round(src.h));
  if (sw <= 0 || sh <= 0) { next(); return; }

  if (c.canvas.width !== sw || c.canvas.height !== sh) {
    c.canvas.width = sw;
    c.canvas.height = sh;
  }
  c.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
  const image = c.ctx.getImageData(0, 0, sw, sh);

  ZXingWASM.readBarcodes(image, readerOptions)
    .then((results) => {
      if (cam !== c) return;
      const hit = results.find(r => r.isValid && r.text);
      if (hit) onDecoded(c, hit.text, hit.format);
    })
    .catch(() => {})
    .finally(next);
}

function isSquareGuideCached(c) {
  if (c.square === undefined) c.square = isSquareGuide();
  return c.square;
}

function onDecoded(c, text, format) {
  const now = Date.now();
  if (text === c.confirmedText && now - c.confirmedTime < REPEAT_COOLDOWN) {
    c.confirmedTime = now; // かざし続けている間は延長
    return;
  }
  c.hits = (text === c.lastText && now - c.lastTime < CONFIRM_WINDOW) ? c.hits + 1 : 1;
  c.lastText = text;
  c.lastTime = now;
  // QR は誤り訂正があるので1回で確定
  if (format !== 'QRCode' && c.hits < CONFIRM_HITS) return;

  c.hits = 0;
  c.confirmedText = text;
  c.confirmedTime = now;
  processCode(normalizeScanned(text, format), 'camera');
}

// ── 製品解決 ──────────────────────────────────────────────

// DBの検索結果とデモモードを考慮してセッション用の製品オブジェクトを返す
function resolveProduct(jan, dbProduct) {
  if (demoMode) {
    const cat = randomCategory();
    return dbProduct
      ? { jan, name: dbProduct.name, category: cat, description: dbProduct.description }
      : { jan, name: '', category: cat, description: '' };
  }
  // 通常モード: CSVの実際のカテゴリを使用
  return dbProduct || { jan, name: '', category: '不明', description: '' };
}

// ── セッション ────────────────────────────────────────────

function deleteFromSession(jan) {
  scanSession.delete(jan);
  checkedItems.delete(jan);
  inFlightJANs.delete(jan);
  updateScanCount();
  renderGroupedResults();
}

function addToSession(jan, product) {
  scanSession.set(jan, product);
  updateScanCount();
  renderGroupedResults();
  const label = product.name || product.category || jan;
  showToast(jan + ' → ' + label, 'success');
  if (navigator.vibrate) navigator.vibrate(40);
}

// カメラ・手入力・ハンディスキャナー共通。source: 'camera' | 'manual'
function processCode(code, source) {
  if (!code) return;
  const fromCamera = source === 'camera';

  if (scanSession.has(code) || inFlightJANs.has(code)) {
    if (fromCamera) flashViewfinder('success');
    else showToast('登録済み: ' + code, 'info');
    return;
  }

  // 手入力の打ち間違いを弾く（カメラはデコーダが検証済み）
  if (!fromCamera && /^(\d{8}|\d{13})$/.test(code) && !hasValidCheckDigit(code)) {
    showToast('チェックディジットが合いません: ' + code, 'error');
    return;
  }

  if (!db) {
    addToSession(code, resolveProduct(code, null));
    if (fromCamera) flashViewfinder('success');
    return;
  }

  inFlightJANs.add(code);
  lookupJAN(db, code)
    .then((dbProduct) => {
      // 検索中に CLR・削除された場合は追加しない
      if (!inFlightJANs.delete(code)) return;
      addToSession(code, resolveProduct(code, dbProduct));
      if (fromCamera) flashViewfinder(dbProduct ? 'success' : 'error');
    })
    .catch((e) => {
      inFlightJANs.delete(code);
      showToast('検索エラー: ' + e.message, 'error');
    });
}

function handleJanInput(raw) {
  processCode(normalizeCode(raw), 'manual');
}

function flashViewfinder(type) {
  const reader = document.getElementById('reader');
  const cls = type === 'success' ? 'flash-success' : 'flash-error';
  reader.classList.add(cls);
  setTimeout(() => reader.classList.remove(cls), 300);
}

// ── UI ────────────────────────────────────────────────────

function updateScanCount() {
  const total   = scanSession.size;
  const checked = checkedItems.size;
  const el = document.getElementById('scan-count');
  el.textContent = checked > 0
    ? 'スキャン済: ' + total + '件（チェック: ' + checked + '）'
    : 'スキャン済: ' + total + '件';
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderGroupedResults() {
  const container = document.getElementById('results');

  if (scanSession.size === 0) {
    container.innerHTML = '<p class="empty-msg">スキャン結果はここに表示されます</p>';
    return;
  }

  // カテゴリでグループ化
  const groups = new Map();
  for (const [jan, product] of scanSession) {
    const key = product.category || '（カテゴリなし）';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ jan, name: product.name, description: product.description });
  }

  // グループ名を五十音順でソート
  const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ja'));

  const html = sortedKeys.map((key) => {
    const items  = groups.get(key);
    const isOpen = !closedGroups.has(key); // デフォルトは展開

    const rows = items.map((p, i) => {
      const isLast    = i === items.length - 1;
      const isChecked = checkedItems.has(p.jan);
      return '<div class="result-item' + (isChecked ? ' checked' : '') + '">'
        + '<button class="btn-item-check' + (isChecked ? ' checked' : '') + '" data-jan="' + escapeHTML(p.jan) + '" aria-label="チェック">✓</button>'
        + '<span class="tree-char">' + (isLast ? '└' : '├') + '</span>'
        + '<div class="item-info">'
        +   '<div class="item-jan">' + escapeHTML(p.jan) + '</div>'
        + (p.name        ? '<div class="item-name">' + escapeHTML(p.name)        + '</div>' : '')
        + (p.description ? '<div class="item-desc">' + escapeHTML(p.description) + '</div>' : '')
        + '</div>'
        + '<button class="btn-item-delete" data-jan="' + escapeHTML(p.jan) + '" aria-label="削除">×</button>'
        + '</div>';
    }).join('');

    return '<details class="result-group" data-key="' + escapeHTML(key) + '"'
      + (isOpen ? ' open' : '') + '>'
      + '<summary>'
      +   '<span class="group-name">' + escapeHTML(key) + '</span>'
      +   '<span class="group-count">' + items.length + '件</span>'
      + '</summary>'
      + '<div class="result-items">' + rows + '</div>'
      + '</details>';
  }).join('');

  container.innerHTML = html;
}

function showToast(message, type, duration) {
  if (duration === undefined) duration = 2500;
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + type;

  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  if (duration < 99999) {
    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, duration);
  }
}

// ── Service Worker ────────────────────────────────────────
// 新しい版を検出したらバナーを出し、ユーザーが「更新」を押したときだけ切り替える。
// 自動リロードするとスキャン途中の結果が消えるため。

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  let updateRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) window.location.reload();
  });

  const showUpdateBanner = (worker) => {
    const banner = document.getElementById('update-banner');
    banner.classList.remove('hidden');
    document.getElementById('btn-update').onclick = () => {
      updateRequested = true;
      worker.postMessage('SKIP_WAITING');
    };
  };

  navigator.serviceWorker.register('./service-worker.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(worker);
      });
    });
    // ホーム画面アプリは開きっぱなしになりやすいので、前面に戻るたびに更新を確認する
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  }).catch(() => {});
}

// ── 初期化 ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // IndexedDB 初期化
  openDB()
    .then((database) => {
      db = database;
      updateHeaderMeta();
      return reconcileMetadata(database);
    })
    .catch((e) => {
      const isPrivate = e && e.name === 'SecurityError';
      showToast(
        isPrivate
          ? 'プライベートブラウズでは使用できません。\n通常タブで開いてください。'
          : 'DB初期化エラー: ' + (e && e.message),
        'error',
        99999
      );
    });

  // ストレージの自動削除を避ける（ホーム画面アプリでは元々対象外）
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // タイトルタップで設定ダイアログ
  document.querySelector('.app-title').addEventListener('click', openSettingsDialog);
  document.getElementById('btn-settings-close').addEventListener('click', () => {
    const checked = [...document.querySelectorAll('#format-checkboxes input:checked')].map(i => i.value);
    if (checked.length === 0) { showToast('最低1つ選択してください', 'error'); return; }
    localStorage.setItem(FORMATS_KEY, JSON.stringify(checked));
    localStorage.setItem(MANUAL_INPUT_KEY,
      document.getElementById('manual-input-toggle').checked ? 'true' : 'false');
    applyInputMode();
    document.getElementById('settings-overlay').classList.add('hidden');
    // カメラを止めずにその場で反映する
    readerOptions = buildReaderOptions();
    if (cam) cam.square = isSquareGuide();
    layoutGuide();
  });

  // デモモードボタン
  document.getElementById('btn-demo').addEventListener('click', toggleDemoMode);
  updateDemoModeUI();
  applyInputMode();
  layoutGuide();
  window.addEventListener('resize', layoutGuide);

  // CSV取得ボタン → モーダルを開く
  document.getElementById('btn-csv').addEventListener('click', openCsvUrlModal);

  // ファイル選択ボタン → hidden file inputをトリガー
  document.getElementById('btn-csv-file').addEventListener('click', () => {
    document.getElementById('csv-file-input').click();
  });

  // ファイル選択後に読み込み開始
  document.getElementById('csv-file-input').addEventListener('change', (e) => {
    loadCsvFromFile(e.target.files[0]);
    e.target.value = ''; // 同じファイルの再選択を許可
  });

  // DBクリアボタン
  document.getElementById('btn-db-clear').addEventListener('click', clearIndexedDB);

  // モーダル内キャンセル
  document.getElementById('btn-csv-cancel').addEventListener('click', closeCsvUrlModal);

  // モーダル内読み込み
  document.getElementById('btn-csv-fetch').addEventListener('click', () => {
    fetchCsvFromUrl(document.getElementById('csv-url-input').value);
  });

  // URLインプットでEnter確定
  document.getElementById('csv-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fetchCsvFromUrl(document.getElementById('csv-url-input').value);
    }
  });

  // JAN入力フィールド: Enterキー / ハンディスキャナーのEnter送出に対応
  const janInput = document.getElementById('jan-input');
  janInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleJanInput(janInput.value);
      janInput.value = '';
      janInput.focus();
    }
  });

  // 追加ボタン（タッチ操作用）
  document.getElementById('btn-add').addEventListener('click', () => {
    handleJanInput(janInput.value);
    janInput.value = '';
    janInput.focus();
  });

  // ページ読み込み後に入力フィールドへフォーカス（ハンディスキャナーがすぐ使えるよう）
  janInput.focus();

  // 開始ボタン: startScanner() を同期的に呼ぶ（iOS getUserMedia要件）
  document.getElementById('btn-start').addEventListener('click', () => {
    startScanner();
  });

  // 停止ボタン
  document.getElementById('btn-stop').addEventListener('click', () => {
    stopScanner();
  });

  // CLRボタン（スキャンセッションのみクリア）
  document.getElementById('btn-clear').addEventListener('click', () => {
    scanSession.clear();
    closedGroups.clear();
    inFlightJANs.clear();
    checkedItems.clear();
    updateScanCount();
    renderGroupedResults();
  });

  const results = document.getElementById('results');

  // チェック・削除ボタン（イベント委譲）
  results.addEventListener('click', (e) => {
    const checkBtn = e.target.closest('.btn-item-check');
    if (checkBtn) {
      const jan = checkBtn.dataset.jan;
      const on  = !checkedItems.has(jan);
      if (on) checkedItems.add(jan);
      else checkedItems.delete(jan);
      // 全体を描き直さず、その行だけ切り替える
      checkBtn.classList.toggle('checked', on);
      checkBtn.closest('.result-item').classList.toggle('checked', on);
      updateScanCount();
      return;
    }
    const deleteBtn = e.target.closest('.btn-item-delete');
    if (deleteBtn) deleteFromSession(deleteBtn.dataset.jan);
  });

  // グループの開閉状態を追跡（再描画後も維持するため）。toggle はバブリングしないのでキャプチャで拾う
  results.addEventListener('toggle', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches('details.result-group')) return;
    if (el.open) closedGroups.delete(el.dataset.key);
    else closedGroups.add(el.dataset.key);
  }, true);

  // オーバーレイ閉じるボタン
  document.getElementById('btn-dismiss-overlay').addEventListener('click', () => {
    document.getElementById('permission-overlay').classList.add('hidden');
  });

  // バックグラウンド遷移時にカメラ停止（iOS Safari対策）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScanner();
  });
  window.addEventListener('pagehide', stopScanner);

  // 初期表示
  updateScanCount();
  renderGroupedResults();

  registerServiceWorker();
});

// ── テスト用エクスポート（本番ブラウザでは実行されない）─────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    bulkInsert, lookupJAN, resolveProduct,
    normalizeCode, normalizeScanned, isExcelExponent, hasValidCheckDigit, expandUPCE,
    buildColumnMap, rowToRecord, decodeCsvBytes, parseCsvRecords, loadEnabledFormatKeys, buildReaderOptions,
    guideRect, toSourceRect,
  };
}
