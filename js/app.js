'use strict';

// ── 設定 ──────────────────────────────────────────────────
const DB_NAME    = 'scan_app_db';
const DB_VERSION = 2;
const STORE_NAME = 'products';

// ── 状態 ──────────────────────────────────────────────────
let db      = null;
let scanner = null; // html5-qrcode インスタンス（連続スキャンモード用）

const scanSession  = new Map(); // jan → { jan, name, category, description }
const closedGroups = new Set(); // ユーザーが明示的に閉じたグループ名
const inFlightJANs = new Set(); // DB検索中のJAN（二重登録防止）
let toastTimer = null;

const CATEGORIES = ['分類A', '分類B', '分類C'];
let categoryIndex = 0;
function randomCategory() {
  return CATEGORIES[categoryIndex++ % CATEGORIES.length];
}

// ── デモモード ────────────────────────────────────────────
const DEMO_MODE_KEY = 'demo_mode';
let demoMode = localStorage.getItem(DEMO_MODE_KEY) !== 'false'; // デフォルト: ON

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
    tx.oncomplete = () => resolve(records.length);
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

// ── CSV URL モーダル ──────────────────────────────────────

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

function parseCsvText(text) {
  return new Promise((resolve, reject) => {
    // 先頭セルが数字のみならヘッダーなしと判断
    const firstCell = text.replace(/^﻿/, '').trim().split(/\r?\n/)[0]
      .split(',')[0].replace(/^"|"$/g, '').trim();
    const hasHeader = !/^\d+$/.test(firstCell);

    const records = [];
    Papa.parse(text, {
      header: hasHeader,
      encoding: 'UTF-8',
      skipEmptyLines: true,
      step: (result) => {
        let jan, name, category, description;
        if (hasHeader) {
          const row = result.data;
          jan         = (row['JAN'] || row['jan'] || row['﻿JAN'] || '').toString().trim();
          name        = (row['sku-name']    || row['商品名']  || row['name']        || '').trim();
          category    = (row['category']    || row['カテゴリ'] || row['分類']        || '').trim();
          description = (row['description'] || row['説明']   || row['備考']         || '').trim();
        } else {
          const row = result.data;
          jan         = (row[0] || '').toString().trim();
          name        = (row[1] || '').trim();
          category    = (row[2] || '').trim();
          description = (row[3] || '').trim();
        }
        if (!jan) return;
        records.push({ jan, name, category, description });
        if (records.length % 5000 === 0) {
          showToast(records.length.toLocaleString() + '件処理中...', 'info', 99999);
        }
      },
      complete: () => {
        if (records.length === 0) { reject(new Error('CSVにデータがありません')); return; }
        bulkInsert(db, records)
          .then((count) => { saveMetadata(count); updateHeaderMeta(); resolve(count); })
          .catch((e) => reject(new Error('DB書き込みエラー: ' + e.message)));
      },
      error: (err) => reject(new Error('CSVパースエラー: ' + err.message))
    });
  });
}

function fetchCsvFromUrl(url) {
  url = url.trim();
  if (!url) { showToast('URLを入力してください', 'error'); return; }
  if (!db)  { showToast('DBが準備できていません', 'error'); return; }

  localStorage.setItem(CSV_URL_KEY, url);
  closeCsvUrlModal();

  const btnFetch = document.getElementById('btn-csv-fetch');
  btnFetch.disabled = true;
  showToast('CSVを取得中...', 'info', 99999);

  fetch(url, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    })
    .then((text) => parseCsvText(text))
    .then((count) => showToast(count.toLocaleString() + '件の読み込み完了', 'success'))
    .catch((e) => showToast('接続エラー: ' + e.message, 'error'))
    .finally(() => { btnFetch.disabled = false; });
}

function loadCsvFromFile(file) {
  if (!file) return;
  if (!db) { showToast('DBが準備できていません', 'error'); return; }

  closeCsvUrlModal();
  const btnFile = document.getElementById('btn-csv-file');
  btnFile.disabled = true;
  showToast('CSVを読み込み中...', 'info', 99999);

  const reader = new FileReader();
  reader.onload = (e) => {
    parseCsvText(e.target.result)
      .then((count) => showToast(count.toLocaleString() + '件の読み込み完了', 'success'))
      .catch((err) => showToast(err.message, 'error'))
      .finally(() => { btnFile.disabled = false; });
  };
  reader.onerror = () => {
    showToast('ファイル読み込みエラー', 'error');
    btnFile.disabled = false;
  };
  reader.readAsText(file);
}

// ── 連続スキャン（ZXing / html5-qrcode）iOS Safari 用 ────────

