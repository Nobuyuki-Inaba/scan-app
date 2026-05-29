'use strict';

// ── 設定 ──────────────────────────────────────────────────
// サーバー上のCSVパス（Apacheの同一オリジン）
const CSV_URL = './data/products.csv';

const DB_NAME    = 'scan_app_db';
const DB_VERSION = 1;
const STORE_NAME = 'products';

// ── 状態 ──────────────────────────────────────────────────
let db      = null;
let scanner = null; // html5-qrcode インスタンス（連続スキャンモード用）

const scanSession  = new Map(); // jan → { jan, rack, shelf, remarks }
const closedGroups = new Set(); // ユーザーが明示的に閉じたグループ名
const inFlightJANs = new Set(); // DB検索中のJAN（二重登録防止）
let toastTimer = null;

// ── IndexedDB ─────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'jan' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// 50K件一括挿入: 単一トランザクション内で全put()を同期発火（await挟まない）
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

// ── CSV同期 ───────────────────────────────────────────────

function syncFromServer() {
  if (!db) { showToast('DBが準備できていません', 'error'); return; }

  const btnSync = document.getElementById('btn-sync');
  btnSync.disabled = true;
  showToast('サーバーから取得中...', 'info', 99999);

  fetch(CSV_URL, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    })
    .then((text) => {
      const records = [];

      Papa.parse(text, {
        header: true,
        encoding: 'UTF-8',
        skipEmptyLines: true,
        step: (result) => {
          const row = result.data;
          // ヘッダー名の表記ゆれ・BOM付きに対応
          const jan = ((row['JAN'] || row['jan'] || row['﻿JAN'] || '')).toString().trim();
          if (!jan) return;
          records.push({
            jan,
            rack:    (row['ラック'] || '').trim(),
            shelf:   (row['棚番号'] || '').trim(),
            remarks: (row['備考']   || '').trim()
          });
          if (records.length % 5000 === 0) {
            showToast(records.length.toLocaleString() + '件処理中...', 'info', 99999);
          }
        },
        complete: () => {
          if (records.length === 0) {
            showToast('CSVにデータがありません', 'error');
            btnSync.disabled = false;
            return;
          }
          bulkInsert(db, records)
            .then((count) => {
              saveMetadata(count);
              updateHeaderMeta();
              showToast(count.toLocaleString() + '件の同期完了', 'success');
              btnSync.disabled = false;
            })
            .catch((e) => {
              showToast('DB書き込みエラー: ' + e.message, 'error');
              btnSync.disabled = false;
            });
        },
        error: (err) => {
          showToast('CSVパースエラー: ' + err.message, 'error');
          btnSync.disabled = false;
        }
      });
    })
    .catch((e) => {
      showToast('接続エラー: ' + e.message, 'error');
      btnSync.disabled = false;
    });
}

// ── 写真撮影スキャン（[📷] ボタン → ネイティブカメラ → BarcodeDetector）────
// input[type=file capture=environment] でネイティブカメラを開く
// Android Chrome: リアカメラが直接起動、撮影後に高解像度画像が返ってくる
// デスクトップ Chrome: ファイル選択ダイアログ（写真ファイルを選択）

function initPhotoScanner() {
  const btnCapture = document.getElementById('btn-capture');
  const photoInput = document.getElementById('photo-input');

  // BarcodeDetector 対応ならネイティブ検出、非対応なら html5-qrcode の scanFile() で検出
  const useNativeDetector = typeof BarcodeDetector !== 'undefined';
  const detector = useNativeDetector
    ? new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39'] })
    : null;

  btnCapture.addEventListener('click', () => { photoInput.click(); });

  photoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    btnCapture.disabled = true;
    btnCapture.textContent = '解析中...';

    const done = () => {
      btnCapture.disabled = false;
      btnCapture.textContent = '📷 写真を撮ってスキャン';
      photoInput.value = '';
    };

    if (useNativeDetector) {
      // BarcodeDetector（Android Chrome など）
      createImageBitmap(file)
        .then((bitmap) => detector.detect(bitmap).then((barcodes) => {
          bitmap.close();
          if (barcodes.length === 0) {
            // BarcodeDetector で読めなければ Quagga で再試行
            decodeWithQuagga(file, done);
          } else {
            for (const b of barcodes) onScanSuccess(b.rawValue);
            done();
          }
        }))
        .catch(() => decodeWithQuagga(file, done));
    } else {
      // Quagga（Windows Chrome / iOS Safari など）
      decodeWithQuagga(file, done);
    }
  });
}

