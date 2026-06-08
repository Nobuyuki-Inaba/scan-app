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
```

ビルドステップはなし。静的ファイルをそのままApache（HTTPS）に配置して動作する。

## アーキテクチャ

**バックエンドなし・単一ページ構成。**

```
index.html          エントリポイント。CDNスクリプト2本を読み込む
css/style.css       スタイル（iPhone SE2 モバイルファースト）
js/app.js           アプリ全ロジック（1ファイル）
service-worker.js   PWAキャッシュ制御
manifest.json       PWAマニフェスト
data/products.csv   商品マスタCSV（担当者が手動更新）
```

### データフロー

1. **CSV読み込み**: URLまたはファイル選択 → PapaParse（CDN）でストリーミングパース → `bulkInsert()` で IndexedDB に一括置換保存
2. **スキャン**: html5-qrcode（CDN）でJANバーコード読み取り → `lookupJAN()` で IndexedDB をキー直引き（O(1)） → `scanSession` Map に追加 → カテゴリでグループ化して `renderGroupedResults()` で描画
3. **デモモード**: `demoMode` フラグが true のとき、DBのカテゴリを無視してラウンドロビン分類（A→B→C→...）を使う。`localStorage` に永続化

### IndexedDB スキーマ

- DB名: `scan_app_db` / バージョン: `2` / ストア名: `products`
- キーパス: `jan`（EAN-13コード）
- レコード: `{ jan, name, category, description }`
- 12桁JANは先頭に `0` を補完してから保存・検索する

### Service Worker キャッシュ戦略

| リクエスト種別 | 戦略 |
|---|---|
| `index.html`（navigate） | Network-First（オフライン時はキャッシュにフォールバック） |
| CSS / JS アプリシェル | Cache-First |
| `products.csv` | Network-First（常に最新データ） |
| CDN外部スクリプト | Cache-First（バージョン固定） |

**SW更新フロー**: デプロイ後にブラウザが新しい `service-worker.js` を検出 → `install` でキャッシュ再構築 + `skipWaiting()` → `activate` で旧キャッシュ削除 + `clients.claim()` → `app.js` の `controllerchange` リスナーが `window.location.reload()` を実行

### テスト構成

テスト対象は `js/app.js` から `module.exports` でエクスポートされる3関数のみ：`bulkInsert`, `lookupJAN`, `resolveProduct`。IndexedDBは `fake-indexeddb` でモック。DOM・Service Worker はテスト対象外。

### CSV フォーマット

ヘッダー有無を自動判定（先頭セルが数字のみならヘッダーなし）。ヘッダーあり列名: `JAN`, `sku-name`, `category`, `description`。ヘッダーなし時は列順（0:JAN, 1:name, 2:category, 3:description）で読む。

### 動作環境上の制約

- HTTPS 必須（iOS SafariのカメラAPI要件）
- `getUserMedia()` はユーザージェスチャーから同期的に呼び出す必要がある
- プライベートブラウズでは IndexedDB が使用不可（検知してエラー表示）
- `visibilitychange` でバックグラウンド遷移時にカメラを自動停止