function handleCameraError(err) {
  const msg = err ? err.toString() : '';
  if (msg.includes('NotAllowed') || msg.includes('Permission') || msg.includes('permission')) {
    document.getElementById('permission-overlay').classList.remove('hidden');
  } else {
    showToast('カメラエラー: ' + msg, 'error');
  }
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled  = true;
}

function startScanner() {
  document.getElementById('btn-start').disabled = true;
  if (scanner) {
    scanner.stop().catch(() => {}).finally(() => { scanner = null; _doStartZXing(); });
  } else {
    _doStartZXing();
  }
}

function _doStartZXing() {
  scanner = new Html5Qrcode('reader');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    onScanSuccess,
    () => {}
  ).then(() => {
    document.getElementById('btn-stop').disabled = false;
  }).catch((err) => {
    handleCameraError(err);
  });
}

function stopScanner() {
  document.getElementById('btn-stop').disabled = true;
  if (!scanner) {
    document.getElementById('btn-start').disabled = false;
    return;
  }
  scanner.stop()
    .catch(() => {})
    .finally(() => {
      scanner = null;
      document.getElementById('btn-start').disabled = false;
    });
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

// ── 手動入力 / ハンディスキャナー ────────────────────────

function deleteFromSession(jan) {
  scanSession.delete(jan);
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

function handleJanInput(jan) {
  jan = jan.trim();
  if (!jan) return;
  if (jan.length === 12) jan = '0' + jan;

  if (scanSession.has(jan) || inFlightJANs.has(jan)) {
    showToast('登録済み: ' + jan, 'info');
    return;
  }

  if (!db) {
    addToSession(jan, resolveProduct(jan, null));
    return;
  }

  inFlightJANs.add(jan);
  lookupJAN(db, jan)
    .then((dbProduct) => {
      inFlightJANs.delete(jan);
      addToSession(jan, resolveProduct(jan, dbProduct));
    })
    .catch((e) => {
      inFlightJANs.delete(jan);
      showToast('検索エラー: ' + e.message, 'error');
    });
}

function onScanSuccess(jan) {
  jan = jan.trim();
  if (jan.length === 12) jan = '0' + jan;

  // 重複・検索中はスキップ
  if (scanSession.has(jan) || inFlightJANs.has(jan)) {
    flashViewfinder('success');
    return;
  }

  if (!db) {
    addToSession(jan, resolveProduct(jan, null));
    flashViewfinder('success');
    return;
  }

  inFlightJANs.add(jan);

  lookupJAN(db, jan)
    .then((dbProduct) => {
      inFlightJANs.delete(jan);
      addToSession(jan, resolveProduct(jan, dbProduct));
      flashViewfinder('success');
    })
    .catch((e) => {
      inFlightJANs.delete(jan);
      showToast('検索エラー: ' + e.message, 'error');
    });
}

function flashViewfinder(type) {
  const reader = document.getElementById('reader');
  const cls = type === 'success' ? 'flash-success' : 'flash-error';
  reader.classList.add(cls);
  setTimeout(() => reader.classList.remove(cls), 300);
}

// ── UI ────────────────────────────────────────────────────

function updateScanCount() {
  document.getElementById('scan-count').textContent =
    'スキャン済: ' + scanSession.size + '件';
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
      const isLast = i === items.length - 1;
      return '<div class="result-item">'
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

  // 開閉状態を追跡（再描画後も維持するため）
  container.querySelectorAll('details').forEach((el) => {
    el.addEventListener('toggle', () => {
      if (el.open) {
        closedGroups.delete(el.dataset.key);
      } else {
        closedGroups.add(el.dataset.key);
      }
    });
  });
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

// ── 初期化 ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // IndexedDB 初期化
  openDB()
    .then((database) => {
      db = database;
      updateHeaderMeta();
      const m = loadMetadata();
      if (!m.count) {
        showToast('まずCSVを読み込んでください', 'info', 4000);
      }
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

  // デモモードボタン
  document.getElementById('btn-demo').addEventListener('click', toggleDemoMode);
  updateDemoModeUI();

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
    updateScanCount();
    renderGroupedResults();
  });

  // 個別削除ボタン（イベント委譲）
  document.getElementById('results').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-item-delete');
    if (!btn) return;
    deleteFromSession(btn.dataset.jan);
  });

  // オーバーレイ閉じるボタン
  document.getElementById('btn-dismiss-overlay').addEventListener('click', () => {
    document.getElementById('permission-overlay').classList.add('hidden');
  });

  // バックグラウンド遷移時にカメラ停止（iOS Safari対策）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && scanner) stopScanner();
  });

  // 初期表示
  updateScanCount();
  renderGroupedResults();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}

// ── テスト用エクスポート（本番ブラウザでは実行されない）─────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bulkInsert, lookupJAN, resolveProduct };
}