// ── Quagga デコード（ブレ・低解像度に強いEAN-13向け）─────────

function decodeWithQuagga(file, done) {
  const src = URL.createObjectURL(file);
  Quagga.decodeSingle(
    {
      decoder: {
        readers: ['ean_reader', 'ean_8_reader', 'code_128_reader'],
        multiple: false
      },
      locate: true,       // バーコードを自動検出（画面全体から探す）
      inputStream: { size: 1920 }, // 処理解像度を最大化
      src: src
    },
    (result) => {
      URL.revokeObjectURL(src);
      if (result && result.codeResult && result.codeResult.code) {
        onScanSuccess(result.codeResult.code);
        done();
      } else {
        showToast('読み取れません。バーコードをまっすぐ正面から撮影してください', 'error');
        done();
      }
    }
  );
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
    { fps: 10, qrbox: { width: 280, height: 180 } },
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

// ── 手動入力 / ハンディスキャナー ────────────────────────

function handleJanInput(jan) {
  jan = jan.trim();
  if (!jan) return;

  if (!db) {
    showToast('DBが初期化されていません', 'error');
    return;
  }

  if (scanSession.has(jan) || inFlightJANs.has(jan)) {
    showToast('登録済み: ' + jan, 'info');
    return;
  }

  inFlightJANs.add(jan);
  lookupJAN(db, jan)
    .then((product) => {
      inFlightJANs.delete(jan);
      if (!product) {
        showToast('データなし: ' + jan, 'error');
        return;
      }
      scanSession.set(jan, product);
      updateScanCount();
      renderGroupedResults();
      showToast(jan + ' を追加', 'success');
      if (navigator.vibrate) navigator.vibrate(40);
    })
    .catch((e) => {
      inFlightJANs.delete(jan);
      showToast('検索エラー: ' + e.message, 'error');
    });
}

function onScanSuccess(jan) {
  jan = jan.trim();

  // 重複・検索中はスキップ
  if (scanSession.has(jan) || inFlightJANs.has(jan)) {
    flashViewfinder('success');
    return;
  }

  if (!db) {
    showToast('DBが初期化されていません', 'error');
    return;
  }

  inFlightJANs.add(jan);

  lookupJAN(db, jan)
    .then((product) => {
      inFlightJANs.delete(jan);

      if (!product) {
        flashViewfinder('error');
        showToast('データなし: ' + jan, 'error');
        return;
      }

      scanSession.set(jan, product);
      updateScanCount();
      renderGroupedResults();
      flashViewfinder('success');
      if (navigator.vibrate) navigator.vibrate(40);
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

  // 備考でグループ化
  const groups = new Map();
  for (const [jan, product] of scanSession) {
    const key = product.remarks || '（備考なし）';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ jan, rack: product.rack, shelf: product.shelf });
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
        +   '<div class="item-location">ラック: ' + escapeHTML(p.rack)
        +     '&nbsp;&nbsp;棚: ' + escapeHTML(p.shelf) + '</div>'
        + '</div>'
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

let toastClearTimer = null;

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
        showToast('まずデータを同期してください', 'info', 4000);
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

  // 同期ボタン
  document.getElementById('btn-sync').addEventListener('click', () => {
    syncFromServer();
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

  // CLRボタン
  document.getElementById('btn-clear').addEventListener('click', () => {
    scanSession.clear();
    closedGroups.clear();
    inFlightJANs.clear();
    updateScanCount();
    renderGroupedResults();
  });

  // オーバーレイ閉じるボタン
  document.getElementById('btn-dismiss-overlay').addEventListener('click', () => {
    document.getElementById('permission-overlay').classList.add('hidden');
  });

  // バックグラウンド遷移時にカメラ停止（iOS Safari対策）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && scanner) stopScanner();
  });

  // 写真撮影スキャン初期化（BarcodeDetector対応ブラウザのみ有効）
  initPhotoScanner();

  // 初期表示
  updateScanCount();
  renderGroupedResults();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}
