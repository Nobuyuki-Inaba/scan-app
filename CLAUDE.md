# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

```bash
# テスト実行
npm test

# 単一テストファイルの実行
npx jest tests/bulkInsert.test.js

# カバレッジ付きテスト
npm run test:coverage

# ローカル配信（http://localhost:8787）
npm run dev

# iPhone から LAN 経由で確認（HTTPS。ルートの 192.168.0.13*.pem を使う）
npm run dev:lan

# Cloudflare Workers へ公開（テスト → wrangler deploy）
npm run deploy

# zxing-wasm / papaparse を node_modules から public/vendor/ へコピー
npm run vendor
```

ビルドステップはなし。`public/` の静的ファイルをそのまま Cloudflare Workers（Static Assets）で配信する。

## アーキテクチャ

**バックエンドなし・単一ページ構成。** 配信対象は `public/` だけ（`wrangler.jsonc` の `assets.directory`）。

```
public/index.html          エントリポイント
public/css/style.css       スタイル（iPhone SE2 モバイルファースト）
public/js/app.js           アプリ全ロジック（1ファイル）
public/service-worker.js   PWAキャッシュ制御
public/manifest.json       PWAマニフェスト
public/_headers            Cloudflare のレスポンスヘッダー（SW は no-cache）
public/vendor/             自己ホストのライブラリ（npm run vendor で生成してコミット）
  papaparse.min.js           CSVパース
  zxing-reader.js            zxing-wasm（IIFE、グローバル ZXingWASM）
  zxing_reader.wasm          ZXing C++ のデコーダ本体
tools/vendor.mjs           vendor/ の生成スクリプト
wrangler.jsonc             Cloudflare Workers 設定
```

CDN は使わない（オフライン起動と CDN 障害対策）。`app.js` はトップレベルでライブラリのグローバルを参照しないこと（読み込み失敗時に全機能が止まり、テストも壊れる）。

### データフロー

1. **CSV読み込み**: ファイル選択、または URL を `fetch` → Blob → `importCsv()`（バイト列 → `decodeCsvBytes()` → `parseCsvRecords()` で PapaParse・JAN 重複排除）→ `bulkInsert()` で IndexedDB に一括置換保存
2. **スキャン**: `getUserMedia` → `<video>` → 約15回/秒（`SCAN_INTERVAL`。電池対策）、スキャン枠の範囲を**映像の元解像度で** canvas に切り出し → `ZXingWASM.readBarcodes()` → 1次元バーコードは同じ値が2回連続で読めたら確定（誤読対策）→ `processCode()`
3. **照合**: `processCode()`（カメラ・手入力共通）→ `lookupJAN()` で IndexedDB をキー直引き → `scanSession` Map に追加 → カテゴリでグループ化して `renderGroupedResults()` で描画
4. **デモモード**: `demoMode` フラグが true のとき、DBのカテゴリを無視してラウンドロビン分類（A→B→C→...）を使う。`localStorage` に永続化

### JAN 正規化

CSV取り込み・カメラ・手入力のすべてで `normalizeCode()` を通し、IndexedDB のキーを揃える。

- 12桁の数字は先頭に `0` を補完して13桁にする（UPC-A / Excel で先頭0が落ちたもの）
- UPC-E は `expandUPCE()` で UPC-A に展開してから正規化
- Excel の指数表記（`4.9E+12`）は桁が失われているので取り込み時にスキップして警告
- 手入力の 8桁/13桁はチェックディジットを検証（`hasValidCheckDigit()`）

### スキャン枠の座標

`#reader` 内のスキャン枠（`guideRect()`、CSS px）を `toSourceRect()` で映像のピクセル座標に変換して切り出す。video は `object-fit: cover` 前提なので、CSS を変えるときは両方を合わせること。QR を有効にすると枠は正方形になる。

### IndexedDB スキーマ

- DB名: `scan_app_db` / バージョン: `2` / ストア名: `products`
- キーパス: `jan`（正規化済みのコード）
- レコード: `{ jan, name, category, description }`
- 起動時に `reconcileMetadata()` で実件数と `localStorage` の件数を突き合わせる（iOS のストレージ自動削除の検知）

### Service Worker キャッシュ戦略

アプリ一式（`APP_SHELL`）をバージョン付きキャッシュ `scan-app-{VERSION}` に持ち、**すべて Cache-First**。HTML と JS の版ズレを防ぐため、ナビゲーションも含めてバージョン単位で丸ごと切り替える。外部オリジン（CSV の URL 取得）には関与しない。

- index.html は `./` でキャッシュする（Cloudflare は `/index.html` を `/` へ 307 リダイレクトし、リダイレクト応答をナビゲーションに返すと Safari がエラーにするため）

**SW更新フロー**: リリースで `service-worker.js` の `VERSION` を変える → ブラウザが新しい SW を検出（前面に戻るたびに `reg.update()`）→ `install` で新キャッシュを構築して waiting → `app.js` が更新バナーを表示 → ユーザーが「更新」を押すと `SKIP_WAITING` → `activate` で旧キャッシュ削除 + `clients.claim()` → `controllerchange` で再読み込み。スキャン途中の結果が消えないよう、自動では再読み込みしない。

### テスト構成

`public/js/app.js` が `module.exports` でエクスポートする純粋関数（`bulkInsert`, `lookupJAN`, `resolveProduct`, JAN 正規化、CSV 列マッピング、フォーマット設定、スキャン枠の座標変換）が対象。IndexedDBは `fake-indexeddb` でモック。DOM・カメラ・Service Worker はテスト対象外。

### CSV フォーマット

利用者向けの仕様は README の「CSVフォーマット」が正。変えたら README も更新すること。

- ヘッダー有無を自動判定（先頭セルが数字のみならヘッダーなし → 列順 0:JAN, 1:name, 2:category, 3:description）
- 列名は `headerKey()` で正規化して `HEADER_ALIASES` と比較（大文字小文字・`_`・`-`・空白を無視。`sku_name` = `sku-name`）
- 文字コードは `decodeCsvBytes()` が UTF-8（fatal）→ 失敗なら Shift_JIS で判定
- ファイル全体を ArrayBuffer で読んで一度にデコードする。Papa に Blob を分割読みさせると、チャンク境界の多バイト文字が化けるので使わないこと

### 動作環境上の制約

- HTTPS 必須（iOS SafariのカメラAPI要件）
- `getUserMedia()` はユーザージェスチャーから同期的に呼び出す必要がある（`startScanner()` は開始ボタンのクリックから直接呼ぶ）
- iOS 版 Chrome も中身は WebKit なので Safari と同じ挙動
- プライベートブラウズでは IndexedDB が使用不可（検知してエラー表示）
- `visibilitychange` / `pagehide` でカメラを自動停止
